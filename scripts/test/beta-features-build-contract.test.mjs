// Deploy contract for `build_spa` (infrastructure/scripts/lib/deploy-common.sh): the stack keys `retivo:betaFeatures` and
// `retivo:assistantBridgePort` become VITE_* build variables. Runs the real shell function with `pulumi` and `pnpm` stubbed on PATH.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const DEPLOY_COMMON = resolve(REPO_ROOT, 'infrastructure/scripts/lib/deploy-common.sh');

const NOT_FOUND = (key) => ({
  exit: 255,
  stderr: `error: configuration key 'retivo:${key}' not found for stack 'dev'`,
});

/** Run `build_spa dev`: stub `pulumi` answers `config get retivo:<key>` from `answers` (a missing key is "not found"); stub `pnpm` dumps the web build's env. */
function runBuildSpa(answers = {}, ambient = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'beta-build-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const envDump = join(dir, 'env.txt');
  const asked = join(dir, 'asked.txt');
  const calls = join(dir, 'calls.txt');
  const bridgeOutDump = join(dir, 'bridge-out.txt');
  const cases = ['betaFeatures', 'assistantBridgePort']
    .map((key) => {
      const a = answers[key] ?? NOT_FOUND(key);
      return `  retivo:${key}) printf '%s\\n' ${JSON.stringify(a.stdout ?? '')}; printf '%s' ${JSON.stringify(a.stderr ?? '')} >&2; exit ${a.exit ?? 0} ;;`;
    })
    .join('\n');
  writeFileSync(
    join(bin, 'pulumi'),
    `#!/usr/bin/env bash\necho "$3" >> ${JSON.stringify(asked)}\ncase "$3" in\n${cases}\n  *) echo "unexpected pulumi call: $*" >&2; exit 99 ;;\nesac\n`,
  );
  // Every pnpm call is logged; only the web build's environment is kept (the bridge build follows it).
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/usr/bin/env bash\necho "pnpm $*" >> ${JSON.stringify(calls)}\ncase "$*" in\n  *@retirement/web*) env > ${JSON.stringify(envDump)} ;;\n  *@retirement/mcp-bridge*) echo "\${BRIDGE_BUNDLE_OUTPUT_DIR-unset}" > ${JSON.stringify(bridgeOutDump)} ;;\nesac\n`,
  );
  // The staging script runs under node; record its arguments instead of running it.
  writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash\necho "node $*" >> ${JSON.stringify(calls)}\n`);
  for (const name of ['pulumi', 'pnpm', 'node']) chmodSync(join(bin, name), 0o755);
  const scriptEnv = { ...process.env, ...ambient, PATH: `${bin}:${process.env.PATH}` };
  const script = `set -e; INFRA_DIR=${JSON.stringify(resolve(REPO_ROOT, 'infrastructure'))}; REPO_ROOT=${JSON.stringify(REPO_ROOT)}; BUILD_ID=test; source ${JSON.stringify(DEPLOY_COMMON)}; build_spa dev`;
  const result = spawnSync('bash', ['-c', script], {
    env: scriptEnv,
    encoding: 'utf8',
  });
  const read = (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };
  const env = read(envDump);
  const keys = (read(asked) ?? '').split('\n').filter(Boolean);
  const callLog = (read(calls) ?? '').split('\n').filter(Boolean);
  const bridgeOut = (read(bridgeOutDump) ?? '').trim();
  rmSync(dir, { recursive: true, force: true });
  return { ...result, env, keys, calls: callLog, bridgeOut };
}

function bakedValue(env, name = 'VITE_BETA_FEATURES') {
  const line = env.split('\n').find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1) : null;
}

test('a configured value is baked into the SPA build as VITE_BETA_FEATURES', () => {
  const r = runBuildSpa({ betaFeatures: { stdout: 'guardrails' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(bakedValue(r.env), 'guardrails');
  assert.match(r.stdout, /VITE_BETA_FEATURES=guardrails/);
});

test('a missing key defaults to `all`', () => {
  const r = runBuildSpa({ betaFeatures: NOT_FOUND('betaFeatures') });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(bakedValue(r.env), 'all');
});

test('any other pulumi failure aborts the build instead of defaulting to `all`', () => {
  const r = runBuildSpa({ betaFeatures: { exit: 255, stderr: 'error: passphrase must be set' } });
  assert.notEqual(r.status, 0);
  assert.equal(r.env, null, 'pnpm build must not run');
  assert.match(r.stderr, /could not read retivo:betaFeatures/);
  assert.match(r.stderr, /passphrase/);
});

test('an unknown feature id in the stack config fails the deploy loud', () => {
  const r = runBuildSpa({ betaFeatures: { stdout: 'guardrails,guardrail' } });
  assert.notEqual(r.status, 0);
  assert.equal(r.env, null, 'pnpm build must not run');
  assert.match(r.stderr, /unknown beta feature 'guardrail'/);
});

test('the registry ids the validator reads match the source of truth', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'apps/web/src/lib/feature-flags.ts'), 'utf8');
  const ids = [...source.matchAll(/^\s*id: '([a-z0-9-]+)',$/gm)].map((m) => m[1]);
  assert.deepEqual(ids.sort(), ['ai-assistants', 'guardrails', 'projected-withdrawals']);
});

