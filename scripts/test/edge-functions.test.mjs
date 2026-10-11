// Runtime tests for the CloudFront Function code cloudfront.ts publishes
// (infrastructure/src/edge-functions.mjs). The generators emit JavaScript
// SOURCE; asserting on the text would not catch a broken handler, so each
// test compiles the generated code with `new Function` and calls the
// resulting `handler` with a fake viewer-request event shaped like
// CloudFront's (`{ viewer: { ip }, request: { uri, headers } }`).
//
// Creds-free, dependency-free (node --test, run under `pnpm test:scripts`).
// Pattern: scripts/test/config-coverage.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLOUDFRONT_FUNCTION_MAX_BYTES,
  assertFunctionSize,
  gateOnlyCode,
  gatedSpaRouterCode,
  spaRouterCode,
} from '../../infrastructure/src/edge-functions.mjs';
import { ipv4CidrToRule } from '../../infrastructure/src/config-helpers.mjs';

/** Compile generated function source and return its `handler`. */
function compile(code) {
  // eslint-disable-next-line no-new-func -- the point is to execute the emitted code
  return new Function(`${code};return handler;`)();
}

function event(ip, uri, headers = {}) {
  const viewer = ip === undefined ? {} : { ip };
  return { viewer, request: { uri, headers, method: 'GET' } };
}

const HOME = ipv4CidrToRule('203.0.113.7/32'); // base >= 128.0.0.0 — sign-bit sensitive
const LAN = ipv4CidrToRule('192.168.1.3/24');
const RULES = [HOME, LAN];

const EXPECTED_403 = {
  statusCode: 403,
  statusDescription: 'Forbidden',
  headers: {
    'content-type': { value: 'text/plain; charset=utf-8' },
    'cache-control': { value: 'no-store' },
  },
  body: { encoding: 'text', data: 'Forbidden' },
};

// --- ungated SPA router (today's behaviour, must not change) -----------------

test('spaRouterCode — rewrites an extension-less SPA route to /index.html', () => {
  const handler = compile(spaRouterCode());
  const out = handler(event('198.51.100.9', '/accounts/123'));
  assert.equal(out.uri, '/index.html');
});

test('spaRouterCode — leaves a static asset URI untouched', () => {
  const handler = compile(spaRouterCode());
  const out = handler(event('198.51.100.9', '/assets/app-abc123.js'));
  assert.equal(out.uri, '/assets/app-abc123.js');
});

test('spaRouterCode — no allowlist code is emitted when ungated', () => {
  assert.doesNotMatch(spaRouterCode(), /ALLOW|FORBIDDEN|viewer/);
});

// Byte-identical to the code cloudfront.ts inlined before the generators moved
// here, so an ungated stack (prod) sees NO spa-router function update on the
// first preview after this change.
test('spaRouterCode — ungated output is byte-identical to the previously inlined function', () => {
  assert.equal(
    spaRouterCode(),
    [
      'function handler(event) {',
      '  var req = event.request;',
      '  var uri = req.uri;',
      "  var lastSlash = uri.lastIndexOf('/');",
      '  var lastSegment = uri.substring(lastSlash + 1);',
      "  if (lastSegment.indexOf('.') === -1) {",
      "    req.uri = '/index.html';",
      '  }',
      '  return req;',
      '}',
    ].join('\n'),
  );
});

// --- gated SPA router ---------------------------------------------------------

test('gatedSpaRouterCode — an in-range /32 viewer passes and the SPA route is still rewritten', () => {
  const handler = compile(gatedSpaRouterCode(RULES));
  const out = handler(event('203.0.113.7', '/settings'));
  assert.equal(out.uri, '/index.html');
  assert.equal(out.statusCode, undefined);
});

test('gatedSpaRouterCode — an in-range viewer keeps a static asset URI', () => {
  const handler = compile(gatedSpaRouterCode(RULES));
  const out = handler(event('203.0.113.7', '/build-id.json'));
  assert.equal(out.uri, '/build-id.json');
});

test('gatedSpaRouterCode — a /24 block admits every host in it and refuses the next block', () => {
  const handler = compile(gatedSpaRouterCode(RULES));
  assert.equal(handler(event('192.168.1.200', '/x')).uri, '/index.html');
  assert.deepEqual(handler(event('192.168.2.1', '/x')), EXPECTED_403);
});

test('gatedSpaRouterCode — an out-of-range viewer gets the exact 403 shape', () => {
  const handler = compile(gatedSpaRouterCode(RULES));
  assert.deepEqual(handler(event('203.0.113.8', '/')), EXPECTED_403);
});

test('gatedSpaRouterCode — an IPv6 viewer is refused (allowlist is IPv4-only)', () => {
  const handler = compile(gatedSpaRouterCode(RULES));
  assert.deepEqual(handler(event('2001:db8::1', '/')), EXPECTED_403);
});

