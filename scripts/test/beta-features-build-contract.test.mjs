// Deploy contract for the beta-feature build config: `build_spa` in
// infrastructure/scripts/lib/deploy-common.sh must bake a beta-features value
// into VITE_BETA_FEATURES, abort on any `pulumi config get` failure other
// than a missing key, and reject an id the registry
// (apps/web/src/lib/feature-flags.ts) does not know.
//
// `build_spa <stack>` reads the `retivo:betaFeatures` Pulumi stack config via
// `resolve_beta_features`. A genuinely *missing* Pulumi key defaults to `all`.
//
// Runs the real shell function under bash with `pulumi` and `pnpm` replaced by
// stub executables on PATH — no Pulumi runtime, no AWS, no build. The stubbed
// `pnpm` records the environment it was invoked with. Runs under
// `pnpm test:scripts`.

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

/**
 * Run `build_spa dev` with a stub `pulumi` whose `config get` behaves per
 * `pulumi` (exit code + stdout/stderr) and a stub `pnpm` that dumps its env.
 * Returns the spawn result plus the baked env (null when the build never ran).
 */
function runBuildSpa(pulumi) {
  const dir = mkdtempSync(join(tmpdir(), 'beta-build-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const envDump = join(dir, 'env.txt');
  writeFileSync(
    join(bin, 'pulumi'),
    `#!/usr/bin/env bash\nprintf '%s' ${JSON.stringify(pulumi.stdout ?? '')}\nprintf '%s' ${JSON.stringify(pulumi.stderr ?? '')} >&2\nexit ${pulumi.exit ?? 0}\n`,
  );
  writeFileSync(join(bin, 'pnpm'), `#!/usr/bin/env bash\nenv > ${JSON.stringify(envDump)}\n`);
  chmodSync(join(bin, 'pulumi'), 0o755);
  chmodSync(join(bin, 'pnpm'), 0o755);
  const scriptEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const script = `set -e; INFRA_DIR=${JSON.stringify(resolve(REPO_ROOT, 'infrastructure'))}; REPO_ROOT=${JSON.stringify(REPO_ROOT)}; BUILD_ID=test; source ${JSON.stringify(DEPLOY_COMMON)}; build_spa dev`;
  const result = spawnSync('bash', ['-c', script], {
    env: scriptEnv,
    encoding: 'utf8',
  });
  let env = null;
  try {
    env = readFileSync(envDump, 'utf8');
  } catch {
    env = null;
  }
  rmSync(dir, { recursive: true, force: true });
  return { ...result, env };
}

function bakedValue(env) {
  const line = env.split('\n').find((l) => l.startsWith('VITE_BETA_FEATURES='));
  return line ? line.slice('VITE_BETA_FEATURES='.length) : null;
}

test('a configured value is baked into the SPA build as VITE_BETA_FEATURES', () => {
  const r = runBuildSpa({ stdout: 'guardrails' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(bakedValue(r.env), 'guardrails');
  assert.match(r.stdout, /VITE_BETA_FEATURES=guardrails/);
});

test('a missing key defaults to `all`', () => {
  const r = runBuildSpa({
    exit: 255,
    stderr: "error: configuration key 'retivo:betaFeatures' not found for stack 'dev'",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(bakedValue(r.env), 'all');
});

test('any other pulumi failure aborts the build instead of defaulting to `all`', () => {
  const r = runBuildSpa({ exit: 255, stderr: 'error: passphrase must be set' });
  assert.notEqual(r.status, 0);
  assert.equal(r.env, null, 'pnpm build must not run');
  assert.match(r.stderr, /could not read retivo:betaFeatures/);
  assert.match(r.stderr, /passphrase/);
});

test('an unknown feature id in the stack config fails the deploy loud', () => {
  const r = runBuildSpa({ stdout: 'guardrails,guardrail' });
  assert.notEqual(r.status, 0);
  assert.equal(r.env, null, 'pnpm build must not run');
  assert.match(r.stderr, /unknown beta feature 'guardrail'/);
});

test('the registry ids the validator reads match the source of truth', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'apps/web/src/lib/feature-flags.ts'), 'utf8');
  const ids = [...source.matchAll(/^\s*id: '([a-z0-9-]+)',$/gm)].map((m) => m[1]);
  assert.deepEqual(ids.sort(), ['guardrails', 'projected-withdrawals']);
});
