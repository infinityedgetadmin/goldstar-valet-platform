import { err } from '../../lib/errors.js';
import type { PosCheck, PosProvider } from './port.js';

const BASE = 'https://ws-api.toasttab.com';
const TIMEOUT_MS = 10_000;
/** Refresh the cached token 5 minutes before Toast's stated expiry. */
const TOKEN_SAFETY_MS = 5 * 60_000;
/** Ruling J's cache requirement: per-venue day-orders cache TTL. Short — a host lookup right
 * after a check opens should still find it on the next fetch — but long enough that one host
 * typing three table numbers doesn't page the whole day three times. */
const ORDERS_CACHE_TTL_MS = 60_000;
const PAGE_SIZE = 100; // ordersBulk maximum
const LOOKBACK_MS = 24 * 3600_000;

/**
 * MONEY BOUNDARY: Toast amounts are DECIMAL DOLLARS (`"amount": 12.5`,
 * `"discountAmount": 2.0` — confirmed via Context7, doc.toasttab.com order/discount examples),
 * while this entire codebase is INTEGER CENTS. These two helpers are the only crossing point;
 * nothing else in the adapter may do arithmetic on a dollar value.
 */
function centsToDollars(cents: number): number {
  return Number((cents / 100).toFixed(2));
}
function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

// Confirmed via Context7 (doc.toasttab.com/doc/devguide — authentication login): the token is
// NESTED — `{ token: { tokenType, scope, expiresIn: 86400, accessToken }, status }`. Reading a
// flat `access_token` (the original plan text) yields undefined.
interface LoginResponse {
  token: { tokenType: string; scope?: string; expiresIn: number; accessToken: string };
  status: string;
}

// Confirmed via Context7 (doc.toasttab.com/doc/devguide/apiOrdersGetDetailedInfoAboutMultipleOrders):
// /orders/v2/ordersBulk returns an ARRAY OF FULL ORDER BODIES (unlike the deprecated /orders/v2/orders,
// which returns bare GUID strings). Only the fields this adapter reads are typed.
interface ToastCheck {
  guid: string;
  displayNumber?: string | null;
  tabName?: string | null;
  voided?: boolean;
  closedDate?: string | null;
  paymentStatus?: string;
  /** Decimal dollars. */
  totalAmount?: number;
  openedDate?: string;
}
interface ToastOrder {
  guid: string;
  voided?: boolean;
  /** Only a GUID reference — the order body carries NO table NAME (see findCheck's comment). */
  table?: { guid: string } | null;
  checks?: ToastCheck[];
}

interface CachedOrders {
  at: number;
  orders: ToastOrder[];
}

/** Module-level per-restaurant cache — survives across handler invocations on a warm instance,
 * which is exactly the scope Ruling J's requirement targets (repeat lookups from one host). */
const ordersCache = new Map<string, CachedOrders>();

/** Test-only reset. */
export function __clearToastOrdersCache(): void {
  ordersCache.clear();
}

/** T3 review L2: MODULE-level, keyed by clientId — the registry constructs a NEW ToastPos per
 * invocation, so an instance field never survived a single request and production re-logged-in
 * on every call while the test pinned a "caches for 86400s" property only a long-lived instance
 * could exhibit. Same scope reasoning as `ordersCache` above; keyed by clientId (not restaurant)
 * because the token belongs to the credential pair, and distinct operators have distinct pairs. */
const tokenCache = new Map<string, { accessToken: string; expiresAtMs: number }>();

/** Test-only reset. */
export function __clearToastTokenCache(): void {
  tokenCache.clear();
}

export interface ToastConfig {
  clientId: string;
  clientSecret: string;
  restaurantGuid: string;
}

