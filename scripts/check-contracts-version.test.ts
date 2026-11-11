import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkConsumer, extractExportedNames, extractImportedNames } from './check-contracts-version';

const DTS_FIXTURE = `
export declare const ticketSchema: unknown;
export type Ticket = unknown;
export declare const venueSchema: unknown;
export { fleetVehicleSchema, type FleetVehicle } from './schemas/fleetVehicle';
`;

let tmpDir: string | undefined;
function makeTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'contracts-check-'));
  return tmpDir;
}
afterEach(() => {
  if (tmpDir) { rmSync(tmpDir, { recursive: true, force: true }); tmpDir = undefined; }
});

describe('extractImportedNames', () => {
  it('extracts named imports from @goldstar/platform, including type and aliased specifiers', () => {
    const source = `
      import { ticketSchema, type Ticket } from '@goldstar/platform';
      import { venueSchema as vSchema } from '@goldstar/platform';
      import { other } from 'some-other-package';
    `;
    expect(extractImportedNames(source).sort()).toEqual(['Ticket', 'ticketSchema', 'venueSchema'].sort());
  });
  it('returns an empty array when the file has no @goldstar/platform import', () => {
    expect(extractImportedNames("import { x } from 'react';")).toEqual([]);
  });
});

describe('extractExportedNames', () => {
  it('collects declared and re-exported names from a .d.ts file', () => {
    const names = extractExportedNames(DTS_FIXTURE);
    expect(names.has('ticketSchema')).toBe(true);
    expect(names.has('Ticket')).toBe(true);
    expect(names.has('venueSchema')).toBe(true);
    expect(names.has('fleetVehicleSchema')).toBe(true);
    expect(names.has('FleetVehicle')).toBe(true);
  });
});

describe('checkConsumer', () => {
  it('reports ok when every imported symbol is exported', () => {
    const dir = makeTmpDir();
    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'file.ts'), "import { ticketSchema, type Ticket } from '@goldstar/platform';\n");
    const dtsPath = join(dir, 'index.d.ts');
    writeFileSync(dtsPath, DTS_FIXTURE);
    expect(checkConsumer(dir, dtsPath)).toEqual({ ok: true, missing: [] });
  });

  it('reports the missing symbol when a consumer imports something absent from the pinned tag', () => {
    const dir = makeTmpDir();
    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'file.ts'), "import { ticketSchema, staffMarkRoomCharge } from '@goldstar/platform';\n");
    const dtsPath = join(dir, 'index.d.ts');
    writeFileSync(dtsPath, DTS_FIXTURE);
    expect(checkConsumer(dir, dtsPath)).toEqual({ ok: false, missing: ['staffMarkRoomCharge'] });
  });

  it('scans nested directories and ignores imports from other packages', () => {
    const dir = makeTmpDir();
    const nestedDir = join(dir, 'src', 'nested');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, 'deep.ts'), "import { venueSchema } from '@goldstar/platform';\nimport { z } from 'zod';\n");
    const dtsPath = join(dir, 'index.d.ts');
    writeFileSync(dtsPath, DTS_FIXTURE);
    expect(checkConsumer(dir, dtsPath)).toEqual({ ok: true, missing: [] });
  });

  it('treats a consumer with no src directory as having no imports', () => {
    const dir = makeTmpDir();
    const dtsPath = join(dir, 'index.d.ts');
    writeFileSync(dtsPath, DTS_FIXTURE);
    expect(checkConsumer(dir, dtsPath)).toEqual({ ok: true, missing: [] });
  });
});
