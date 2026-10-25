// `PLACEHOLDER` in infrastructure/src/ssm.ts and `EDGE_SHARED_SECRET_PLACEHOLDER` in apps/api/src/common/env.config.ts must match byte-for-byte.
// The api bundle cannot import the Pulumi-only package, and drift would fail open or closed on a real deploy.

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

/** The string literal assigned to `const <varName> = "...";` in source text; the value may wrap onto the next line. */
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
