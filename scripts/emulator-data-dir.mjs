// Plan 8 Task 16 (carry #42): per-offset emulator data directories.
//
// `npm run emulators` forwards `--import=./.emulator-data --export-on-exit` to
// `firebase emulators:start`. With GOLDSTAR_EMU_OFFSET isolating ports and project ids per
// session, that ONE shared directory was the last thing two interactive sessions still collided
// on — the second session's export-on-exit would clobber the first's data. This rewrites every
// `--import`/`--export-on-exit` path argument to `<dir>-<offset>` for a non-zero offset, and leaves
// offset 0 (the default, `./.emulator-data`) untouched so existing local data keeps working.
//
// Pure — no I/O — so it is unit-tested directly (scripts/emulator-data-dir.test.ts); the wrapper
// (scripts/emulator-config.mjs) applies it to the forwarded args.

const DATA_DIR_FLAGS = new Set(['--import', '--export-on-exit']);

/** `./.emulator-data` + 7 -> `./.emulator-data-7` (trailing slashes dropped first). */
export function suffixDataDir(dir, offset) {
  return `${dir.replace(/\/+$/, '')}-${offset}`;
}

/**
 * @param {string[]} args  the arguments forwarded verbatim to `firebase emulators:<subcommand>`
 * @param {number} offset  GOLDSTAR_EMU_OFFSET (0 = untouched)
 * @returns {string[]}     a new array; `args` is never mutated
 */
export function rewriteDataDirArgs(args, offset) {
  if (offset === 0) return [...args];
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const eq = /^(--import|--export-on-exit)=(.*)$/.exec(arg);
    if (eq) {
      out.push(`${eq[1]}=${suffixDataDir(eq[2], offset)}`);
      continue;
    }
    if (DATA_DIR_FLAGS.has(arg)) {
      const next = args[i + 1];
      // `--export-on-exit` may stand alone (meaning "export to the --import dir"); only a
      // following non-flag token is a path to rewrite.
      if (next !== undefined && !next.startsWith('--')) {
        out.push(arg, suffixDataDir(next, offset));
        i += 1;
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}
