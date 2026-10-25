// scripts/stage-bridge-bundle.mjs copies the built bundle and notices into the SPA's dist/ and writes bridge.json (SHA-256, size, version).
// Runs the real script on throwaway directories.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts', 'stage-bridge-bundle.mjs');
const { BRIDGE_FILE, BRIDGE_NOTICES_FILE, BRIDGE_MANIFEST_FILE } = await import(
  pathToFileURL(resolve(REPO_ROOT, 'packages', 'assistant-protocol', 'dist', 'index.js')).href
);
const bridgeVersion = JSON.parse(readFileSync(resolve(REPO_ROOT, 'apps', 'mcp-bridge', 'package.json'), 'utf8')).version;

const BUNDLE_TEXT = '#!/usr/bin/env node\nconsole.log("bridge");\n';
const NOTICES_TEXT = 'Third-party notices\n';

let dir;
let bundleDir;
let distDir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stage-bridge-'));
  bundleDir = join(dir, 'build');
  distDir = join(dir, 'dist');
  mkdirSync(bundleDir);
  mkdirSync(distDir);
  writeFileSync(join(bundleDir, 'retivo-mcp-bridge.mjs'), BUNDLE_TEXT);
  writeFileSync(join(bundleDir, 'THIRD-PARTY-NOTICES.txt'), NOTICES_TEXT);
  writeFileSync(join(distDir, 'index.html'), '<html></html>');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('copies the bundle and notices beside the SPA and writes the checksum manifest', () => {
  const r = run(bundleDir, distDir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(distDir).sort(), [BRIDGE_FILE, BRIDGE_MANIFEST_FILE, BRIDGE_NOTICES_FILE, 'index.html'].sort());
  assert.equal(readFileSync(join(distDir, BRIDGE_FILE), 'utf8'), BUNDLE_TEXT, 'byte for byte');
  assert.equal(readFileSync(join(distDir, BRIDGE_NOTICES_FILE), 'utf8'), NOTICES_TEXT);
  const manifest = JSON.parse(readFileSync(join(distDir, BRIDGE_MANIFEST_FILE), 'utf8'));
  assert.deepEqual(manifest, {
    version: bridgeVersion,
    sha256: createHash('sha256').update(BUNDLE_TEXT).digest('hex'),
    size: Buffer.byteLength(BUNDLE_TEXT),
  });
  assert.ok(r.stdout.includes(manifest.sha256));
});

test('leaves the SPA files it did not write alone', () => {
  assert.equal(run(bundleDir, distDir).status, 0);
  assert.equal(readFileSync(join(distDir, 'index.html'), 'utf8'), '<html></html>');
});

test('refuses a bundle directory without the bundle or the notices, writing nothing', () => {
  rmSync(join(bundleDir, 'THIRD-PARTY-NOTICES.txt'));
  const r = run(bundleDir, distDir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /THIRD-PARTY-NOTICES\.txt is missing/);
  assert.deepEqual(readdirSync(distDir), ['index.html']);
});

test('refuses a missing SPA dist directory', () => {
  const r = run(bundleDir, join(dir, 'nope'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nope is missing/);
});

test('refuses the wrong number of arguments', () => {
  assert.equal(run(bundleDir).status, 2);
  assert.equal(run(bundleDir, distDir, 'extra').status, 2);
});
