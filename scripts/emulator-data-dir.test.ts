import { describe, expect, it } from 'vitest';
import { rewriteDataDirArgs, suffixDataDir } from './emulator-data-dir.mjs';

describe('emulator data dir per offset (Plan 8 Task 16, carry #42)', () => {
  it('offset 0 leaves the args untouched (the default local data dir keeps working)', () => {
    const args = ['--import=./.emulator-data', '--export-on-exit', '--only', 'firestore'];
    const out = rewriteDataDirArgs(args, 0);
    expect(out).toEqual(args);
    expect(out).not.toBe(args); // always a copy
  });

  it('rewrites --import=<dir> and --export-on-exit=<dir> to <dir>-<offset>', () => {
    expect(rewriteDataDirArgs(['--import=./.emulator-data', '--export-on-exit=./.emulator-data/'], 250)).toEqual([
      '--import=./.emulator-data-250',
      '--export-on-exit=./.emulator-data-250',
    ]);
  });

  it('rewrites the space-separated forms and leaves a bare --export-on-exit alone', () => {
    expect(rewriteDataDirArgs(['--import', './.emulator-data', '--export-on-exit', '--only', 'auth'], 7)).toEqual([
      '--import',
      './.emulator-data-7',
      '--export-on-exit',
      '--only',
      'auth',
    ]);
    expect(rewriteDataDirArgs(['--export-on-exit', './out'], 7)).toEqual(['--export-on-exit', './out-7']);
  });

  it('does not touch unrelated args or a --import that is the last token', () => {
    expect(rewriteDataDirArgs(['--only', 'firestore,auth', '--import'], 3)).toEqual(['--only', 'firestore,auth', '--import']);
    expect(rewriteDataDirArgs([], 3)).toEqual([]);
  });

  it('suffixDataDir strips trailing slashes before appending', () => {
    expect(suffixDataDir('./x///', 12)).toBe('./x-12');
    expect(suffixDataDir('/abs/path', 1)).toBe('/abs/path-1');
  });
});
