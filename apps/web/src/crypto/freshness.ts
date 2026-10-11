/**
 * Freshness head MAC + monotonic-counter helpers for rollback detection
 * (see "Unlocking" in docs/security.md).
 *
 * The client owns a monotonic `freshnessCounter` and MACs only the counter
 * (the server-assigned `syncCursor` is deliberately not bound — the client
 * signs before the cursor exists; content binding would be a future hash-chain).
 * The MAC key is HDK-derived so any unlock method can verify it; the server
 * stores both fields opaquely and never recomputes the MAC.
 */
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalJsonBytes,
  utf8Bytes,
} from './payload-crypto';
import type { FreshnessHead } from './encryption-types';

/** HKDF info label for the freshness MAC key (distinct from payload/envelope). */
const CURSOR_AUTH_LABEL = 'cursor-auth';

// Re-export the shared canonical-serialization primitive so freshness consumers
// import it from one place; the implementation lives in payload-crypto.ts.

/** Error thrown on freshness-verification failure; lets callers fail closed. */
export class FreshnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreshnessError';
  }
}

/** Canonical bytes over the freshness counter (counter only). */
function canonicalFreshnessCounter(freshnessCounter: number): Uint8Array<ArrayBuffer> {
  return canonicalJsonBytes({ freshnessCounter });
}

/** Derive the freshness MAC key from the HDK via HKDF-SHA-256. */
async function deriveCursorMacKey(hdk: CryptoKey): Promise<CryptoKey> {
  const hdkBytes = await crypto.subtle.exportKey('raw', hdk);
  const baseKey = await crypto.subtle.importKey('raw', hdkBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: utf8Bytes(CURSOR_AUTH_LABEL),
    },
    baseKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Compute the freshness `cursorTag`: HMAC-SHA-256 under the HDK-derived
 * MAC key over the canonical counter. base64url.
 */
export async function computeCursorTag(freshnessCounter: number, hdk: CryptoKey): Promise<string> {
  const macKey = await deriveCursorMacKey(hdk);
  const signature = await crypto.subtle.sign(
    'HMAC',
    macKey,
    canonicalFreshnessCounter(freshnessCounter),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

/**
 * Verify a freshness head's `cursorTag`. Throws {@link FreshnessError} on
 * mismatch (tampered tag or counter).
 */
export async function verifyCursorTag(head: FreshnessHead, hdk: CryptoKey): Promise<void> {
  let ok: boolean;
  try {
    // Decode the server-stored base64url tag + derive/verify inside the catch so
    // a malformed cursorTag fails closed as FreshnessError, not a raw DOMException
    // from atob.
    const macKey = await deriveCursorMacKey(hdk);
    ok = await crypto.subtle.verify(
      'HMAC',
      macKey,
      base64UrlToBytes(head.cursorTag),
      canonicalFreshnessCounter(head.freshnessCounter),
    );
  } catch {
    throw new FreshnessError('cursor tag verification failed (malformed tag)');
  }
  if (!ok) throw new FreshnessError('cursor tag verification failed (tamper)');
}

/** Bump the client-owned monotonic counter (pure). */
export function bumpCounter(current: number): number {
  return current + 1;
}

/**
 * A served counter strictly below the locally pinned value is a genuine
 * rollback. Equal or higher is accepted; first-contact (pinned 0) accepts
 * any non-negative served counter as the TOFU pin (a known limit).
 */
export function isRollback(served: number, pinned: number): boolean {
  return served < pinned;
}
