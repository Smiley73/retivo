// CSP regression guard. Reads
// infrastructure/src/cloudfront.ts as TEXT and asserts the CloudFront-emitted
// SPA CSP keeps the two directives the Tailwind v4 + React Aria primitive
// layer depends on:
//
//   - `style-src 'self' 'unsafe-inline'`  — Tailwind/React Aria inject
//     component positioning + dev styles inline; tightening this breaks the
//     UI. React Aria injects runtime inline positioning styles for the same
//     reason Headless UI did, so the shipped policy stays valid by the same
//     rationale.
//   - `script-src 'self' 'wasm-unsafe-eval'` — the strict XSS posture MUST
//     stay intact; `'wasm-unsafe-eval'` (WASM compile only) is added for the
//     Argon2id key-wrapping WASM module. The insecure `'unsafe-eval'` (arbitrary JS eval) MUST
//     stay absent; this guards both.
//
// No infra harness, no new dependency, infrastructure/ code untouched. Runs
// under `pnpm test:scripts` (already invoked by `pnpm test`). Lives in
// scripts/test/ (not flat scripts/) so Node's test runner does not match the
// built-in `test-*.mjs` discovery glob. Pattern: scripts/test/affected-core.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLOUDFRONT_SRC = resolve(
  __dirname,
  '../../infrastructure/src/cloudfront.ts',
);
const SOURCE = readFileSync(CLOUDFRONT_SRC, 'utf8');
// The SPA-router / IP-gate CloudFront Function generators live in a sibling
// dependency-free module; scan it too so the 'unsafe-eval' guard covers every
// byte of function code the edge publishes, not just the security-headers one.
const EDGE_FUNCTIONS_SRC = resolve(
  __dirname,
  '../../infrastructure/src/edge-functions.mjs',
);
const EDGE_FUNCTIONS_SOURCE = readFileSync(EDGE_FUNCTIONS_SRC, 'utf8');

test('SPA CSP allows inline styles (Tailwind/React Aria dependency)', () => {
  assert.match(
    SOURCE,
    /["']style-src 'self' 'unsafe-inline'["']/,
    "cloudfront.ts must emit `style-src 'self' 'unsafe-inline'` — Tailwind " +
      'v4 + React Aria inline component positioning relies on it',
  );
});

test('SPA CSP keeps script-src strict with WASM-only eval (XSS posture)', () => {
  assert.match(
    SOURCE,
    /["']script-src 'self' 'wasm-unsafe-eval'["']/,
    "cloudfront.ts must emit `script-src 'self' 'wasm-unsafe-eval'` — " +
      "'wasm-unsafe-eval' (WASM compile only) is required for the Argon2id " +
      'key-wrapping WASM module',
  );
  // The insecure form ('unsafe-eval' = arbitrary JS eval) must NEVER appear.
  assert.doesNotMatch(
    SOURCE,
    /'unsafe-eval'/,
    "cloudfront.ts must NOT contain the insecure `'unsafe-eval'` — only the " +
      "granular `'wasm-unsafe-eval'` is permitted",
  );
});

test('edge-functions.mjs (SPA router + IP gate generators) never emits unsafe-eval', () => {
  assert.doesNotMatch(
    EDGE_FUNCTIONS_SOURCE,
    /'unsafe-eval'/,
    "edge-functions.mjs must NOT contain the insecure `'unsafe-eval'`",
  );
});
