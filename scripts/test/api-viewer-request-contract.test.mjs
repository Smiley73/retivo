// The `/api/*` behavior must run the viewer-address function on every stack, gated or not, and keep the managed policy that forwards the headers it writes.
// Text contract over cloudfront.ts: assertions anchor on the behavior block with comments stripped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, '../../infrastructure/src/cloudfront.ts'), 'utf8')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n');

// From the /api/* pathPattern to the end of its functionAssociations array.
function apiBehavior() {
  const start = source.indexOf('pathPattern: "/api/*"');
  assert.notEqual(start, -1, 'cloudfront.ts must declare the /api/* behavior');
  const end = source.indexOf('],', source.indexOf('functionAssociations', start));
  assert.notEqual(end, -1, 'the /api/* functionAssociations must be closed');
  return source.slice(start, end);
}

test('the /api/* viewer-request association does not depend on the allowlist', () => {
  const block = apiBehavior();
  const associations = block.slice(block.indexOf('functionAssociations'));
  assert.match(associations, /eventType:\s*"viewer-request",\s*functionArn:\s*apiViewerRequestFn\.arn/);
  assert.doesNotMatch(associations, /gated|edgeAllowedIps|\?|&&|\.\.\./, 'the association must be unconditional');
});

test('the apiViewerRequestFn resource is created unconditionally', () => {
  assert.match(source, /^\s*const apiViewerRequestFn = new aws\.cloudfront\.Function\(/m);
});

test('the /api/* behavior still forwards viewer headers with Managed-AllViewerExceptHostHeader', () => {
  assert.match(apiBehavior(), /originRequestPolicyId:\s*managedOriginRequestPolicyId\(\s*"Managed-AllViewerExceptHostHeader"\s*,?\s*\)/);
});
