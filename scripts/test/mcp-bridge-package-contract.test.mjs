// Package contract for apps/mcp-bridge, the stdio MCP relay agents run on the
// person's machine (`npx`-style, from a command the app shows). A dependency
// added to it lands on every person's machine with their agent's privileges, so
// the manifest is held to rules a reviewer should not have to re-check by eye:
//
//   - every non-workspace dependency is an exact version (no ^, ~, ranges, tags),
//     so an install can never pick up a version nobody reviewed;
//   - no preinstall / install / postinstall script, so installing it runs no
//     code beyond its dependencies' own (and `ws`'s optional natives are not
//     declared);
//   - there are no runtime `dependencies`: everything the bridge needs is
//     embedded in the single-file bundle (scripts/build-bundle.mjs), so what it
//     embeds sits in `devDependencies` where `audit:ci` still audits it;
//   - the `files` allowlist is exactly the bundle, its notices, the README and
//     the license, the bin is the bundle, the package stays `private`, and it is
//     ESM on the same Node range as the repo;
//   - the dependency names equal a frozen allowlist: a new dependency fails here
//     until the list below is edited WITH a reason, which makes adding one a
//     visible, reviewed decision.
//
// Each rule also runs against a small inline manifest that breaks it, so the
// rules themselves are shown to fail. Runs under `pnpm test:scripts`. Pattern:
// scripts/test/pnpm-config-contract.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_MANIFEST = resolve(__dirname, '../../apps/mcp-bridge/package.json');
const ROOT_MANIFEST = resolve(__dirname, '../../package.json');

// Frozen allowlists, by dependency field. Edit only with a reason in the PR.
const ALLOWED_NAMES = Object.freeze({
  dependencies: Object.freeze([]),
  devDependencies: Object.freeze([
    // Embedded in the bundle. The MCP server SDK (v2): the stdio transport and tool/prompt registration.
    '@modelcontextprotocol/server',
    // Embedded in the bundle. The shared frames, registry and pairing rules (workspace package).
    '@retirement/assistant-protocol',
    // Embedded in the bundle. The loopback WebSocket server the tab dials.
    'ws',
    // Builds the single-file bundle; already resolved in the lockfile for the web build.
    'esbuild',
    '@types/node',
    // `ws` ships no types.
    '@types/ws',
    '@vitest/coverage-v8',
    'typescript',
    'vitest',
  ]),
  optionalDependencies: Object.freeze([]),
  peerDependencies: Object.freeze([]),
});

const DEPENDENCY_FIELDS = Object.keys(ALLOWED_NAMES);
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall'];
const BUNDLE = 'build/retivo-mcp-bridge.mjs';
const EXPECTED_FILES = [BUNDLE, 'build/THIRD-PARTY-NOTICES.txt', 'README.md', 'LICENSE'];
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Every rule violation in `manifest`, each prefixed with the rule id. */
function violations(manifest, rootManifest) {
  const found = [];

  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (version.startsWith('workspace:')) continue;
      if (!EXACT_VERSION.test(version)) {
        found.push(`exact-pin: ${field}.${name} is "${version}", not an exact version`);
      }
    }
  }

  for (const script of LIFECYCLE_SCRIPTS) {
    if (manifest.scripts?.[script] !== undefined) {
      found.push(`no-lifecycle-scripts: scripts.${script} is defined`);
    }
  }

  if (Object.keys(manifest.dependencies ?? {}).length > 0) {
    found.push(`no-runtime-dependencies: dependencies is ${JSON.stringify(manifest.dependencies)}; the bundle embeds them`);
  }

  if (manifest.private !== true) found.push('private: the package must stay private (nothing is published to npm)');

  if (JSON.stringify(manifest.files) !== JSON.stringify(EXPECTED_FILES)) {
    found.push(`files: expected ${JSON.stringify(EXPECTED_FILES)}, got ${JSON.stringify(manifest.files)}`);
  }

  const bins = typeof manifest.bin === 'string' ? { bin: manifest.bin } : (manifest.bin ?? {});
  if (Object.keys(bins).length === 0) found.push('bin: no bin entry');
  for (const [name, path] of Object.entries(bins)) {
    if (path !== BUNDLE) found.push(`bin: ${name} points at "${path}", not at the bundle ${BUNDLE}`);
  }

  if (manifest.type !== 'module') found.push(`type: expected "module", got ${JSON.stringify(manifest.type)}`);

  if (manifest.engines?.node !== rootManifest.engines?.node) {
    found.push(
      `engines: node is ${JSON.stringify(manifest.engines?.node)}, the root has ${JSON.stringify(rootManifest.engines?.node)}`,
    );
  }

  for (const field of DEPENDENCY_FIELDS) {
    const actual = Object.keys(manifest[field] ?? {}).sort();
    const allowed = [...ALLOWED_NAMES[field]].sort();
    const extra = actual.filter((name) => !allowed.includes(name));
    const missing = allowed.filter((name) => !actual.includes(name));
    if (extra.length > 0) {
      found.push(`allowlist: ${field} has ${extra.join(', ')}, not in the frozen list; edit ALLOWED_NAMES with a reason`);
    }
    if (missing.length > 0) {
      found.push(`allowlist: ${field} lacks ${missing.join(', ')}, which the frozen list expects`);
    }
  }

  return found;
}

