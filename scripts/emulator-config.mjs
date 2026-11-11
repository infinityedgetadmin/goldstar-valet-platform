#!/usr/bin/env node
/**
 * Emulator port isolation wrapper (infra task, task-platform-report.md).
 *
 * PROBLEM: `firebase.json`'s `emulators` block hardcodes every port. The Firebase CLI does not
 * read env vars for `firebase.json` itself — there is no way to point `firebase emulators:exec`/
 * `emulators:start` at a different port set without a different CONFIG FILE. That forced every
 * emulator-backed gate (`test:functions`, `test:rules`, `seed:emulator`, the interactive
 * `emulators`) in this project to be serialized project-wide, one agent at a time — the dominant
 * remaining wall-clock cost after Plan 4b.
 *
 * FIX: read the real `firebase.json`, add `GOLDSTAR_EMU_OFFSET` (an integer, default 0) to every
 * emulator's port, write a FULL copy (not just the `emulators` block — `firestore`/`storage`/
 * `functions` stay intact) to a temp file IN THE REPO ROOT (not `os.tmpdir()` — see below), and
 * exec `firebase emulators:<subcommand> --config <temp file>` with matching `*_EMULATOR_HOST` /
 * `GOLDSTAR_EMU_*_PORT` env vars exported for the inner command to pick up. Deleted in a `finally`
 * block regardless of how the child process exits.
 *
 * WHY THE TEMP FILE LIVES IN THE REPO ROOT, NOT `os.tmpdir()`: verified directly against the
 * INSTALLED `firebase-tools` package's own source (v15.5.1,
 * `node_modules/firebase-tools/lib/detectProjectRoot.js`), not memory or docs — `--config <path>`
 * makes firebase-tools treat `dirname(resolve(cwd, path))` as the PROJECT ROOT for resolving
 * every OTHER relative path in the config (`firestore.rules`, `storage.rules`, `functions.source`,
 * etc. — see `node_modules/firebase-tools/lib/config.js`'s constructor, `this.projectDir =
 * options.projectDir || detectProjectRoot(options)`). A temp file in `/tmp` would silently break
 * every one of those relative paths. Writing the temp config next to the real `firebase.json`
 * keeps `projectDir` correct with zero other changes needed. `--config <path>` itself is
 * confirmed as a genuine global CLI flag (`node_modules/firebase-tools/lib/index.js`:
 * `program.option("-c, --config <path>", ...)`), applicable to every command including
 * `emulators:exec`/`emulators:start`.
 *
 * PER-OFFSET PROJECT ID (Plan 8 carry #70, Ruling BZ): the paragraph this replaces claimed two
 * differently-offset runs could not conflict "since they never share a port". They share
 * something else. firebase-tools' emulator HUB LOCATOR is per-PROJECT and machine-wide:
 * `os.tmpdir()/hub-${projectId}.json`, written on every instance start and DELETED ON ANY
 * INSTANCE'S STOP (verified in the installed package, `lib/emulator/hub.js`). It has no port or
 * offset component. So with every run passing `--project demo-goldstar`, offsets isolated the
 * PORTS while every concurrent gate shared ONE locator file, and any agent finishing a run pulled
 * it out from under every other agent mid-suite — "An unexpected error has occurred" followed by
 * hundreds of `fetch failed`, and orphaned JVMs. This bit four agents in one afternoon and was
 * misdiagnosed as CPU starvation first. The fix is to give each offset its own project id:
 * `demo-goldstar` at offset 0 (unchanged, so the manual `functions` `serve` script and the mobile
 * dev config still match) and `demo-goldstar-<offset>` otherwise. The `demo-` prefix is what
 * tells the emulators this is a fake project needing no credentials, so it must be kept.
 *
 * THIS IS THE ONLY PLACE THE ID IS DERIVED. It is exported to the child as
 * `GOLDSTAR_EMU_PROJECT_ID` (and as `GCLOUD_PROJECT`, which the Admin SDK reads); every consumer
 * — `functions/test/setup.ts`, `functions/test/helpers.ts`'s wipe URLs, `test/rules/setup.ts`,
 * `scripts/seed-emulator.ts`, and the transportation repo's `scripts/e2e.mjs`/`playwright.config.ts`/
 * `e2e/fixtures/seed.ts` — reads that env var with `demo-goldstar` as the offset-0 fallback and
 * never derives the id itself. Setting an offset therefore cannot leave the id behind.
 *
 * USAGE (see package.json's `emulators`/`test:functions`/`test:rules`/`seed:emulator` scripts):
 *   node scripts/emulator-config.mjs exec --only firestore,auth,storage "npm --prefix functions run test"
 *   node scripts/emulator-config.mjs start --import=./.emulator-data --export-on-exit
 * Every argument after the subcommand (`exec`/`start`) is forwarded to `firebase emulators:<subcommand>`
 * verbatim, with `--project demo-goldstar --config <temp path>` injected ahead of it.
 *
 * DATA DIRECTORIES (carry #42, Plan 8 Task 16): the interactive `emulators` script's
 * `--import=./.emulator-data --export-on-exit` is rewritten to `./.emulator-data-<offset>` for any
 * non-zero offset (scripts/emulator-data-dir.mjs), so two interactive sessions at different
 * offsets keep separate data. Offset 0 keeps the plain directory.
 *
 * NODE'S "BAD PORT" LIST (found the hard way while building this — see task-platform-report.md's
 * concurrency section): Node's native `fetch()` (undici) implements the WHATWG Fetch spec's
 * "forbidden port" check and refuses to CONNECT to roughly 70 specific ports outright (10080,
 * 6000, etc.) — a real, non-obvious way for an arbitrary `GOLDSTAR_EMU_OFFSET` to produce a
 * cryptic `TypeError: fetch failed` / `Error: bad port` several layers deep inside
 * `@firebase/rules-unit-testing`'s own `fetch()` calls, with no indication the PORT NUMBER itself
 * is the problem. `BAD_PORTS` below is copied verbatim from the INSTALLED `undici` package's own
 * source (`node_modules/undici/lib/web/fetch/constants.js`, not memory) — the same list this
 * Node version's built-in `fetch` enforces — so a colliding offset fails FAST with a clear message
 * naming the exact port and env var, instead of a multi-frame stack trace pointing at the wrong
 * layer entirely.
 */

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { rewriteDataDirArgs } from './emulator-data-dir.mjs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Verbatim copy of undici's `badPorts` (node_modules/undici/lib/web/fetch/constants.js) — the
// WHATWG Fetch spec's forbidden-port list Node's own `fetch()` enforces.
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const [subcommand, ...rest] = process.argv.slice(2);
if (subcommand !== 'exec' && subcommand !== 'start') {
  console.error('Usage: node scripts/emulator-config.mjs <exec|start> [firebase emulators:<subcommand> args...]');
  process.exit(1);
}

