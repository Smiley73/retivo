// Runtime tests for the CloudFront Function code in infrastructure/src/edge-functions.mjs: each test compiles the generated source
// with `new Function` and calls `handler` with a fake viewer event, because asserting on the text would not catch a broken handler.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLOUDFRONT_FUNCTION_MAX_BYTES,
  assertFunctionSize,
  apiViewerRequestCode,
  gatedSpaRouterCode,
  spaRouterCode,
} from '../../infrastructure/src/edge-functions.mjs';
import { ipv4CidrToRule, viewerAddressProof } from '../../infrastructure/src/config-helpers.mjs';

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

// --- /api/* viewer-request: viewer address + signal, with and without the gate ---------------------------

const SIGNAL = 'a1b2c3'.repeat(10) + 'd4e5';
const ADDRESS_HEADER = 'x-viewer-address';
const SIGNAL_HEADER = 'x-viewer-address-proof';

/** The two header names the edge owns, whatever else the request carries. */
const edgeHeaders = (req) => ({ address: req.headers[ADDRESS_HEADER], signal: req.headers[SIGNAL_HEADER] });

for (const ip of ['198.51.100.9', '2001:db8::1']) {
  test(`apiViewerRequestCode — ungated, ${ip} gets the address and signal and nothing else changes`, () => {
    const handler = compile(apiViewerRequestCode(SIGNAL, []));
    const req = event(ip, '/api/v1/sync/pull', { authorization: { value: 'Bearer x' } });
    const out = handler(req);
    assert.equal(out, req.request);
    assert.deepEqual(out.headers, {
      authorization: { value: 'Bearer x' },
      [ADDRESS_HEADER]: { value: ip },
      [SIGNAL_HEADER]: { value: SIGNAL },
    });
    assert.equal(out.uri, '/api/v1/sync/pull');
    assert.equal(out.method, 'GET');
  });
}

test('apiViewerRequestCode — ungated output carries none of the gate code', () => {
  assert.doesNotMatch(apiViewerRequestCode(SIGNAL, []), /ALLOW|FORBIDDEN|allowed/);
});

test("apiViewerRequestCode — a client's own copies of both headers never survive, multiValue included", () => {
  for (const rules of [[], RULES]) {
    const handler = compile(apiViewerRequestCode(SIGNAL, rules));
    const out = handler(
      event('203.0.113.7', '/api/v1/x', {
        [ADDRESS_HEADER]: { value: '192.0.2.1', multiValue: [{ value: '192.0.2.1' }, { value: '192.0.2.2' }] },
        [SIGNAL_HEADER]: { value: 'forged', multiValue: [{ value: 'forged' }, { value: 'forged-2' }] },
      }),
    );
    assert.deepEqual(edgeHeaders(out), {
      address: { value: '203.0.113.7' },
      signal: { value: SIGNAL },
    });
  }
});

test('apiViewerRequestCode — ungated with no viewer address drops the client address and sets only the signal, without throwing', () => {
  const handler = compile(apiViewerRequestCode(SIGNAL, []));
  for (const ev of [
    event(undefined, '/api/v1/x', { [ADDRESS_HEADER]: { value: '192.0.2.1' } }),
    { request: { uri: '/api/v1/x', headers: { [ADDRESS_HEADER]: { value: '192.0.2.1' } } } },
  ]) {
    const out = handler(ev);
    assert.equal(ADDRESS_HEADER in out.headers, false);
    assert.deepEqual(out.headers[SIGNAL_HEADER], { value: SIGNAL });
  }
});

test('apiViewerRequestCode — gated, an out-of-range, IPv6 or missing viewer gets the exact 403 and no request', () => {
  const handler = compile(apiViewerRequestCode(SIGNAL, RULES));
  for (const ip of ['198.51.100.9', '2001:db8::1', undefined]) {
    assert.deepEqual(handler(event(ip, '/api/v1/health')), EXPECTED_403, `ip=${ip}`);
  }
});

