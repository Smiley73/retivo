// Edge-secret placeholder contract guard.
//
// infrastructure/src/ssm.ts's `PLACEHOLDER` literal and
// apps/api/src/common/env.config.ts's `EDGE_SHARED_SECRET_PLACEHOLDER` copy
// must agree byte-for-byte: env.config.ts's deployed-stack superRefine
// treats that exact string as "no secret" for EDGE_SHARED_SECRET, and the
// api bundle cannot import infrastructure/src/ssm.ts (a separate
// Pulumi-only package) to share the constant directly. A drifted copy would
// either fail closed on a properly rotated secret that happens to collide
// with the stale api-side string (spurious boot failure) or, worse, fail
// open by no longer recognizing the actual placeholder Pulumi ships on a
// brand-new, not-yet-bootstrapped stack.
//
// Reads both files as text — no infra runtime, no api runtime, no new
// dependency. Runs under `pnpm test:scripts`. Lives in scripts/test/ (not
// flat scripts/) so Node's test runner does not match the built-in
// `test-*.mjs` discovery glob. Pattern: scripts/test/csp-contract.test.mjs,
// scripts/test/monitoring-contract.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SSM_SRC = readFileSync(
  resolve(__dirname, '../../infrastructure/src/ssm.ts'),
  'utf8',
);
const ENV_CONFIG_SRC = readFileSync(
  resolve(__dirname, '../../apps/api/src/common/env.config.ts'),
  'utf8',
);

/**
 * Extract the string literal assigned to `const <varName> = "...";` (single
 * or double quotes, value may wrap onto the next line) from source text.
 */
function extractLiteral(source, varName, label) {
  const match = source.match(new RegExp(`${varName}\\s*=\\s*(["'])([^"']+)\\1`));
  assert.notEqual(match, null, `${label} must declare ${varName} = "..."`);
  return match[2];
}

test('the Pulumi edge/shared-secret placeholder matches its api-side copy', () => {
  const infraPlaceholder = extractLiteral(
    SSM_SRC,
    'PLACEHOLDER',
    'infrastructure/src/ssm.ts',
  );
  const apiPlaceholder = extractLiteral(
    ENV_CONFIG_SRC,
    'EDGE_SHARED_SECRET_PLACEHOLDER',
    'apps/api/src/common/env.config.ts',
  );
  assert.equal(
    apiPlaceholder,
    infraPlaceholder,
    'apps/api/src/common/env.config.ts EDGE_SHARED_SECRET_PLACEHOLDER must ' +
      'match infrastructure/src/ssm.ts PLACEHOLDER exactly — a drift would ' +
      "make the deployed-stack guard fail to recognize (or misrecognize) " +
      'a real not-yet-rotated placeholder',
  );
});
