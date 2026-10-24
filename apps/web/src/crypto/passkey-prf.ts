// WebAuthn PRF plumbing for `passkey_prf` slots; see docs/security.md "The three unlock slots".
// Every helper fails soft (null) so PRF never blocks login. The DOM lib and @simplewebauthn types lack the WebAuthn L3
// `prf` shapes, so they are defined locally and applied with narrow casts.
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from './payload-crypto';

const AES_GCM_KEY_BITS = 256;
// HKDF info label; domain-separates the PRF-derived wrap key.
const PRF_WRAP_LABEL = 'passkey-prf-wrap';

interface PrfExtensionInput {
  prf: { eval: { first: BufferSource } };
}

interface PrfExtensionOutput {
  prf?: { results?: { first?: BufferSource } };
}

/** Adds a PRF evaluation for `prfSalt` to the assertion options (returns a new object). */
export function addPrfEvalToOptions(
  options: PublicKeyCredentialRequestOptionsJSON,
  prfSalt: string,
): PublicKeyCredentialRequestOptionsJSON {
  const prfInput: PrfExtensionInput = {
    prf: { eval: { first: base64UrlToBytes(prfSalt) } },
  };
  return {
    ...options,
    // `prf` is not in the DOM lib's client-extension input type; merge it alongside server-provided extensions.
    extensions: { ...options.extensions, ...prfInput },
  };
}

/** PRF result bytes, or null when unsupported or no PRF eval was requested. */
export function extractPrfResult(response: AuthenticationResponseJSON): Uint8Array<ArrayBuffer> | null {
  const ext = response.clientExtensionResults as PrfExtensionOutput | undefined;
  const first = ext?.prf?.results?.first;
  if (!first) return null;
  if (first instanceof ArrayBuffer) return new Uint8Array(first);
  if (ArrayBuffer.isView(first)) {
    return new Uint8Array(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength));
  }
  return null;
}

/**
 * Derives the AES-GCM wrap key from the PRF output via HKDF-SHA-256; the output is high-entropy, so no PBKDF2
 * stretching.
 */
export async function derivePrfWrapKey(prfOutput: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: utf8Bytes(PRF_WRAP_LABEL),
    },
    baseKey,
    { name: 'AES-GCM', length: AES_GCM_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Fresh base64url PRF salt for a new `passkey_prf` slot's `prfSalt`. */
export function generatePrfSalt(): string {
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  return bytesToBase64Url(salt);
}
