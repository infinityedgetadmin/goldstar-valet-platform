import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const PACKAGE_NAME = '@goldstar/platform';
const SOURCE_EXTENSIONS = ['.ts', '.tsx'] as const;
const IGNORED_DIR_NAMES = new Set(['node_modules', 'dist', '.git']);

const IMPORT_BLOCK_RE = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]@goldstar\/platform['"]/g;

/** Extracts the local-facing imported names (post-`as`) from every `@goldstar/platform` named import in a source file. */
export function extractImportedNames(source: string): string[] {
  const names: string[] = [];
  IMPORT_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_BLOCK_RE.exec(source))) {
    const specifierList = match[1] ?? '';
    for (const rawSpecifier of specifierList.split(',')) {
      const specifier = rawSpecifier.trim();
      if (!specifier) continue;
      const withoutTypeKeyword = specifier.replace(/^type\s+/, '');
      const exportedName = withoutTypeKeyword.split(/\s+as\s+/)[0]?.trim();
      if (exportedName) names.push(exportedName);
    }
  }
  return names;
}

function walkFiles(dir: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIR_NAMES.has(entry)) continue;
    const fullPath = join(dir, entry);
    const info = statSync(fullPath);
    if (info.isDirectory()) found.push(...walkFiles(fullPath, extensions));
    else if (extensions.includes(extname(fullPath))) found.push(fullPath);
  }
  return found;
}

/** Collects every distinct symbol a consumer's `src` tree imports from `@goldstar/platform`. */
export function collectImportedNames(srcDir: string): Set<string> {
  const names = new Set<string>();
  if (!existsSync(srcDir)) return names;
  for (const file of walkFiles(srcDir, SOURCE_EXTENSIONS)) {
    const source = readFileSync(file, 'utf8');
    for (const name of extractImportedNames(source)) names.add(name);
  }
  return names;
}

const DTS_DECL_RE = /export\s+(?:declare\s+)?(?:const|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const DTS_BRACE_RE = /export\s*\{([^}]+)\}/g;

/** Extracts every top-level exported symbol name from a `.d.ts` file's source text. */
export function extractExportedNames(dtsSource: string): Set<string> {
  const names = new Set<string>();
  DTS_DECL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DTS_DECL_RE.exec(dtsSource))) {
    const name = match[1];
    if (name) names.add(name);
  }
  DTS_BRACE_RE.lastIndex = 0;
  while ((match = DTS_BRACE_RE.exec(dtsSource))) {
    const specifierList = match[1] ?? '';
    for (const rawSpecifier of specifierList.split(',')) {
      const specifier = rawSpecifier.trim().replace(/^type\s+/, '');
      if (!specifier) continue;
      const exportedName = specifier.split(/\s+as\s+/).pop()?.trim();
      if (exportedName) names.add(exportedName);
    }
  }
  return names;
}

export interface ConsumerCheckResult {
  ok: boolean;
  missing: string[];
}

/** Checks that every `@goldstar/platform` symbol imported under `consumerDir/src` is exported from the given `.d.ts` file. */
export function checkConsumer(consumerDir: string, dtsPath: string): ConsumerCheckResult {
  const imported = collectImportedNames(join(consumerDir, 'src'));
  const exported = extractExportedNames(readFileSync(dtsPath, 'utf8'));
  const missing = [...imported].filter((name) => !exported.has(name)).sort();
  return { ok: missing.length === 0, missing };
}

function main(): void {
  const consumerDir = process.argv[2];
  if (!consumerDir) {
    console.error('Usage: check-contracts-version <consumerDir> [dtsPath]');
    process.exitCode = 1;
    return;
  }
  const dtsPath = process.argv[3] ?? join(import.meta.dirname, '..', 'dist', 'index.d.ts');
  if (!existsSync(dtsPath)) {
    console.error(`No built declaration file at ${dtsPath}. Run "npm run build" first.`);
    process.exitCode = 1;
    return;
  }
  const result = checkConsumer(consumerDir, dtsPath);
  if (!result.ok) {
    console.error(`Missing ${PACKAGE_NAME} exports referenced by ${consumerDir}: ${result.missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK: every ${PACKAGE_NAME} import in ${consumerDir} is present in ${dtsPath}`);
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) main();