const offsetRaw = process.env.GOLDSTAR_EMU_OFFSET ?? '0';
const offset = Number(offsetRaw);
if (!Number.isInteger(offset)) {
  console.error(`GOLDSTAR_EMU_OFFSET must be an integer, got: ${JSON.stringify(offsetRaw)}`);
  process.exit(1);
}

const realConfigPath = join(repoRoot, 'firebase.json');
const config = JSON.parse(readFileSync(realConfigPath, 'utf8'));

// The `hub` and `logging` meta-emulators run for EVERY `emulators:exec`/`emulators:start`
// invocation regardless of `--only`, but aren't declared in this repo's `emulators` block —
// firebase-tools' own default behavior for both (`FIND_AVAILBLE_PORT_BY_DEFAULT`,
// node_modules/firebase-tools/lib/emulator/constants.js) is to auto-search for a free port when
// unconfigured, which is fine for ONE run but genuinely racy under TWO concurrent ones: found the
// hard way — two concurrent offset runs (100 and 300, neither colliding on any OTHER port) both
// failed with "Could not start Firestore Emulator, port taken" until `hub` got an explicit,
// offset-derived port here too (both processes independently probing for "a free port near 4400"
// at nearly the same instant is a genuine TOCTOU race, not a real conflict on any port either one
// actually needed). Declaring both explicitly — using firebase-tools' own DEFAULT_PORTS (4400,
// 4500) as the base to offset from, verified against that same constants.js file rather than
// assumed — removes the race entirely: every concurrent run gets its own deterministic port.
if (!config.emulators) config.emulators = {};
if (!config.emulators.hub) config.emulators.hub = { port: 4400 };
if (!config.emulators.logging) config.emulators.logging = { port: 4500 };