/**
 * Toast POS adapter (Plan 7 Task 3, Ruling J: "Toast proceeds with your corrections").
 *
 * Verified against doc.toasttab.com via Context7 at implementation time (fixtures under
 * `functions/test/fixtures/toast/`):
 * - auth: POST /authentication/v1/authentication/login with the THIRD required body field
 *   `userAccessType: "TOAST_MACHINE_CLIENT"`; nested token response; expiresIn 86400.
 * - restaurant scoping: the `Toast-Restaurant-External-ID` HEADER, not a query param.
 * - orders: GET /orders/v2/ordersBulk?startDate&endDate&pageSize&page (the plan's
 *   /orders/v2/orders is deprecated and returns bare GUID strings).
 * - add-selection: POST /orders/v2/orders/{orderGuid}/checks/{checkGuid}/selections with
 *   `itemGroup.guid` alongside `item.guid`.
 *
 * ⚠️ UNVERIFIED (Ruling Y) — `applyValidation`'s live call. Everything Context7 returns shows
 * `appliedDiscounts` as an EMBEDDED property applied within an order submission
 * (`{ discount: { guid }, discountAmount }` — that shape IS confirmed); whether a POST/PATCH on
 * an EXISTING check accepts it at the path used below is NOT confirmed by any doc example.
 * Built against the documented shape, exercised only through the port's mock in tests, listed on
 * the external gates, and — per Ruling Y — NO FIXTURE is recorded for it: a fixture is a frozen
 * assertion, and freezing an unverified contract makes a green suite actively misleading.
 *
 * CONFIGURATION CONSTRAINTS (operator-facing setup docs, not just here):
 * - `venue.pos.validationDiscountGuid` MUST reference an OPEN-AMOUNT (variable) discount. Toast
 *   carries the validation value as `discountAmount`, which a fixed-value discount IGNORES — a
 *   fixed one silently applies its own amount and every partial validation is wrong by a
 *   venue-configured constant, with no error surfaced anywhere.
 * - `venue.pos.valetItemGuid` should reference an OPEN-PRICED menu item for the same reason:
 *   the valet charge's amount is passed as the selection `price`, which a fixed-price item
 *   prices from the menu instead.
 */