test('apiViewerRequestCode — gated, a client x-viewer-address naming an allowed address does not admit a disallowed viewer', () => {
  const handler = compile(apiViewerRequestCode(SIGNAL, RULES));
  const out = handler(
    event('198.51.100.9', '/api/v1/health', { [ADDRESS_HEADER]: { value: '203.0.113.7' } }),
  );
  assert.deepEqual(out, EXPECTED_403);
});

test('apiViewerRequestCode — gated, an admitted viewer is passed on with both headers', () => {
  const handler = compile(apiViewerRequestCode(SIGNAL, RULES));
  const req = event('192.168.1.200', '/api/v1/sync/pull');
  const out = handler(req);
  assert.equal(out, req.request);
  assert.deepEqual(edgeHeaders(out), { address: { value: '192.168.1.200' }, signal: { value: SIGNAL } });
});

// Copied from apps/api/src/common/visitor-address.spec.ts on purpose: the API and the edge must derive the same value.
const API_SECRET = 'edge-secret-test-vector';
const API_PROOF = '9aec177ceb9bc60c5875610065ec2d03679328f6e8d08fdb85b08537a45d6dbc';

test("signal agreement — the derivation matches the API's test vector and the function writes it under the API's header name", () => {
  assert.equal(viewerAddressProof(API_SECRET), API_PROOF);
  const out = compile(apiViewerRequestCode(viewerAddressProof(API_SECRET), []))(event('198.51.100.9', '/api/v1/x'));
  assert.deepEqual(out.headers['x-viewer-address-proof'], { value: API_PROOF });
});

test('apiViewerRequestCode — the signal is embedded as a quoted literal, whatever it holds', () => {
  const odd = `it's "q" \\ \n`;
  const out = compile(apiViewerRequestCode(odd, []))(event('198.51.100.9', '/'));
  assert.equal(out.headers[SIGNAL_HEADER].value, odd);
});

// --- size invariant + hygiene -------------------------------------------------

test('generated code stays well under the 10 KB CloudFront limit for a realistic allowlist', () => {
  const rules = Array.from({ length: 20 }, (_, i) => ipv4CidrToRule(`10.${i}.0.0/16`));
  for (const code of [spaRouterCode(), gatedSpaRouterCode(rules), apiViewerRequestCode(SIGNAL, rules), apiViewerRequestCode(SIGNAL, [])]) {
    assert.ok(Buffer.byteLength(code, 'utf8') < CLOUDFRONT_FUNCTION_MAX_BYTES);
  }
});

// cloudfront.ts calls the generators before its first `new aws.*`, so the throw precedes resource registration; that ordering is not observable here.
test('assertFunctionSize — an allowlist that pushes the code past the ceiling throws from the generator', () => {
  const huge = Array.from({ length: 600 }, (_, i) =>
    ipv4CidrToRule(`${(i % 200) + 1}.${i % 256}.${(i * 7) % 256}.0/24`),
  );
  assert.equal(CLOUDFRONT_FUNCTION_MAX_BYTES, 10_000);
  assert.throws(() => apiViewerRequestCode(SIGNAL, huge), /over the 10000-byte ceiling/);
  assert.throws(() => gatedSpaRouterCode(huge), /over the 10000-byte ceiling/);
  assert.throws(() => assertFunctionSize('x'.repeat(CLOUDFRONT_FUNCTION_MAX_BYTES + 1), 't'), /"t"/);
});

// The emitted code stays ES5 by convention (cloudfront-js-2.0 accepts let/const) so a runtime downgrade is no surprise.
test('generated code never contains the insecure unsafe-eval token or ES2015+ syntax', () => {
  for (const code of [spaRouterCode(), gatedSpaRouterCode(RULES), apiViewerRequestCode(SIGNAL, RULES), apiViewerRequestCode(SIGNAL, [])]) {
    assert.doesNotMatch(code, /'unsafe-eval'/);
    assert.doesNotMatch(code, /\blet\b|\bconst\b|=>|\bclass\b/);
  }
});