test('gatedSpaRouterCode — a missing viewer ip is refused', () => {
  const handler = compile(gatedSpaRouterCode(RULES));
  assert.deepEqual(handler(event(undefined, '/')), EXPECTED_403);
  assert.deepEqual(handler({ request: { uri: '/' } }), EXPECTED_403);
});

test('gatedSpaRouterCode — partial or malformed addresses are refused, never partially parsed', () => {
  const handler = compile(gatedSpaRouterCode(RULES));
  for (const ip of ['203.0.113', '203.0.113.7.1', '203.0.113.x', '203.0.113.256', '', ' 203.0.113.7']) {
    assert.deepEqual(handler(event(ip, '/')), EXPECTED_403, `ip=${JSON.stringify(ip)}`);
  }
});

test('gatedSpaRouterCode — X-Forwarded-For carrying an allowed IP does not override a disallowed viewer ip', () => {
  const handler = compile(gatedSpaRouterCode(RULES));
  const out = handler(
    event('198.51.100.9', '/', { 'x-forwarded-for': { value: '203.0.113.7' } }),
  );
  assert.deepEqual(out, EXPECTED_403);
});

test('gatedSpaRouterCode — a single /32 rule with the high bit set matches only itself', () => {
  const handler = compile(gatedSpaRouterCode([HOME]));
  assert.equal(handler(event('203.0.113.7', '/a')).uri, '/index.html');
  assert.deepEqual(handler(event('203.0.113.6', '/a')), EXPECTED_403);
  assert.deepEqual(handler(event('75.0.113.7', '/a')), EXPECTED_403);
});

// --- gate-only (/api/*) -------------------------------------------------------

test('gateOnlyCode — an in-range viewer gets the request back unchanged', () => {
  const handler = compile(gateOnlyCode(RULES));
  const req = event('203.0.113.7', '/api/v1/sync/pull', { authorization: { value: 'Bearer x' } });
  const out = handler(req);
  assert.equal(out, req.request);
  assert.equal(out.uri, '/api/v1/sync/pull');
});

test('gateOnlyCode — an out-of-range viewer gets the 403, IPv6 and missing ip included', () => {
  const handler = compile(gateOnlyCode(RULES));
  assert.deepEqual(handler(event('198.51.100.9', '/api/v1/health')), EXPECTED_403);
  assert.deepEqual(handler(event('2001:db8::1', '/api/v1/health')), EXPECTED_403);
  assert.deepEqual(handler(event(undefined, '/api/v1/health')), EXPECTED_403);
});

// --- size invariant + hygiene -------------------------------------------------

test('generated code stays well under the 10 KB CloudFront limit for a realistic allowlist', () => {
  const rules = Array.from({ length: 20 }, (_, i) => ipv4CidrToRule(`10.${i}.0.0/16`));
  for (const code of [spaRouterCode(), gatedSpaRouterCode(rules), gateOnlyCode(rules)]) {
    assert.ok(Buffer.byteLength(code, 'utf8') < CLOUDFRONT_FUNCTION_MAX_BYTES);
  }
});

// The generators throw for an oversized allowlist; cloudfront.ts calls them
// before its first `new aws.*`, which is what keeps the failure ahead of any
// resource registration (that ordering is not observable here without a
// Pulumi runtime).
test('assertFunctionSize — an allowlist that pushes the code past the ceiling throws from the generator', () => {
  const huge = Array.from({ length: 600 }, (_, i) =>
    ipv4CidrToRule(`${(i % 200) + 1}.${i % 256}.${(i * 7) % 256}.0/24`),
  );
  assert.equal(CLOUDFRONT_FUNCTION_MAX_BYTES, 10_000);
  assert.throws(() => gateOnlyCode(huge), /over the 10000-byte ceiling/);
  assert.throws(() => gatedSpaRouterCode(huge), /over the 10000-byte ceiling/);
  assert.throws(() => assertFunctionSize('x'.repeat(CLOUDFRONT_FUNCTION_MAX_BYTES + 1), 't'), /"t"/);
});

// Style invariant: the emitted code stays in the ES5 subset by convention
// (cloudfront-js-2.0 does accept let/const, but the templates are kept
// lowest-common-denominator so a runtime downgrade is never a surprise).
test('generated code never contains the insecure unsafe-eval token or ES2015+ syntax', () => {
  for (const code of [spaRouterCode(), gatedSpaRouterCode(RULES), gateOnlyCode(RULES)]) {
    assert.doesNotMatch(code, /'unsafe-eval'/);
    assert.doesNotMatch(code, /\blet\b|\bconst\b|=>|\bclass\b/);
  }
});
