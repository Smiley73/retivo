// Bridge artifact contract.
//
// The bridge is shipped as ONE file, `retivo-mcp-bridge.mjs`, built by
// `pnpm --filter @retirement/mcp-bridge build` (apps/mcp-bridge/scripts/build-bundle.mjs)
// and served from the app's own origin (build_spa, see stage-bridge-bundle.mjs).
// A person saves it and runs `node <file> --origin ...`, so everything it needs
// must be inside it. This test builds the bundle into a throwaway directory and
// asserts what that promise rests on:
//
//   - the output directory holds exactly the bundle and the generated notices;
//   - the bundle starts with a Node shebang, is executable and carries no
//     source map reference;
//   - it stays under a size ceiling (twice the first measured size), so silent
//     growth, say a dependency that pulls in an HTTP server, is noticed;
//   - copied alone into an empty directory (no node_modules anywhere near it) it
//     answers an MCP `initialize` and `tools/list` over stdio with the manifest's
//     version and exactly the protocol registry's tools, and exits 0 when stdin
//     closes. That run is the only proof the embedding is complete;
//   - every package esbuild bundled is the version the workspace resolved and the
//     lockfile pins, and the two optional `ws` natives are not embedded;
//   - the bundle file itself ends in the notices, so the copy a person keeps carries
//     every embedded package's license and copyright text (the notices file served
//     beside it never reaches their disk);
//   - the notices name every embedded package with its license and copyright,
//     and the set equals the bundler's own package set. The SDK's dist ships
//     ajv, fast-uri and others already bundled, invisible to esbuild's metafile,
//     so the set is also checked against the SDK chunks' own source maps, an
//     inventory the bundler's code did not produce;
//   - `npm pack --dry-run` of the artifact lists exactly the allowlisted files
//     and a manifest with no dependencies and no install scripts.
//
// A passing run does not prove the file runs on a different Node 24 minor or on
// Windows. Heavier than the other scripts/test/ checks (a real build), so it is
// a plain node:test run by `pnpm test:contracts` (RUN_CONTRACT_TESTS=1) and
// skipped under `pnpm test:scripts`. Pattern: lambda-artifact-contract.test.mjs.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BRIDGE_ROOT = resolve(REPO_ROOT, 'apps', 'mcp-bridge');
const BUNDLE = 'retivo-mcp-bridge.mjs';
const NOTICES = 'THIRD-PARTY-NOTICES.txt';
const BUILD_TIMEOUT_MS = 300_000;
const RUN_TIMEOUT_MS = 20_000;
// Twice the first measured size (1.54 MB). Raise it only with a reason in the PR.
const MAX_BUNDLE_BYTES = 3_100_000;
const OPTIONAL_NATIVES = ['bufferutil', 'utf-8-validate'];
// `node_modules/.pnpm/<name>@<version>[_peers]/node_modules/<name>/` inside a source map's `sources`.
const STORE_SOURCE = /node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;

const RUN = process.env.RUN_CONTRACT_TESTS === '1';

/** A TCP port nothing is listening on right now. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * Every `name@version` the bundled files' own source maps say they were built from, for the inputs that
 * reach the output. Independent of the bundler's code: it reads what the dependencies recorded.
 */
function packagesFromSourceMaps(metafile) {
  const found = new Set();
  const inputs = new Set(
    Object.values(metafile.outputs).flatMap((output) =>
      Object.entries(output.inputs).filter(([, { bytesInOutput }]) => bytesInOutput > 0).map(([input]) => input),
    ),
  );
  for (const input of inputs) {
    const mapFile = resolve(BRIDGE_ROOT, `${input}.map`);
    if (!existsSync(mapFile)) continue;
    for (const source of JSON.parse(readFileSync(mapFile, 'utf8')).sources) {
      const match = STORE_SOURCE.exec(source);
      if (match === null) continue;
      const [, entry, name] = match;
      found.add(`${name}@${entry.slice(name.replace('/', '+').length + 1).split('_')[0]}`);
    }
  }
  return found;
}

/**
 * Runs the bundle at `file` from `cwd`, sends the MCP handshake and a tool listing, closes stdin and
 * resolves with the two answers, the exit code and what it wrote to stderr.
 */