const realManifest = JSON.parse(readFileSync(BRIDGE_MANIFEST, 'utf8'));
const rootManifest = JSON.parse(readFileSync(ROOT_MANIFEST, 'utf8'));

test('the real apps/mcp-bridge manifest satisfies every rule', () => {
  assert.deepEqual(violations(realManifest, rootManifest), []);
});

// --- Each rule fails on a manifest that breaks it ------------------------

const clone = (value) => JSON.parse(JSON.stringify(value));
function broken(mutate) {
  const manifest = clone(realManifest);
  mutate(manifest);
  return manifest;
}

const BREAKING_MANIFESTS = [
  ['a caret range', (m) => { m.devDependencies.ws = '^8.22.0'; }, /exact-pin: devDependencies\.ws/],
  ['a tilde range', (m) => { m.devDependencies.ws = '~8.22.0'; }, /exact-pin: devDependencies\.ws/],
  ['a tag', (m) => { m.devDependencies['@modelcontextprotocol/server'] = 'latest'; }, /exact-pin: devDependencies\.@modelcontextprotocol\/server/],
  ['a comparator range', (m) => { m.devDependencies.vitest = '>=5.0.4'; }, /exact-pin: devDependencies\.vitest/],
  ['a preinstall script', (m) => { m.scripts.preinstall = 'node x.js'; }, /no-lifecycle-scripts: scripts\.preinstall/],
  ['an install script', (m) => { m.scripts.install = 'node x.js'; }, /no-lifecycle-scripts: scripts\.install/],
  ['a postinstall script', (m) => { m.scripts.postinstall = 'node x.js'; }, /no-lifecycle-scripts: scripts\.postinstall/],
  ['extra published files', (m) => { m.files = [...m.files, 'src']; }, /files: expected/],
  ['the unbundled dist published', (m) => { m.files = ['dist']; }, /files: expected/],
  ['no files field', (m) => { delete m.files; }, /files: expected/],
  ['a bin outside the bundle', (m) => { m.bin = { 'retivo-mcp-bridge': 'dist/bin.js' }; }, /bin: retivo-mcp-bridge points at "dist\/bin.js"/],
  ['a runtime dependency', (m) => { m.dependencies = { ws: '8.22.0' }; }, /no-runtime-dependencies/],
  ['a publishable package', (m) => { m.private = false; }, /private: the package must stay private/],
  ['no bin', (m) => { delete m.bin; }, /bin: no bin entry/],
  ['CommonJS', (m) => { delete m.type; }, /type: expected "module"/],
  ['another Node range', (m) => { m.engines.node = '>=20'; }, /engines: node is ">=20"/],
  ['a new dependency', (m) => { m.dependencies = { zod: '4.6.7' }; }, /allowlist: dependencies has zod/],
  ['a new dev dependency', (m) => { m.devDependencies['left-pad'] = '1.3.0'; }, /allowlist: devDependencies has left-pad/],
  ['an optional dependency', (m) => { m.optionalDependencies = { bufferutil: '4.0.9' }; }, /allowlist: optionalDependencies has bufferutil/],
  ['a dropped dependency', (m) => { delete m.devDependencies.ws; }, /allowlist: devDependencies lacks ws/],
];

for (const [name, mutate, expected] of BREAKING_MANIFESTS) {
  test(`fails on ${name}`, () => {
    const found = violations(broken(mutate), rootManifest);
    assert.ok(
      found.some((line) => expected.test(line)),
      `expected a violation matching ${expected}, got:\n${found.join('\n') || '(none)'}`,
    );
  });
}

test('workspace dependencies are exempt from the exact-pin rule', () => {
  assert.equal(realManifest.devDependencies['@retirement/assistant-protocol'], 'workspace:*');
  assert.deepEqual(violations(realManifest, rootManifest), []);
});
