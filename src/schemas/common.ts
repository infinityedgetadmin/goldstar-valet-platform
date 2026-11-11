import { z } from 'zod';
import { isUuid } from '../ids';
export const moneySchema = z.number().int().nonnegative();
export const currencySchema = z.string().length(3).regex(/^[A-Z]{3}$/);
export const isoDateSchema = z.string().datetime({ offset: false });
export const dayStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const e164Schema = z.string().regex(/^\+[1-9]\d{6,14}$/);
export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const uuidSchema = z.string().refine(isUuid, 'must be a UUID');
export const geoSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
export const addressSchema = z.object({ line1: z.string().min(1), line2: z.string().optional(), city: z.string().min(1), region: z.string().min(1), postalCode: z.string().min(1), country: z.string().length(2) });
export const storagePathSchema = z.string().min(1).regex(/^[a-zA-Z0-9_\-./]+$/);
/** 22-char base64url token, e.g. from `secretToken()`. Used for guest ticket tokens, job tokens, and callable `token` inputs. */
export const secretTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const timestampsSchema = z.object({ createdAt: isoDateSchema, updatedAt: isoDateSchema });
/**
 * An OPAQUE, provider-minted POS check token. Clients round-trip it from `posFindCheck`'s output
 * into `posApplyValidation`/`posAddValetCharge` and never construct or parse it.
 *
 * Deliberately a string, not an `{ orderGuid, checkGuid }` object, even though the Toast adapter
 * encodes exactly that pair (its add-selection path is
 * `POST /orders/{orderGuid}/checks/{checkGuid}/selections`, which needs both): modelling the pair
 * in the contract would put ONE vendor's data model into a provider-agnostic callable, break both
 * pinned consumers for no gain, and force a future Square/Lightspeed adapter to fabricate an
 * `orderGuid` it does not have. Adapters MUST reject a `checkRef` they did not mint.
 */
export const posCheckRefSchema = z.string().min(1).max(200);