function driveBundle(file, cwd, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the bundle did not finish within ${RUN_TIMEOUT_MS} ms\nstderr: ${stderr}\nstdout: ${stdout}`));
    }, RUN_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const answers = stdout.split('\n').filter(Boolean);
      // Both answers are in: the agent is gone, so close stdin.
      if (answers.length >= 2 && child.stdin.writable) child.stdin.end();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveRun({ answers: stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)), code, stderr });
    });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge-artifact-contract', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });
}

describe(
  RUN ? 'bridge artifact contract' : 'bridge artifact contract (skipped: set RUN_CONTRACT_TESTS=1)',
  { skip: !RUN },
  () => {
    let workDir;
    let artifactDir;
    let metafile;
    let embedded;
    const manifest = JSON.parse(readFileSync(join(BRIDGE_ROOT, 'package.json'), 'utf8'));

    // Build the artifact ONCE into a temp dir, shared by every assertion below.
    before(
      async () => {
        workDir = mkdtempSync(join(tmpdir(), 'bridge-artifact-contract-'));
        artifactDir = join(workDir, 'artifact');
        const metafilePath = join(workDir, 'metafile.json');
        execFileSync('pnpm', ['--filter', '@retirement/mcp-bridge', 'build'], {
          cwd: REPO_ROOT,
          env: { ...process.env, BRIDGE_BUNDLE_OUTPUT_DIR: artifactDir, BRIDGE_BUNDLE_METAFILE: metafilePath },
          stdio: 'pipe',
          timeout: BUILD_TIMEOUT_MS,
        });
        metafile = JSON.parse(readFileSync(metafilePath, 'utf8'));
        const { embeddedPackages } = await import(pathToFileURL(join(BRIDGE_ROOT, 'scripts', 'build-bundle.mjs')).href);
        embedded = embeddedPackages(metafile, BRIDGE_ROOT);
      },
      { timeout: BUILD_TIMEOUT_MS },
    );

    after(() => {
      if (workDir) rmSync(workDir, { recursive: true, force: true });
    });

    test('the output directory holds exactly the bundle and the notices', () => {
      assert.deepEqual(readdirSync(artifactDir).sort(), [NOTICES, BUNDLE].sort());
    });

    test('the bundle starts with a Node shebang, is executable and has no source map', () => {
      const file = join(artifactDir, BUNDLE);
      const text = readFileSync(file, 'utf8');
      assert.equal(text.split('\n')[0], '#!/usr/bin/env node');
      assert.ok((statSync(file).mode & 0o111) !== 0, 'the executable bit is set');
      assert.ok(!text.includes('sourceMappingURL'), 'no source map reference');
    });

    test('the bundle stays under the size ceiling', () => {
      const size = statSync(join(artifactDir, BUNDLE)).size;
      assert.ok(size < MAX_BUNDLE_BYTES, `bundle is ${size} bytes, the ceiling is ${MAX_BUNDLE_BYTES}`);
    });

    test('alone in an empty directory it answers initialize and tools/list and exits cleanly on stdin close', async () => {
      const lonely = mkdtempSync(join(tmpdir(), 'bridge-artifact-run-'));
      try {
        const file = join(lonely, BUNDLE);
        copyFileSync(join(artifactDir, BUNDLE), file);
        assert.deepEqual(readdirSync(lonely), [BUNDLE], 'nothing beside the bundle, in particular no node_modules');
        const port = await freePort();
        const { answers, code, stderr } = await driveBundle(file, lonely, ['--origin', 'https://example.test', '--port', String(port)]);
        const init = answers.find((a) => a.id === 1);
        const list = answers.find((a) => a.id === 2);
        assert.equal(init?.result?.serverInfo?.version, manifest.version);
        const { TOOL_REGISTRY } = await import(pathToFileURL(join(REPO_ROOT, 'packages', 'assistant-protocol', 'dist', 'index.js')).href);
        const names = list.result.tools.map((tool) => tool.name);
        assert.ok(names.length > 0);
        assert.deepEqual(names, TOOL_REGISTRY.map((entry) => entry.name));
        assert.equal(code, 0, stderr);
      } finally {
        rmSync(lonely, { recursive: true, force: true });
      }
    });

    test('every package esbuild bundled is the version the workspace resolved and the lockfile pins', () => {
      const lockfile = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8').split('\n').map((line) => line.trim());
      assert.ok(embedded.size > 0);
      for (const { name, version, dir, via } of embedded.values()) {
        if (dir !== null) {
          // The metafile path names the pnpm store entry, `<name>@<version>`, the build embedded.
          assert.ok(dir.includes(`${name.replace('/', '+')}@${version}`), `${name}: ${dir} is not the ${version} store entry`);
        }
        // A package the SDK ships pre-bundled is whatever that SDK release carries; the workspace's
        // lockfile does not decide it.
        if (via !== null) continue;
        assert.ok(
          lockfile.some((line) => line === `${name}@${version}:` || line === `'${name}@${version}':`),
          `${name}@${version} is not pinned in pnpm-lock.yaml`,
        );
      }
      for (const direct of ['@modelcontextprotocol/server', 'ws']) {
        assert.ok(
          embedded.has(`${direct}@${manifest.devDependencies[direct]}`),
          `${direct} is not embedded at ${manifest.devDependencies[direct]}`,
        );
      }
    });

    test('the optional ws natives are neither embedded nor bundled', () => {
      for (const native of OPTIONAL_NATIVES) {
        assert.ok(![...embedded.values()].some(({ name }) => name === native), `${native} is embedded`);
        assert.ok(
          !Object.keys(metafile.inputs).some((input) => input.includes(`node_modules/${native}/`)),
          `${native} appears among the bundle's inputs`,
        );
      }
    });

    test('the notices name every embedded package with its license and copyright, and only those', () => {
      const text = readFileSync(join(artifactDir, NOTICES), 'utf8');
      const blocks = text.split('='.repeat(72)).slice(1);
      const headed = new Map();
      for (let i = 0; i < blocks.length; i += 1) {
        const lines = blocks[i].trim().split('\n');
        const heading = lines[0];
        if (!/^(@[^/\s]+\/)?[^@\s]+@\d+\.\d+\.\d+\S*$/.test(heading)) continue;
        headed.set(heading, lines.slice(1));
      }
      assert.deepEqual([...headed.keys()].sort(), [...embedded.keys()].sort());
      // The packages the SDK ships pre-bundled (ajv, fast-uri, ...) must be there too: the source maps
      // of the chunks that reach the output are an inventory the notices generator did not make.
      const fromMaps = packagesFromSourceMaps(metafile);
      assert.ok(fromMaps.size > 0, 'the SDK chunks carry source maps to inventory');
      for (const key of fromMaps) assert.ok(headed.has(key), `${key} is embedded in the bundle but missing from the notices`);
      for (const [heading, lines] of headed) {
        assert.ok(lines.some((line) => /^License: \S+/.test(line)), `${heading} has no license identifier`);
        assert.ok(lines.some((line) => /^Copyright: .*\b(19|20)\d\d\b/.test(line)), `${heading} has no copyright line`);
      }
    });

    test("the bundle file itself carries every embedded package's notice, so the copy a person keeps does", () => {
      const bundle = readFileSync(join(artifactDir, BUNDLE), 'utf8');
      const notices = readFileSync(join(artifactDir, NOTICES), 'utf8');
      // The trailing comment is the notices file, line for line.
      const trailing = bundle.slice(bundle.lastIndexOf('\n// ===== Third-party notices'));
      const carried = trailing.trim().split('\n').slice(1).map((line) => line.replace(/^\/\/ ?/, '')).join('\n');
      assert.equal(carried.trimEnd(), notices.trimEnd());
      for (const key of embedded.keys()) {
        const heading = new RegExp(`^// ${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
        assert.ok(heading.test(bundle), `${key}'s notice is not in the bundle`);
      }
      // The license texts themselves, not only the headings.
      assert.ok(/Permission is hereby granted, free of charge/.test(bundle), 'an MIT license text is in the bundle');
      assert.ok(/Redistributions in binary form must reproduce the above copyright/.test(bundle.replaceAll('\n// ', ' ')), 'the BSD-3-Clause text of fast-uri is in the bundle');
    });

    test('npm pack lists exactly the allowlisted files, and the packed manifest installs nothing', () => {
      // Stage the package as it would be packed: the manifest, README and LICENSE from the workspace,
      // and the build output from this run's artifact directory.
      const staged = join(workDir, 'staged');
      mkdirSync(join(staged, 'build'), { recursive: true });
      for (const file of ['package.json', 'README.md', 'LICENSE']) copyFileSync(join(BRIDGE_ROOT, file), join(staged, file));
      cpSync(artifactDir, join(staged, 'build'), { recursive: true });
      const [packed] = JSON.parse(
        execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: staged, encoding: 'utf8' }),
      );
      const listed = packed.files.map((file) => file.path).sort();
      assert.deepEqual(listed, [...manifest.files, 'package.json'].sort());

      const stagedManifest = JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8'));
      assert.equal(stagedManifest.dependencies, undefined, 'no runtime dependencies');
      for (const script of ['preinstall', 'install', 'postinstall']) {
        assert.equal(stagedManifest.scripts?.[script], undefined, `${script} script`);
      }
      for (const target of Object.values(stagedManifest.bin)) {
        assert.ok(listed.includes(target), `bin target ${target} is in the package`);
      }
    });

    test("the package's LICENSE is the repository's", () => {
      assert.equal(readFileSync(join(BRIDGE_ROOT, 'LICENSE'), 'utf8'), readFileSync(join(REPO_ROOT, 'LICENSE'), 'utf8'));
    });
  },
);
