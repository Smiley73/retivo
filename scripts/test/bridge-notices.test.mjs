// Third-party notices of the bridge bundle (apps/mcp-bridge/scripts/build-bundle.mjs).
// The SDK's dist ships ajv, fast-uri and others already bundled, so esbuild's metafile lists only the
// SDK's own files for them; the notices generator finds them through the `//#region` markers in those
// chunks. This runs the generator on a throwaway workspace and on the real SDK chunks (no bundle
// build; the built artifact is checked by bridge-artifact-contract.test.mjs). Runs under
// `pnpm test:scripts`.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BRIDGE_ROOT = resolve(REPO_ROOT, 'apps', 'mcp-bridge');
const { embeddedPackages, generateNotices } = await import(pathToFileURL(resolve(BRIDGE_ROOT, 'scripts', 'build-bundle.mjs')).href);

const MIT = 'MIT License\n\nCopyright (c) 2020 Some Author\n\nPermission is hereby granted, free of charge';
const HOST_CHUNK = 'node_modules/.pnpm/host@1.0.0/node_modules/host/dist/chunk.mjs';

let dir;
let supplied;

/** A package on disk under the throwaway workspace's pnpm store. */
function writePackage(name, version, files) {
  const pkgDir = join(dir, 'node_modules', '.pnpm', `${name}@${version}`, 'node_modules', name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version, license: 'MIT' }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(pkgDir, file)), { recursive: true });
    writeFileSync(join(pkgDir, file), text);
  }
}

const hostChunk = (...regions) => regions.map((region) => `//#region ../../node_modules/.pnpm/${region}\nvar x = 1;\n//#endregion\n`).join('');
const metafileFor = (bytesInOutput) => ({
  inputs: { [HOST_CHUNK]: { bytes: 10 } },
  outputs: { 'out.mjs': { inputs: { [HOST_CHUNK]: { bytesInOutput } } } },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-notices-'));
  supplied = join(dir, 'third-party');
  writePackage('host', '1.0.0', { LICENSE: MIT, 'dist/chunk.mjs': hostChunk('inner@2.0.0/node_modules/inner/index.js', 'host@1.0.0/node_modules/host/dist/own.js') });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('a package pre-bundled inside a dependency is found and gets its notice', () => {
  writePackage('inner', '2.0.0', { LICENSE: MIT.replace('Some Author', 'Inner Author') });
  const packages = embeddedPackages(metafileFor(10), dir);
  assert.deepEqual([...packages.keys()], ['host@1.0.0', 'inner@2.0.0']);
  assert.equal(packages.get('inner@2.0.0').via, 'host');
  const notices = generateNotices(packages, supplied);
  assert.match(notices, /^inner@2\.0\.0$/m);
  assert.match(notices, /Copyright: Copyright \(c\) 2020 Inner Author/);
});

test('a pre-bundled chunk tree-shaken out of the output contributes nothing', () => {
  writePackage('inner', '2.0.0', { LICENSE: MIT });
  assert.deepEqual([...embeddedPackages(metafileFor(0), dir).keys()], ['host@1.0.0']);
});

test('a pre-bundled package whose files are not on disk fails the build, naming it', () => {
  const packages = embeddedPackages(metafileFor(10), dir);
  assert.throws(() => generateNotices(packages, supplied), /inner@2\.0\.0 is embedded .*pre-bundled inside host/);
});

test('a version of the package on disk other than the embedded one is not used for its notice', () => {
  writePackage('inner', '3.0.0', { LICENSE: MIT });
  const packages = embeddedPackages(metafileFor(10), dir);
  assert.equal(packages.get('inner@2.0.0').dir, null);
  assert.throws(() => generateNotices(packages, supplied), /inner@2\.0\.0 is embedded/);
});

test('a license supplied under third-party/ stands in for the missing package', () => {
  const suppliedDir = join(supplied, 'inner@2.0.0');
  mkdirSync(suppliedDir, { recursive: true });
  writeFileSync(join(suppliedDir, 'manifest.json'), JSON.stringify({ license: 'BSD-3-Clause' }));
  writeFileSync(join(suppliedDir, 'LICENSE'), 'Copyright (c) 2021 Supplied Author\nAll rights reserved.');
  const notices = generateNotices(embeddedPackages(metafileFor(10), dir), supplied);
  assert.match(notices, /^inner@2\.0\.0\nLicense: BSD-3-Clause\nCopyright: Copyright \(c\) 2021 Supplied Author$/m);
});

test("the real SDK's pre-bundled packages are all found, each at the version its dist carries", () => {
  const sdkDist = join(realpathSync(join(BRIDGE_ROOT, 'node_modules', '@modelcontextprotocol', 'server')), 'dist');
  const inputs = ['ajvProvider-CEoC__sr.mjs', 'src-Cqbh3MYc.mjs'].map((chunk) => relative(BRIDGE_ROOT, join(sdkDist, chunk)));
  const metafile = {
    inputs: Object.fromEntries(inputs.map((input) => [input, { bytes: 1 }])),
    outputs: { 'out.mjs': { inputs: Object.fromEntries(inputs.map((input) => [input, { bytesInOutput: 1 }])) } },
  };
  const keys = [...embeddedPackages(metafile, BRIDGE_ROOT).keys()];
  for (const expected of [
    'ajv@8.18.0',
    'ajv-formats@3.0.1',
    'content-type@1.0.5',
    'fast-deep-equal@3.1.3',
    'fast-uri@3.1.0',
    'json-schema-traverse@1.0.0',
  ]) {
    assert.ok(keys.includes(expected), `${expected} is embedded in the SDK chunks but not found: ${keys.join(', ')}`);
  }
});
