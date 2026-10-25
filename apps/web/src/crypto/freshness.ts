// Freshness head MAC and monotonic-counter helpers for rollback detection; see docs/security.md "Unlocking".
// The MAC covers only the counter (the client signs before the server's `syncCursor` exists) under an HDK-derived key.
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalJsonBytes,
  utf8Bytes,
} from './payload-crypto';
import type { FreshnessHead } from './encryption-types';

// HKDF info label for the freshness MAC key; distinct from the payload and envelope labels.
const CURSOR_AUTH_LABEL = 'cursor-auth';

/** Error thrown on freshness-verification failure; lets callers fail closed. */
export class FreshnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreshnessError';
  }
}

function canonicalFreshnessCounter(freshnessCounter: number): Uint8Array<ArrayBuffer> {
  return canonicalJsonBytes({ freshnessCounter });
}

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

/** `cursorTag`: base64url HMAC-SHA-256 over the canonical counter under the HDK-derived MAC key. */
export async function computeCursorTag(freshnessCounter: number, hdk: CryptoKey): Promise<string> {
  const macKey = await deriveCursorMacKey(hdk);
  const signature = await crypto.subtle.sign(
    'HMAC',
    macKey,
    canonicalFreshnessCounter(freshnessCounter),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

/** Throws {@link FreshnessError} on a tampered or malformed tag or counter. */
export async function verifyCursorTag(head: FreshnessHead, hdk: CryptoKey): Promise<void> {
  let ok: boolean;
  try {
    // Inside the try so a malformed server-stored tag fails closed as FreshnessError, not a raw DOMException from atob.
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
 * A served counter below the pinned value is a rollback; first contact (pinned 0) accepts any non-negative counter
 * (TOFU, a known limit).
 */
export function isRollback(served: number, pinned: number): boolean {
  return served < pinned;
}
