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
 * notice or the build fails. Two kinds of package are embedded: those esbuild
 * bundled from node_modules itself (ws, zod, the SDK), and those the SDK's dist
 * already carries pre-bundled (ajv, fast-uri, ...), which esbuild's metafile
 * cannot see and which are found through the `//#region` markers the SDK's
 * bundler left in each chunk. Nothing is fetched: a pre-bundled package's text
 * is read from the pnpm store entry it was bundled from; if that is not on disk
 * the build fails naming the package, and a person supplies its package.json
 * fields and license under third-party/ (see SUPPLIED_DIR).
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
// Where a person supplies the license of a pre-bundled package whose own files are not on disk:
// third-party/<name>@<version>/ holding manifest.json ({ "license", "author" }, copied from that
// version's package.json) and its LICENSE file, both copied from the published package.
const SUPPLIED_DIR = resolve(bridgeRoot, 'third-party');
const SUPPLIED_MANIFEST = 'manifest.json';
const PNPM_STORE = 'node_modules/.pnpm/';
// `//#region <path>` comments rolldown leaves in a pre-bundled chunk, one per original module.
const REGION_PATH = /^\/\/#region (\S+)$/gm;
const STORE_PACKAGE = /node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;
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

/** The pnpm store entry `<name>@<version>[_peers]` → its version. */
function versionOfStoreEntry(entry, name) {
  return entry.slice(name.replace('/', '+').length + 1).split('_')[0];
}

/**
 * Every third-party package the metafile shows embedded, as `Map<"name@version", { name, version, dir, via }>`.
 * `dir` is the package on disk, or null when only its pre-bundled copy inside `via` (the package whose
 * dist carries it) is there. Packages esbuild bundled itself come from the input paths; packages a
 * dependency shipped pre-bundled come from the `//#region` markers in the chunks that reach the output.
 */
export function embeddedPackages(metafile, workingDir = bridgeRoot) {
  const found = new Map();
  const add = (name, version, dir, via) => {
    const key = `${name}@${version}`;
    if (!found.has(key) || (found.get(key).dir === null && dir !== null)) found.set(key, { name, version, dir, via });
  };
  const inOutput = new Set(
    Object.values(metafile.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, { bytesInOutput }]) => bytesInOutput > 0)
        .map(([input]) => input),
    ),
  );
  for (const input of Object.keys(metafile.inputs)) {
    const pkg = packageOf(input, workingDir);
    if (pkg === null) continue;
    add(pkg.name, JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8')).version, pkg.dir, null);
    if (!inOutput.has(input)) continue;
    const storeAt = input.lastIndexOf(PNPM_STORE);
    if (storeAt === -1) continue;
    const storeRoot = input.slice(0, storeAt + PNPM_STORE.length);
    for (const [, region] of readFileSync(resolve(workingDir, input), 'utf8').matchAll(REGION_PATH)) {
      const inner = STORE_PACKAGE.exec(region);
      if (inner === null || inner[2] === pkg.name) continue;
      const [, entry, name] = inner;
      const version = versionOfStoreEntry(entry, name);
      const dir = resolve(workingDir, storeRoot, entry, 'node_modules', name);
      const onDisk = existsSync(join(dir, 'package.json')) && JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version === version;
      add(name, version, onDisk ? dir : null, pkg.name);
    }
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

/** Where to read `pkg`'s manifest fields and license files: the package itself, else what a person supplied. */
function sourceOf({ name, version, dir, via }, suppliedDir) {
  if (dir !== null) return { dir, manifestFile: 'package.json' };
  const supplied = join(suppliedDir, `${name.replace('/', '+')}@${version}`);
  if (existsSync(join(supplied, SUPPLIED_MANIFEST))) return { dir: supplied, manifestFile: SUPPLIED_MANIFEST };
  throw new Error(
    `${name}@${version} is embedded in the bundle (pre-bundled inside ${via}) but its package is not on disk, ` +
      `so its license text is unavailable. Supply it: copy that version's license/author fields into ` +
      `${join(supplied, SUPPLIED_MANIFEST)} and its LICENSE file beside it. Nothing is fetched.`,
  );
}

/** The notice block for one package: identity, license id, copyright, and every license/NOTICE file in full. */
function noticeFor(pkg, suppliedDir) {
  const { name, version } = pkg;
  const { dir, manifestFile } = sourceOf(pkg, suppliedDir);
  const manifest = JSON.parse(readFileSync(join(dir, manifestFile), 'utf8'));
  const license = typeof manifest.license === 'string' ? manifest.license : null;
  if (license === null) throw new Error(`${name}@${version} declares no license in its ${manifestFile}`);
  const files = readdirSync(dir)
    .filter((file) => LICENSE_FILE.test(file))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8').trimEnd() }));
  if (files.length === 0) throw new Error(`${name}@${version} ships no license file; add its notice by hand`);
  const copyright = [...new Set(files.flatMap(({ text }) => copyrightLines(text)))];
  const author = authorOf(manifest);
  if (copyright.length === 0 && author === null) {
    throw new Error(`${name}@${version} names no copyright holder in its license files or its author field`);
  }
  const lines = [RULE, `${name}@${version}`, `License: ${license}`];
  if (copyright.length > 0) lines.push(...copyright.map((line) => `Copyright: ${line}`));
  else lines.push(`Copyright: held by the author named in its ${manifestFile}, ${author}`);
  for (const { file, text } of files) lines.push(RULE, `${file}`, '', text);
  return lines.join('\n');
}

/** The whole notices file for the packages in `packages` (what `embeddedPackages` returns). */
export function generateNotices(packages, suppliedDir = SUPPLIED_DIR) {
  const header = [
    'Third-party notices for retivo-mcp-bridge.mjs',
    '',
    'This file is generated by apps/mcp-bridge/scripts/build-bundle.mjs from the',
    'package.json and license files of every package embedded in the bundle.',
    'The bridge itself is licensed under the Apache License 2.0 (see LICENSE).',
    '',
    `Embedded packages (${packages.size}): ${[...packages.keys()].join(', ')}`,
  ].join('\n');
  return [header, ...[...packages.values()].map((pkg) => noticeFor(pkg, suppliedDir))].join('\n\n') + '\n';
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
