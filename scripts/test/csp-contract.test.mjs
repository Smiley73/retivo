// CSP of the CloudFront security-headers function: the stack-gated `ws://127.0.0.1:<port>` entry (absent by default) plus the style-src and script-src directives the UI and Argon2id WASM need.
// Imports the protocol package's built `dist` by relative path, since infrastructure is CommonJS and formats the entry itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLOUDFRONT_FUNCTION_MAX_BYTES,
  assertFunctionSize,
  securityHeadersCode,
} from '../../infrastructure/src/edge-functions.mjs';

const { DEFAULT_BRIDGE_PORT, loopbackWsUrl } = await import(
  '../../packages/assistant-protocol/dist/index.js'
).catch((error) => {
  throw new Error(
    'packages/assistant-protocol/dist is missing or stale — run `pnpm install` ' +
      `(its prepare script builds it). Cause: ${error.message}`,
  );
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const INFRA_SRC = resolve(__dirname, '../../infrastructure/src');
const CLOUDFRONT_SOURCE = readFileSync(resolve(INFRA_SRC, 'cloudfront.ts'), 'utf8');
// Scanned too so the 'unsafe-eval' guard covers all function code the edge publishes.
const EDGE_FUNCTIONS_SOURCE = readFileSync(resolve(INFRA_SRC, 'edge-functions.mjs'), 'utf8');

/** Compile generated function source and return its `handler`. */
function compile(code) {
  // eslint-disable-next-line no-new-func -- the point is to execute the emitted code
  return new Function(`${code};return handler;`)();
}

/** Run the generated handler on an S3-style response (no CSP) and return the response. */
function respond(code, headers = {}) {
  return compile(code)({ response: { statusCode: 200, headers: { ...headers } } }).headers;
}

/** The CSP the stack emits today, directive by directive. */
const TODAY_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
];

function directivesOf(headers) {
  return headers['content-security-policy'].value.split('; ');
}

// Pinned byte for byte, comments included: a reordered or re-commented function would make `pulumi preview` show an update on an unchanged stack.
const TODAY_SOURCE = [
  'function handler(event) {',
  '  var response = event.response;',
  '  var headers = response.headers;',
  '',
  "  headers['strict-transport-security'] = {",
  "    value: 'max-age=63072000; includeSubDomains; preload'",
  '  };',
  "  headers['x-content-type-options'] = { value: 'nosniff' };",
  "  headers['referrer-policy'] = { value: 'same-origin' };",
  "  headers['permissions-policy'] = {",
  "    value: 'camera=(), microphone=(), geolocation=()'",
  '  };',
  '',
  "  if (!headers['content-security-policy']) {",
  "    headers['content-security-policy'] = {",
  '      value: [',
  '        "default-src \'self\'",',
  "        // 'wasm-unsafe-eval' permits WebAssembly compilation only (NOT JS",
  '        // eval) for the Argon2id HDK key-wrapping WASM module (hash-wasm).',
  '        // The binary is base64-embedded in the JS',
  '        // bundle at build time — no runtime fetch, so no connect-src/worker-src',
  '        // change is needed beyond this one directive.',
  '        "script-src \'self\' \'wasm-unsafe-eval\'",',
  '        "style-src \'self\' \'unsafe-inline\'",',
  '        "img-src \'self\' data:",',
  '        "font-src \'self\' data:",',
  '        "connect-src \'self\'",',
  '        "object-src \'none\'",',
  '        "frame-ancestors \'none\'",',
  '        "base-uri \'self\'",',
  '        "form-action \'self\'"',
  "      ].join('; ')",
  '    };',
  '  }',
  '  return response;',
  '}',
].join('\n');

// --- off branch: today's behaviour, unchanged -------------------------------

test('security headers (feature off) — generated source is byte-identical to the previously inlined function', () => {
  assert.equal(securityHeadersCode(), TODAY_SOURCE);
  assert.equal(securityHeadersCode(undefined), TODAY_SOURCE);
});

test('security headers (feature off) — the executed handler sets today\'s CSP, with no ws anywhere', () => {
  const headers = respond(securityHeadersCode());
  assert.deepEqual(directivesOf(headers), TODAY_DIRECTIVES);
  assert.doesNotMatch(headers['content-security-policy'].value, /ws/i);
});

test('SPA CSP allows inline styles (Tailwind/React Aria dependency)', () => {
  for (const port of [undefined, DEFAULT_BRIDGE_PORT]) {
    assert.ok(
      directivesOf(respond(securityHeadersCode(port))).includes("style-src 'self' 'unsafe-inline'"),
      "the SPA CSP must emit `style-src 'self' 'unsafe-inline'` — Tailwind v4 + " +
        'React Aria inline component positioning relies on it',
    );
  }
});

test('SPA CSP keeps script-src strict with WASM-only eval (XSS posture)', () => {
  for (const port of [undefined, DEFAULT_BRIDGE_PORT]) {
    const headers = respond(securityHeadersCode(port));
    const csp = headers['content-security-policy'].value;
    assert.ok(
      directivesOf(headers).includes("script-src 'self' 'wasm-unsafe-eval'"),
      "the SPA CSP must emit `script-src 'self' 'wasm-unsafe-eval'` — " +
        "'wasm-unsafe-eval' (WASM compile only) is required for the Argon2id " +
        'key-wrapping WASM module',
    );
    // Plain 'unsafe-eval' (arbitrary JS eval) must be absent.
    assert.doesNotMatch(csp, /(?<!wasm-)unsafe-eval/);
  }
});

test('cloudfront.ts and edge-functions.mjs never contain the insecure unsafe-eval', () => {
  // `'wasm-unsafe-eval'` is the one allowed spelling.
  for (const [name, source] of [
    ['cloudfront.ts', CLOUDFRONT_SOURCE],
    ['edge-functions.mjs', EDGE_FUNCTIONS_SOURCE],
  ]) {
    assert.doesNotMatch(
      source,
      /'unsafe-eval'/,
      `${name} must NOT contain the insecure \`'unsafe-eval'\` — only the granular \`'wasm-unsafe-eval'\` is permitted`,
    );
  }
});

// --- on branch: exactly one stack-gated entry -------------------------------

for (const port of [DEFAULT_BRIDGE_PORT, 24581, 1024, 65535]) {
  test(`security headers (port ${port}) — connect-src gains exactly the loopbackWsUrl entry`, () => {
    const code = securityHeadersCode(port);
    const directives = directivesOf(respond(code));
    const entry = loopbackWsUrl(port);
    assert.deepEqual(
      directives.map((d) => (d.startsWith('connect-src') ? 'connect-src' : d)),
      TODAY_DIRECTIVES.map((d) => (d.startsWith('connect-src') ? 'connect-src' : d)),
      'only the connect-src directive may differ from the feature-off CSP',
    );
    assert.ok(directives.includes(`connect-src 'self' ${entry}`), directives.join('; '));
    const csp = directives.join('; ');
    // No scheme-only source (`ws:`, `wss:`), wildcard or hostname form.
    assert.doesNotMatch(csp, /(?:^|\s)wss?:(?:\s|;|$)|\bwss:|\blocalhost\b|\*/);
    assert.equal(csp.split(entry).length, 2, 'the loopback entry appears exactly once');
    assert.doesNotThrow(() => assertFunctionSize(code, 'security-headers'));
    assert.ok(Buffer.byteLength(code, 'utf8') < CLOUDFRONT_FUNCTION_MAX_BYTES);
  });
}

test('security headers (feature on) — the emitted source differs from the off source only on the connect-src line', () => {
  const off = securityHeadersCode().split('\n');
  const on = securityHeadersCode(DEFAULT_BRIDGE_PORT).split('\n');
  assert.equal(on.length, off.length);
  const changed = on.filter((line, i) => line !== off[i]);
  assert.deepEqual(changed, [`        "connect-src 'self' ${loopbackWsUrl(DEFAULT_BRIDGE_PORT)}",`]);
});

test('security headers (feature on) — a response that already carries a CSP (the API case) is left alone', () => {
  const helmet = { value: "default-src 'self'" };
  for (const port of [undefined, DEFAULT_BRIDGE_PORT]) {
    const headers = respond(securityHeadersCode(port), { 'content-security-policy': helmet });
    assert.deepEqual(headers['content-security-policy'], helmet);
    assert.equal(headers['x-content-type-options'].value, 'nosniff');
  }
});

test('securityHeadersCode — refuses a port the config parser would refuse, naming the key', () => {
  for (const bad of [0, 80, 1023, 65536, 24580.5, NaN, Infinity, -1, '24580', null, {}]) {
    assert.throws(
      () => securityHeadersCode(bad),
      /retivo:assistantBridgePort/,
      `port ${String(bad)} must not reach the published function`,
    );
  }
});