// --- retivo:assistantBridgePort -> VITE_ASSISTANT_BRIDGE_PORT -----------------

test('a missing assistantBridgePort key leaves the connector OFF: no VITE_ASSISTANT_BRIDGE_PORT line at all', () => {
  const r = runBuildSpa();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.env, /^VITE_ASSISTANT_BRIDGE_PORT/m, 'not even an empty variable');
  assert.equal(bakedValue(r.env), 'all', 'the beta-features knob is unchanged');
  assert.doesNotMatch(r.stdout, /VITE_ASSISTANT_BRIDGE_PORT/);
  assert.deepEqual(r.keys.sort(), ['retivo:assistantBridgePort', 'retivo:betaFeatures']);
});

test('a stack without the bridge port serves no bridge file: the bridge is not built or staged', () => {
  const r = runBuildSpa();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 1, `only the web build runs, got ${JSON.stringify(r.calls)}`);
  assert.match(r.calls[0], /@retirement\/web build$/);
  assert.doesNotMatch(r.stdout, /bridge file/);
});

test('a blank assistantBridgePort value is the same as a missing key', () => {
  const r = runBuildSpa({ assistantBridgePort: { stdout: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.env, /^VITE_ASSISTANT_BRIDGE_PORT/m);
});

test('an ambient VITE_ASSISTANT_BRIDGE_PORT cannot leak into a build whose stack leaves the connector off', () => {
  const r = runBuildSpa({}, { VITE_ASSISTANT_BRIDGE_PORT: '24580' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.env, /^VITE_ASSISTANT_BRIDGE_PORT/m);
});

for (const [stdout, baked] of [
  ['24580', '24580'],
  ['24581', '24581'],
  [' 1024 ', '1024'],
  ['65535', '65535'],
  ['08000', '8000'], // leading zeros are normalised, never read as octal
]) {
  test(`a set assistantBridgePort ${JSON.stringify(stdout)} is baked as VITE_ASSISTANT_BRIDGE_PORT=${baked} and echoed`, () => {
    const r = runBuildSpa({
      betaFeatures: { stdout: 'guardrails' },
      assistantBridgePort: { stdout },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(bakedValue(r.env, 'VITE_ASSISTANT_BRIDGE_PORT'), baked);
    assert.match(r.stdout, new RegExp(`VITE_ASSISTANT_BRIDGE_PORT=${baked} \\(retivo:assistantBridgePort\\)`));
    assert.equal(bakedValue(r.env), 'guardrails', 'the beta-features knob is unaffected');
  });
}

test('a stack with the bridge port builds the bridge after the SPA and stages it into the SPA dist', () => {
  const r = runBuildSpa({ assistantBridgePort: { stdout: '24580' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 3, JSON.stringify(r.calls));
  assert.match(r.calls[0], /@retirement\/web build$/, 'the SPA build comes first: it empties dist/');
  assert.match(r.calls[1], /@retirement\/assistant-protocol --filter @retirement\/mcp-bridge run build$/);
  assert.equal(r.calls[2], 'node scripts/stage-bridge-bundle.mjs apps/mcp-bridge/build apps/web/dist');
  assert.match(r.stdout, /Building the bridge file this site serves/);
});

test('an ambient bridge output directory cannot redirect the bridge build of a deploy', () => {
  const r = runBuildSpa({ assistantBridgePort: { stdout: '24580' } }, { BRIDGE_BUNDLE_OUTPUT_DIR: '/somewhere/else' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls[2], 'node scripts/stage-bridge-bundle.mjs apps/mcp-bridge/build apps/web/dist');
  assert.equal(r.bridgeOut, 'unset', 'the bridge build never sees the ambient directory');
});

for (const bad of ['24580.5', 'abc', '80', '1023', '65536', '0', '0x6004', '-24580', '24 580', '1e4', '99999999999999999999']) {
  test(`assistantBridgePort ${JSON.stringify(bad)} aborts before the build runs`, () => {
    const r = runBuildSpa({ assistantBridgePort: { stdout: bad } });
    assert.notEqual(r.status, 0);
    assert.equal(r.env, null, 'pnpm build must not run');
    assert.match(r.stderr, /retivo:assistantBridgePort must be an integer from 1024 to 65535/);
  });
}

test('a pulumi failure other than "not found" on assistantBridgePort aborts naming the key', () => {
  const r = runBuildSpa({ assistantBridgePort: { exit: 255, stderr: 'error: passphrase must be set' } });
  assert.notEqual(r.status, 0);
  assert.equal(r.env, null, 'pnpm build must not run');
  assert.match(r.stderr, /could not read retivo:assistantBridgePort/);
  assert.match(r.stderr, /passphrase/);
});
