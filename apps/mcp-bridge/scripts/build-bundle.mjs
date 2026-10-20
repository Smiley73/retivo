#!/usr/bin/env node
/**
 * Bundles the bridge into one self-contained file an agent can run with
 * `node <file> --origin <origin>`: no node_modules beside it, nothing to install.
 *
 * Input  : dist/bin.js (the TypeScript build; `pnpm build` runs it first).
 * Output : apps/mcp-bridge/build/ — or the directory named by
 *          $BRIDGE_BUNDLE_OUTPUT_DIR when set (the artifact-contract test points
 *          this at a temp dir, and build_spa at a stub dir in its own test):
 *            retivo-mcp-bridge.mjs   the bundle (Node shebang, executable, no source map)
 *            THIRD-PARTY-NOTICES.txt the license and copyright notices of everything embedded
 *          $BRIDGE_BUNDLE_METAFILE, when set, also receives esbuild's metafile
 *          (outside the output directory, which holds exactly the two files).
 *
 * The MCP SDK, `ws`, `zod` and the protocol package are embedded. Node built-ins
 * stay external, and so do the two optional native add-ons `ws` tries to load
 * inside a try/catch (`bufferutil`, `utf-8-validate`): they are not installed, and
 * `ws` runs without them.
 *
 * The notices are generated from each embedded package's own package.json and
 * license files, never copied by hand, so a new transitive dependency gets its
 * notice or the build fails.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const bridgeRoot = resolve(here, '..');

export const BUNDLE_NAME = 'retivo-mcp-bridge.mjs';
export const NOTICES_NAME = 'THIRD-PARTY-NOTICES.txt';
const OPTIONAL_NATIVES = ['bufferutil', 'utf-8-validate'];
const NODE_MODULES = 'node_modules/';
const LICENSE_FILE = /^(licen[cs]e|notice)(\.|$)/i;
// A real notice names a year; that rules out Apache's own boilerplate ("Copyright notice that is
// included in or attached to the work", "Copyright [yyyy] [name of copyright owner]").
const COPYRIGHT_LINE = /^\s*(copyright|\(c\)|©).*\b(19|20)\d\d\b/i;
const RULE = '='.repeat(72);

/** The package a bundled input file belongs to, as `{ name, dir }`, or null for first-party files. */
function packageOf(inputPath, workingDir) {
  const at = inputPath.lastIndexOf(NODE_MODULES);
  if (at === -1) return null;
  const rest = inputPath.slice(at + NODE_MODULES.length).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  const dir = resolve(workingDir, inputPath.slice(0, at + NODE_MODULES.length), name);
  return { name, dir };
}

/** Every third-party package the metafile shows embedded, as `Map<name, dir>`. */
export function embeddedPackages(metafile, workingDir = bridgeRoot) {
  const found = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const pkg = packageOf(input, workingDir);
    if (pkg !== null) found.set(pkg.name, pkg.dir);
  }
  return new Map([...found].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The real copyright lines of a license text. */
function copyrightLines(text) {
  return text
    .split('\n')
    .filter((line) => COPYRIGHT_LINE.test(line))
    .map((line) => line.trim());
}

function authorOf(manifest) {
  const { author } = manifest;
  if (typeof author === 'string') return author;
  if (author !== null && typeof author === 'object' && typeof author.name === 'string') return author.name;
  return null;
}

/** The notice block for one package: identity, license id, copyright, and every license/NOTICE file in full. */
function noticeFor(name, dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const license = typeof manifest.license === 'string' ? manifest.license : null;
  if (license === null) throw new Error(`${name}@${manifest.version} declares no license in its package.json`);
  const files = readdirSync(dir)
    .filter((file) => LICENSE_FILE.test(file))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8').trimEnd() }));
  if (files.length === 0) throw new Error(`${name}@${manifest.version} ships no license file; add its notice by hand`);
  const copyright = [...new Set(files.flatMap(({ text }) => copyrightLines(text)))];
  const author = authorOf(manifest);
  if (copyright.length === 0 && author === null) {
    throw new Error(`${name}@${manifest.version} names no copyright holder in its license files or its author field`);
  }
  const lines = [RULE, `${name}@${manifest.version}`, `License: ${license}`];
  if (copyright.length > 0) lines.push(...copyright.map((line) => `Copyright: ${line}`));
  else lines.push(`Copyright: held by the author named in its package.json, ${author}`);
  for (const { file, text } of files) lines.push(RULE, `${file}`, '', text);
  return lines.join('\n');
}

/** The whole notices file for the packages in `packages` (`Map<name, dir>`). */
export function generateNotices(packages) {
  const header = [
    'Third-party notices for retivo-mcp-bridge.mjs',
    '',
    'This file is generated by apps/mcp-bridge/scripts/build-bundle.mjs from the',
    'package.json and license files of every package embedded in the bundle.',
    'The bridge itself is licensed under the Apache License 2.0 (see LICENSE).',
    '',
    `Embedded packages (${packages.size}): ${[...packages.keys()].join(', ')}`,
  ].join('\n');
  return [header, ...[...packages].map(([name, dir]) => noticeFor(name, dir))].join('\n\n') + '\n';
}

/** Bundles into `outDir`; returns the esbuild metafile. */
export async function buildBundle({ outDir, metafilePath }) {
  const entry = resolve(bridgeRoot, 'dist', 'bin.js');
  if (!existsSync(entry)) throw new Error(`${entry} is missing; run the TypeScript build first (pnpm build).`);
  const { version } = JSON.parse(readFileSync(resolve(bridgeRoot, 'package.json'), 'utf8'));

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, BUNDLE_NAME);

  const result = await build({
    absWorkingDir: bridgeRoot,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: OPTIONAL_NATIVES,
    metafile: true,
    sourcemap: false,
    legalComments: 'none',
    // The bin reads this instead of a package.json that is not beside the bundle.
    define: { __BRIDGE_VERSION__: JSON.stringify(version) },
    // ws and a few embedded packages are CommonJS and `require` Node built-ins.
    banner: {
      js: [
        '// Retivo bridge. The licenses and copyright notices of the packages embedded below are in',
        `// ${NOTICES_NAME} (served beside this file as retivo-mcp-bridge-notices.txt).`,
        "import { createRequire as __retivoCreateRequire } from 'node:module';",
        'const require = __retivoCreateRequire(import.meta.url);',
      ].join('\n'),
    },
    logLevel: 'silent',
  });
  if (result.warnings.length > 0) {
    throw new Error(`esbuild warned: ${result.warnings.map((w) => w.text).join('; ')}`);
  }
  chmodSync(outfile, 0o755);
  writeFileSync(join(outDir, NOTICES_NAME), generateNotices(embeddedPackages(result.metafile)));
  if (metafilePath !== undefined) writeFileSync(metafilePath, JSON.stringify(result.metafile));
  return result.metafile;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = resolve(process.env.BRIDGE_BUNDLE_OUTPUT_DIR || resolve(bridgeRoot, 'build'));
  const metafilePath = process.env.BRIDGE_BUNDLE_METAFILE ? resolve(process.env.BRIDGE_BUNDLE_METAFILE) : undefined;
  const metafile = await buildBundle({ outDir, metafilePath });
  console.log(`Bridge bundle: ${join(outDir, BUNDLE_NAME)} (${embeddedPackages(metafile).size} third-party packages embedded)`);
}
