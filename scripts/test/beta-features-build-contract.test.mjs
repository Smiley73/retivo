// Deploy contract for the stack-driven SPA build config: `build_spa` in
// infrastructure/scripts/lib/deploy-common.sh reads two optional Pulumi stack
// keys and bakes them into the bundle.
//
//   - `retivo:betaFeatures` -> VITE_BETA_FEATURES via `resolve_beta_features`.
//     A genuinely *missing* key defaults to `all`; any other `pulumi config get`
//     failure aborts, and an id the registry
//     (apps/web/src/lib/feature-flags.ts) does not know is rejected.
//   - `retivo:assistantBridgePort` -> VITE_ASSISTANT_BRIDGE_PORT via
//     `resolve_assistant_bridge_port`. A missing key means OFF: the build gets
//     no such variable at all (not an empty one). The CSP entry the same key
//     adds is pinned in csp-contract.test.mjs.
//
// Runs the real shell function under bash with `pulumi` and `pnpm` replaced by
// stub executables on PATH — no Pulumi runtime, no AWS, no build. The stubbed
// `pulumi` answers `config get retivo:<key>` per key; the stubbed `pnpm`
// records the environment it was invoked with. Runs under `pnpm test:scripts`.

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

/**
 * Run `build_spa dev` with a stub `pulumi` that answers `config get
 * retivo:<key>` from `answers` (`{ betaFeatures, assistantBridgePort }`, each
 * `{ stdout, stderr, exit }`); a key with no entry is "not found", like a
 * stack that never set it. The stub `pnpm` dumps its env. `ambient` adds
 * variables to the operator's shell. Returns the spawn result, the baked env
 * (null when the build never ran) and the keys `pulumi` was asked for.
 */
function runBuildSpa(answers = {}, ambient = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'beta-build-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const envDump = join(dir, 'env.txt');
  const asked = join(dir, 'asked.txt');
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
  writeFileSync(join(bin, 'pnpm'), `#!/usr/bin/env bash\nenv > ${JSON.stringify(envDump)}\n`);
  chmodSync(join(bin, 'pulumi'), 0o755);
  chmodSync(join(bin, 'pnpm'), 0o755);
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
  rmSync(dir, { recursive: true, force: true });
  return { ...result, env, keys };
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
  assert.deepEqual(ids.sort(), ['guardrails', 'projected-withdrawals']);
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