export class ToastPos implements PosProvider {
  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly config: ToastConfig,
    private readonly guids: { validationDiscountGuid?: string | undefined; valetItemGuid?: string | undefined; valetItemGroupGuid?: string | undefined },
    private readonly now: () => number = Date.now,
  ) {}

  /** `{orderGuid}:{checkGuid}` — adapter-private layout (Ruling X convention); reject unminted refs. */
  private mintCheckRef(orderGuid: string, checkGuid: string): string {
    return `${orderGuid}:${checkGuid}`;
  }
  private parseCheckRef(checkRef: string): { orderGuid: string; checkGuid: string } {
    const m = /^([0-9a-f-]{36}):([0-9a-f-]{36})$/.exec(checkRef);
    if (!m) throw err('invalid_argument', 'unrecognized checkRef');
    return { orderGuid: m[1]!, checkGuid: m[2]! };
  }

  private async login(): Promise<string> {
    const cached = tokenCache.get(this.config.clientId);
    if (cached && cached.expiresAtMs > this.now()) return cached.accessToken;
    const res = await this.request<LoginResponse>('POST', '/authentication/v1/authentication/login', {
      body: { clientId: this.config.clientId, clientSecret: this.config.clientSecret, userAccessType: 'TOAST_MACHINE_CLIENT' },
      auth: false,
    });
    tokenCache.set(this.config.clientId, { accessToken: res.token.accessToken, expiresAtMs: this.now() + res.token.expiresIn * 1000 - TOKEN_SAFETY_MS });
    return res.token.accessToken;
  }

  private async request<T>(method: string, path: string, opts: { body?: unknown; auth?: boolean; query?: Record<string, string> } = {}): Promise<T> {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.auth !== false) {
      headers.Authorization = `Bearer ${await this.login()}`;
      headers['Toast-Restaurant-External-ID'] = this.config.restaurantGuid;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);
    try {
      const res = await this.fetchFn(url.toString(), {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Status only — a Toast error body may embed check/guest details; never forward it.
        throw err('provider_unavailable', `toast ${res.status}`);
      }
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw err('provider_unavailable', 'toast timeout');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ruling J: page the window ONCE per venue per TTL, not per lookup. */
  private async dayOrders(): Promise<ToastOrder[]> {
    const cached = ordersCache.get(this.config.restaurantGuid);
    if (cached && this.now() - cached.at < ORDERS_CACHE_TTL_MS) return cached.orders;
    const endDate = new Date(this.now()).toISOString();
    const startDate = new Date(this.now() - LOOKBACK_MS).toISOString();
    const orders: ToastOrder[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.request<ToastOrder[]>('GET', '/orders/v2/ordersBulk', {
        query: { startDate, endDate, pageSize: String(PAGE_SIZE), page: String(page) },
      });
      orders.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    ordersCache.set(this.config.restaurantGuid, { at: this.now(), orders });
    return orders;
  }

  /**
   * There is NO table filter and NO open-checks filter server-side (corrected contract) — and the
   * order body's `table` is a bare GUID reference with no name, so true table-NUMBER matching
   * would need the restaurant-config tables endpoint (not in this task's verified set). What a
   * host types is matched client-side against the two human-readable fields the order body DOES
   * carry: `check.tabName` and `check.displayNumber`, case-insensitively. Open = not voided, no
   * `closedDate`, paymentStatus not CLOSED.
   */
  async findCheck(i: { table?: string | undefined; checkRef?: string | undefined }): Promise<{ checks: PosCheck[] }> {
    const wanted = i.checkRef !== undefined ? this.parseCheckRef(i.checkRef) : undefined;
    const needle = i.table?.trim().toLowerCase();
    const orders = await this.dayOrders();
    const out: PosCheck[] = [];
    for (const order of orders) {
      if (order.voided) continue;
      for (const check of order.checks ?? []) {
        if (check.voided || check.closedDate || check.paymentStatus === 'CLOSED') continue;
        if (wanted && (order.guid !== wanted.orderGuid || check.guid !== wanted.checkGuid)) continue;
        if (needle !== undefined) {
          const tab = check.tabName?.trim().toLowerCase();
          const display = check.displayNumber?.trim().toLowerCase();
          if (tab !== needle && display !== needle) continue;
        }
        out.push({
          checkRef: this.mintCheckRef(order.guid, check.guid),
          ...(check.tabName ? { table: check.tabName } : check.displayNumber ? { table: check.displayNumber } : {}),
          total: dollarsToCents(check.totalAmount ?? 0),
          openedAt: check.openedDate ?? new Date(this.now()).toISOString(),
        });
      }
    }
    return { checks: out };
  }

  /**
   * ⚠️ UNVERIFIED LIVE PATH (Ruling Y) — see the class doc comment. The PAYLOAD shape
   * (`{ discount: { guid }, discountAmount }`) is the documented open-amount form; the
   * POST-to-an-existing-check ROUTE below is the unconfirmed half. No fixture exists for this
   * call, deliberately. External gate: confirm against a Toast sandbox before first live use.
   */
  async applyValidation(i: { checkRef: string; amount: number; reason: string }): Promise<{ ok: true }> {
    if (!this.guids.validationDiscountGuid) throw err('failed_precondition', 'validation discount not configured');
    const { orderGuid, checkGuid } = this.parseCheckRef(i.checkRef);
    await this.request('POST', `/orders/v2/orders/${orderGuid}/checks/${checkGuid}/appliedDiscounts`, {
      body: [
        {
          discount: { guid: this.guids.validationDiscountGuid },
          discountAmount: centsToDollars(i.amount),
          ...(i.reason ? { comment: i.reason } : {}),
        },
      ],
    });
    return { ok: true };
  }

  async addCharge(i: { checkRef: string; item: { name: string; amount: number } }): Promise<{ ok: true }> {
    if (!this.guids.valetItemGuid || !this.guids.valetItemGroupGuid) throw err('failed_precondition', 'valet item not configured');
    const { orderGuid, checkGuid } = this.parseCheckRef(i.checkRef);
    await this.request('POST', `/orders/v2/orders/${orderGuid}/checks/${checkGuid}/selections`, {
      body: [
        {
          entityType: 'MenuItemSelection',
          itemGroup: { guid: this.guids.valetItemGroupGuid },
          item: { guid: this.guids.valetItemGuid },
          quantity: 1,
          // Open-priced item required for this to stick — see the class doc's config constraints.
          price: centsToDollars(i.item.amount),
        },
      ],
    });
    return { ok: true };
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      // Deliberately BYPASSES the L2 module-level token cache: served from cache, this probe
      // would report ok for up to ~24h after credentials were revoked. A health check's whole
      // job is the live round-trip; the fresh login it forces re-fills the cache on success.
      tokenCache.delete(this.config.clientId);
      await this.login();
      return { ok: true };
    } catch {
      // Name-only discipline: no raw provider error text leaves the adapter.
      return { ok: false, message: 'toast authentication failed' };
    }
  }
}
