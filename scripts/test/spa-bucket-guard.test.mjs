// infrastructure/src/spa-hosting.ts is read as text: `protect: true` and `forceDestroy: false` are declared unconditionally,
// with no conditional token that could scope them to one stack.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPA_HOSTING = readFileSync(resolve(__dirname, '../../infrastructure/src/spa-hosting.ts'), 'utf8');

/** Strip comments: the declaration's own prose says "every stack" and quotes `protect: true`. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The SPA bucket's own `new aws.s3.Bucket(...)` call, from its name token through the closing `);`, comments stripped. */
function spaBucketDeclaration() {
  const marker = '`${namePrefix}-spa`';
  const at = SPA_HOSTING.indexOf(marker);
  assert.notEqual(at, -1, 'the SPA bucket resource (`${namePrefix}-spa`) must exist in spa-hosting.ts');
  const end = SPA_HOSTING.indexOf(');', at);
  assert.notEqual(end, -1, 'the SPA bucket declaration must close with a `);`');
  return stripComments(SPA_HOSTING.slice(at, end));
}

// A conditional token on any of these would scope the guard to one stack (e.g. `protect: stack === "prod"`).
const CONDITIONAL_TOKENS = [/\bstack\b/, /\bisProd\b/, /\?\s*[^:]+:/, /\bnamePrefix\s*===/];

function assertUnconditional(slice, label) {
  for (const re of CONDITIONAL_TOKENS) {
    assert.doesNotMatch(
      slice,
      re,
      `${label} must be declared unconditionally — no stack/isProd/ternary/namePrefix-comparison token near it (found ${re})`,
    );
  }
}

test('the SPA bucket declares protect: true', () => {
  const decl = spaBucketDeclaration();
  assert.match(decl, /protect:\s*true/, '`protect: true` must be present in the SPA bucket declaration');
});

test('the SPA bucket declares forceDestroy: false', () => {
  const decl = spaBucketDeclaration();
  assert.match(decl, /forceDestroy:\s*false/, '`forceDestroy: false` must be present in the SPA bucket declaration');
});

test('protect: true is unconditional — no stack/isProd/ternary/namePrefix gate anywhere in the declaration', () => {
  // The whole declaration, not just around `protect:`: a gate elsewhere in the same options object would still defeat it.
  assertUnconditional(spaBucketDeclaration(), 'protect: true');
});

test('forceDestroy: false is unconditional — no stack/isProd/ternary/namePrefix gate anywhere in the declaration', () => {
  assertUnconditional(spaBucketDeclaration(), 'forceDestroy: false');
});

test('the aliases entry survives in the same resource-options object', () => {
  const decl = spaBucketDeclaration();
  assert.match(
    decl,
    /aliases:\s*\[\s*\{\s*type:\s*"aws:s3\/bucketV2:BucketV2"\s*\}\s*\]/,
    'the v6→v7 BucketV2 alias must still be present — dropping it would destroy and recreate the live bucket',
  );
});
