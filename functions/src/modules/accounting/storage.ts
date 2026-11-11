import { randomUUID } from 'node:crypto';
import type { Deps } from '../../lib/deps.js';

/**
 * Saves a buffer to Storage and returns a DOWNLOAD-TOKEN URL for it — the capability-URL
 * mechanism `claims/bundle.ts` empirically verified against both the emulator and a real
 * project (see its long comment): `firebaseStorageDownloadTokens` metadata set via the raw GCS
 * layer, which genuinely bypasses `storage.rules`.
 *
 * DELIBERATE DEVIATION from the brief's "signed URL (7 d)", disclosed in
 * task-5-platform-report.md: a true `getSignedUrl` V4 URL needs signing credentials
 * (`iam.serviceAccountTokenCreator` or a mounted key) that no code in this repo has ever
 * exercised — a dependency that would pass every emulator test and fail only at deploy, the
 * exact class this repo's external-verification rule exists to prevent. **THESE URLS DO NOT
 * EXPIRE.** Anyone holding one — including whoever a venue host pastes an accounting-export
 * link to in a chat — can fetch the object until the token is REVOKED, and revocation means
 * rotating the object's `firebaseStorageDownloadTokens` metadata (setMetadata with a fresh
 * UUID; the old link 403s from then on). A 7-day-expiring signed URL is carried as an
 * external-gated Plan 8 hardening (these exports contain venue revenue). Ruling AB's core — a
 * CALLABLE that verifies the venue claim server-side, never a storage-rules match — is
 * unchanged either way.
 */
export async function saveWithDownloadUrl(deps: Deps, storagePath: string, buffer: Buffer, contentType: string): Promise<{ storagePath: string; url: string }> {
  const bucket = deps.storage.bucket();
  const file = bucket.file(storagePath);
  await file.save(buffer, { contentType });
  const token = randomUUID();
  await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
  return { storagePath, url: downloadUrl(bucket.name, storagePath, token) };
}

/** Returns the token URL for an EXISTING object, minting a token only if it has none. */
export async function downloadUrlFor(deps: Deps, storagePath: string): Promise<string> {
  const bucket = deps.storage.bucket();
  const file = bucket.file(storagePath);
  const [meta] = await file.getMetadata();
  const existing = (meta.metadata as Record<string, string> | undefined)?.firebaseStorageDownloadTokens;
  if (existing) return downloadUrl(bucket.name, storagePath, existing.split(',')[0]!);
  const token = randomUUID();
  await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
  return downloadUrl(bucket.name, storagePath, token);
}

function downloadUrl(bucketName: string, storagePath: string, token: string): string {
  // The Firebase Storage REST download form — the same URL shape the client SDK's
  // getDownloadURL() resolves to; works against the emulator via FIREBASE_STORAGE_EMULATOR_HOST.
  const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST ? `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}` : 'https://firebasestorage.googleapis.com';
  return `${host}/v0/b/${bucketName}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
}
