// Source generators for the CloudFront Functions cloudfront.ts publishes, kept dependency-free so `node --test` can run the output.
// CloudFront Functions run an ES5-subset runtime (cloudfront-js-2.0) with no imports; `assertFunctionSize` enforces the size limit.

import { ASSISTANT_BRIDGE_PORT_RANGE } from "./config-helpers.mjs";

/**
 * Local ceiling on published function size; AWS documents "10 KB" without saying 10,000 or 10,240 bytes, so this uses the lower.
 * @type {number}
 */
export const CLOUDFRONT_FUNCTION_MAX_BYTES = 10_000;

/**
 * Throws when generated code exceeds the size limit, so an oversized allowlist fails `pulumi preview`.
 * @param {string} code generated handler source
 * @param {string} label which function, for the error message
 * @returns {string} the same code, for chaining
 */
export function assertFunctionSize(code, label) {
  const bytes = Buffer.byteLength(code, "utf8");
  if (bytes > CLOUDFRONT_FUNCTION_MAX_BYTES) {
    throw new Error(
      `CloudFront Function "${label}" is ${bytes} bytes — over the ${CLOUDFRONT_FUNCTION_MAX_BYTES}-byte ceiling (CloudFront's 10 KB limit). Shorten retivo:edgeAllowedIps (fewer, wider CIDR blocks).`,
    );
  }
  return code;
}

/**
 * The viewer-IP allowlist check, as top-level helpers; anything but four numeric octets in 0-255 is not allowed.
 * @param {ReadonlyArray<{ base: number, mask: number }>} rules
 * @returns {string}
 */
function edgeGateSnippet(rules) {
  if (rules.length === 0) {
    throw new Error("edgeGateSnippet needs at least one allowlist rule");
  }
  const allow = rules.map((r) => `[${r.base >>> 0}, ${r.mask >>> 0}]`).join(", ");
  return `
var ALLOW = [${allow}];
var FORBIDDEN = {
  statusCode: 403,
  statusDescription: 'Forbidden',
  headers: {
    'content-type': { value: 'text/plain; charset=utf-8' },
    'cache-control': { value: 'no-store' }
  },
  body: { encoding: 'text', data: 'Forbidden' }
};
function ip4(s) {
  if (typeof s !== 'string') return -1;
  var parts = s.split('.');
  if (parts.length !== 4) return -1;
  var n = 0;
  for (var i = 0; i < 4; i++) {
    var p = parts[i];
    if (p.length === 0 || p.length > 3 || !/^[0-9]+$/.test(p)) return -1;
    var v = parseInt(p, 10);
    if (v > 255) return -1;
    n = (n * 256) + v;
  }
  return n;
}
function allowed(ip) {
  var n = ip4(ip);
  if (n < 0) return false;
  for (var i = 0; i < ALLOW.length; i++) {
    if (((n & ALLOW[i][1]) >>> 0) === ALLOW[i][0]) return true;
  }
  return false;
}
`.trim();
}

/**
 * The SPA-route rewrite shared by both router variants: a last path segment without `.` becomes /index.html.
 * @returns {string}
 */
function spaRouterBody() {
  return `
  var uri = req.uri;
  var lastSlash = uri.lastIndexOf('/');
  var lastSegment = uri.substring(lastSlash + 1);
  if (lastSegment.indexOf('.') === -1) {
    req.uri = '/index.html';
  }
  return req;
`.replace(/^\n/, "").replace(/\n$/, "");
}

/**
 * Ungated viewer-request handler for the SPA (default) cache behavior.
 * @returns {string}
 */
export function spaRouterCode() {
  return assertFunctionSize(
    `
function handler(event) {
  var req = event.request;
${spaRouterBody()}
}
`.trim(),
    "spa-router",
  );
}

/**
 * Gated viewer-request handler for the SPA behavior: 403 from the edge for a viewer outside the allowlist, then the rewrite.
 * @param {ReadonlyArray<{ base: number, mask: number }>} rules
 * @returns {string}
 */
export function gatedSpaRouterCode(rules) {
  return assertFunctionSize(
    `
${edgeGateSnippet(rules)}
function handler(event) {
  if (!allowed(event.viewer && event.viewer.ip)) return FORBIDDEN;
  var req = event.request;
${spaRouterBody()}
}
`.trim(),
    "spa-router (gated)",
  );
}

/**
 * Gate-only viewer-request handler for `/api/*`: 403 outside the allowlist, otherwise the request passes through.
 * @param {ReadonlyArray<{ base: number, mask: number }>} rules
 * @returns {string}
 */
export function gateOnlyCode(rules) {
  return assertFunctionSize(
    `
${edgeGateSnippet(rules)}
function handler(event) {
  if (!allowed(event.viewer && event.viewer.ip)) return FORBIDDEN;
  return event.request;
}
`.trim(),
    "api-gate",
  );
}

/**
 * Viewer-response handler: security headers on every response, plus a SPA CSP when the response carries none
 * (the API's helmet CSP is left alone). With a port, the one added entry is `connect-src 'self' ws://127.0.0.1:<port>`,
 * the string `loopbackWsUrl(port)` returns; it is formatted here because that package is ESM-only. Never `ws:` or a wildcard.
 * @param {number | undefined} [assistantBridgePort] loopback port to allow;
 *   undefined = no WebSocket entry
 * @returns {string}
 */
export function securityHeadersCode(assistantBridgePort) {
  let connectSrc = "connect-src 'self'";
  if (assistantBridgePort !== undefined) {
    const { min, max } = ASSISTANT_BRIDGE_PORT_RANGE;
    if (
      typeof assistantBridgePort !== "number" ||
      !Number.isInteger(assistantBridgePort) ||
      assistantBridgePort < min ||
      assistantBridgePort > max
    ) {
      throw new Error(
        `retivo:assistantBridgePort must be an integer from ${min} to ${max} (got ${String(assistantBridgePort)}) — it becomes the one ws://127.0.0.1:<port> entry in the SPA's connect-src.`,
      );
    }
    connectSrc = `connect-src 'self' ws://127.0.0.1:${assistantBridgePort}`;
  }
  // 'unsafe-inline' on style-src only, for styles inlined by build plugins.
  return assertFunctionSize(
    `
function handler(event) {
  var response = event.response;
  var headers = response.headers;

  headers['strict-transport-security'] = {
    value: 'max-age=63072000; includeSubDomains; preload'
  };
  headers['x-content-type-options'] = { value: 'nosniff' };
  headers['referrer-policy'] = { value: 'same-origin' };
  headers['permissions-policy'] = {
    value: 'camera=(), microphone=(), geolocation=()'
  };

  if (!headers['content-security-policy']) {
    headers['content-security-policy'] = {
      value: [
        "default-src 'self'",
        // 'wasm-unsafe-eval' permits WebAssembly compilation only (NOT JS
        // eval) for the Argon2id HDK key-wrapping WASM module (hash-wasm).
        // The binary is base64-embedded in the JS
        // bundle at build time — no runtime fetch, so no connect-src/worker-src
        // change is needed beyond this one directive.
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "${connectSrc}",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'"
      ].join('; ')
    };
  }
  return response;
}
`.trim(),
    "security-headers",
  );
}
