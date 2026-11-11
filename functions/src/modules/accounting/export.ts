import { ZipArchive } from 'archiver';
import type { CallableParsedInput, CallableOutput, Operator } from '@goldstar/platform';
import { defineCallable, requireActiveOperator, requireOperator, type Caller } from '../../lib/callable.js';
import type { Deps } from '../../lib/deps.js';
import { err } from '../../lib/errors.js';
import { P } from '../../lib/paths.js';
import { audit } from '../../lib/audit.js';
import * as registry from './registry.js';
import { saveWithDownloadUrl } from './storage.js';

/**
 * `accountingExport` (Plan 7 Task 5): writes the period's CSVs via the provider, zips them, and
 * returns ONE download URL (the contract's single `downloadPath`). Role gate mirrors
 * `integrationsHealthCheck`/`auditQuery`'s inspect shape — owner/admin/platform_admin, with an
 * assumed platform_admin exempt from the active-operator gate (exporting a suspended operator's
 * books is a legitimate inspection). The zip lands at `operators/{op}/exports/export-{period}.zip`
 * (single segment — the storage.rules admin-read match covers it) and the returned URL is a
 * download-token capability URL (see storage.ts for the signed-URL deviation note).
 */
export async function accountingExportHandler(
  deps: Deps,
  caller: Caller | null,
  input: CallableParsedInput<'accountingExport'>,
): Promise<CallableOutput<'accountingExport'>> {
  const c = requireOperator(caller);
  if (!c.roles.some((r) => ['owner', 'admin', 'platform_admin'].includes(r))) throw err('permission_denied');
  if (!c.roles.includes('platform_admin')) await requireActiveOperator(deps, c.operatorId);

  const op = (await deps.db.doc(P.operator(c.operatorId)).get()).data() as Operator | undefined;
  if (!op) throw err('not_found', 'operator');
  const provider = await registry.getAccounting(deps, op);
  const { files } = await provider.exportPeriod({ operatorId: c.operatorId, period: input.period });

  const bucket = deps.storage.bucket();
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve);
    archive.on('error', reject);
  });
  for (const f of files) {
    const [buf] = await bucket.file(f.storagePath).download();
    archive.append(buf, { name: f.name });
  }
  await archive.finalize();
  await done;
  const zipPath = `operators/${c.operatorId}/exports/export-${input.period}.zip`;
  const { url } = await saveWithDownloadUrl(deps, zipPath, Buffer.concat(chunks), 'application/zip');

  await audit(deps, { operatorId: c.operatorId, actorUid: c.uid, action: 'accounting.export', target: input.period, after: { files: files.map((f) => f.name), zipPath } });
  return { downloadPath: url };
}

export const accountingExport = defineCallable('accountingExport', {}, accountingExportHandler);