// Offset every emulator with a numeric `.port` (firestore, auth, functions, storage, pubsub,
// hosting, ui — generic on purpose, not a hardcoded list: a future emulator added to firebase.json
// is offset automatically with no change needed here). `singleProjectMode` (a bare boolean, no
// `.port`) is left untouched by the `typeof entry === 'object'` guard.
const emulators = config.emulators ?? {};
const badPortHits = [];
/** emulator name -> its PRE-offset port, so the bind check below can show `8080 + 250 = 8330`. */
const basePorts = {};
for (const key of Object.keys(emulators)) {
  const entry = emulators[key];
  if (entry && typeof entry === 'object' && typeof entry.port === 'number') {
    const newPort = entry.port + offset;
    if (BAD_PORTS.has(newPort)) badPortHits.push(`${key}: ${entry.port} + ${offset} = ${newPort}`);
    basePorts[key] = entry.port;
    emulators[key] = { ...entry, port: newPort };
  }
}
if (badPortHits.length > 0) {
  console.error(
    `GOLDSTAR_EMU_OFFSET=${offset} would put these emulator(s) on a port Node's fetch() refuses to connect to ` +
      `(the WHATWG "bad port" list undici enforces):\n  ${badPortHits.join('\n  ')}\nChoose a different offset.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// PRE-FLIGHT BIND CHECK
//
// Attempts to bind every port this invocation will actually use, BEFORE handing off to firebase,
// and fails fast naming the port, its emulator and the offset that produced it. One check covers
// all three ways a port goes missing under concurrent gate runs:
//
//   1. Collision with a default-offset (0) run.
//   2. Collision with another agent's offset — including the non-obvious case where two offsets
//      differ by a pairwise difference of the base ports (offset 100 puts `auth` on 9199, the
//      BASE `storage` port; 1000 puts `ui` on 5000, the BASE `hosting` port).
//   3. An ORPHANED emulator listener that belongs to no offset at all — firebase-tools does not
//      always reap its Java emulators on an abnormal exit, and the survivor keeps the port. This
//      is the one no allocation scheme can ever see, and the reason a bind test beats an offset
//      registry. NOTE: this makes that leak DETECTABLE, not fixed — firebase-tools still leaks
//      the process; we just now fail loudly instead of mysteriously.
//
// Why this earns its place: a held port previously surfaced as `clearFirestore()`/`clearStorage()`
// hook timeouts — 19 of 20 rules FILES failing after ~3 minutes of hanging, with nothing pointing
// at a port. It reads exactly like the rules change under test broke something, which invites a
// speculative "fix" to a security rules file. That is the failure this check exists to prevent.
//
// Honest limitation: this is a TOCTOU check. The probe sockets are closed before firebase starts,
// so another process could still take a port in the gap. It converts the overwhelmingly common
// case (a port already held when the run begins) from a silent multi-minute hang into an
// immediate, named error; it cannot make the race impossible.
//
// Every port is probed with ONE socket held open until all probes finish, rather than
// bind-then-close each in turn: holding them simultaneously also catches a config that computes
// the SAME port for two emulators, which sequential probing would pass.

/**
 * The emulators this invocation will actually start. `hub` and `logging` always start regardless
 * of `--only`; everything else starts only if `--only` names it (or `--only` is absent).
 *
 * Deliberately NOT "every port in the config": with `--only firestore,storage`, a stale listener
 * on the unused `ui` port would abort a run that would have succeeded. A check that fails runs
 * which would have worked is a check people learn to bypass. This probes exactly the set firebase
 * will bind — no port that will be used is skipped, and no port that won't be is demanded.
 */
function emulatorsThatWillStart(names, argv) {
  const ALWAYS = new Set(['hub', 'logging']);
  let only = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only') only = argv[i + 1] ?? '';
    else if (arg.startsWith('--only=')) only = arg.slice('--only='.length);
  }
  if (only === null) return names;
  // `--only firestore,storage` and `--only=firestore,storage` both land here; a `name:sub` form
  // (as `--only functions:foo` uses elsewhere in firebase-tools) keys off the part before ':'.
  const requested = new Set(
    only.split(',').map((part) => part.trim().split(':')[0]).filter(Boolean),
  );
  return names.filter((name) => requested.has(name) || ALWAYS.has(name));
}

/** Resolves `{ server }` when the port is free, or `{ code }` when it is not. Never throws. */
function probePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve({ code: err.code ?? 'UNKNOWN' }));
    // `exclusive` so the probe reports a genuine conflict rather than silently sharing the port
    // under SO_REUSEPORT semantics; 127.0.0.1 is the host firebase binds its emulators to.
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve({ server }));
  });
}

const toProbe = emulatorsThatWillStart(Object.keys(emulators), rest)
  .map((name) => ({ name, port: emulators[name]?.port }))
  .filter((e) => typeof e.port === 'number');

const held = [];
const openProbes = [];
try {
  const results = await Promise.all(toProbe.map((e) => probePort(e.port)));
  results.forEach((result, i) => {
    if (result.server) openProbes.push(result.server);
    else held.push({ ...toProbe[i], code: result.code });
  });
} finally {
  // Release everything we opened before firebase needs these ports — on the failure path too.
  await Promise.all(openProbes.map((server) => new Promise((res) => server.close(() => res()))));
}

if (held.length > 0) {
  const plural = held.length === 1 ? 'port is' : 'ports are';
  const lines = held.map(
    ({ name, port, code }) =>
      `  ${name.padEnd(10)} ${String(basePorts[name] ?? '?')} + ${offset} = ${port}   <-- ${code === 'EADDRINUSE' ? 'IN USE' : code}`,
  );
  console.error(
    `\nEmulator pre-flight failed: ${held.length} ${plural} already in use, so firebase would ` +
      `fail partway through startup (usually as an opaque hang, not a clear error).\n\n` +
      `${lines.join('\n')}\n\n` +
      `Most likely cause, in the order these actually happen:\n` +
      `  1. An ORPHANED emulator process from an earlier run. firebase-tools does not always reap\n` +
      `     its Java emulators on an abnormal exit and the survivor keeps listening. Find and kill it:\n` +
      `       lsof -nP -iTCP:${held[0].port} -sTCP:LISTEN\n` +
      `       kill <pid>\n` +
      `  2. Another session running at this same offset (GOLDSTAR_EMU_OFFSET=${offset}). Pick a\n` +
      `     different one — but avoid an offset whose GAP from another in-flight offset equals a\n` +
      `     pairwise difference of the base ports (1, 5, 100, 400, 500, 600, 1000, ...): offset 100\n` +
      `     puts auth on 9199, which is the BASE storage port.\n` +
      `  3. Something unrelated to Firebase listening on that port.\n\n` +
      `GOLDSTAR_EMU_OFFSET is currently ${offset}${process.env.GOLDSTAR_EMU_OFFSET === undefined ? ' (unset, defaulting to 0)' : ''}.\n`,
  );
  process.exit(1);
}

/**
 * The one derivation of the per-offset project id (see the PER-OFFSET PROJECT ID note above).
 * Kept as a plain function of `offset` with no other input so it can be mirrored exactly by the
 * transportation repo's `scripts/e2e.mjs`, which has its own copy of this wrapper.
 */
const projectId = offset === 0 ? 'demo-goldstar' : `demo-goldstar-${offset}`;

const portOf = (name, fallback) => String(emulators[name]?.port ?? fallback);
const firestorePort = portOf('firestore', 8080);
const authPort = portOf('auth', 9099);
const storagePort = portOf('storage', 9199);

const tempConfigPath = join(repoRoot, `firebase.emulator-offset-${process.pid}.json`);
writeFileSync(tempConfigPath, `${JSON.stringify(config, null, 2)}\n`);

const env = {
  ...process.env,
  FIRESTORE_EMULATOR_HOST: `127.0.0.1:${firestorePort}`,
  FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${authPort}`,
  FIREBASE_STORAGE_EMULATOR_HOST: `127.0.0.1:${storagePort}`,
  GOLDSTAR_EMU_FIRESTORE_PORT: firestorePort,
  GOLDSTAR_EMU_AUTH_PORT: authPort,
  GOLDSTAR_EMU_STORAGE_PORT: storagePort,
  GOLDSTAR_EMU_PROJECT_ID: projectId,
  GCLOUD_PROJECT: projectId,
};

// Carry #42 (Plan 8 Task 16): `--import`/`--export-on-exit` paths get a per-offset suffix so two
// interactive `npm run emulators` sessions at different offsets no longer share (and clobber) one
// data directory. Offset 0 is left exactly as written. See scripts/emulator-data-dir.mjs.
const args = [`emulators:${subcommand}`, '--project', projectId, '--config', tempConfigPath, ...rewriteDataDirArgs(rest, offset)];

let status = 1;
try {
  const result = spawnSync('firebase', args, { stdio: 'inherit', env, cwd: repoRoot });
  if (result.error) throw result.error;
  status = result.status ?? 1;
} finally {
  try {
    rmSync(tempConfigPath, { force: true });
  } catch {
    // best-effort cleanup — a failure here must never mask the real exit status below
  }
}
process.exit(status);
