/**
 * WebAuthn PRF-extension plumbing for the zero-knowledge encryption boundary
 * (see "The three unlock slots" in docs/security.md).
 *
 * A `passkey_prf` slot wraps the household data key (HDK) under a key derived
 * from the authenticator's PRF (pseudo-random function) output. The PRF input
 * is the slot's stored `prfSalt`; the authenticator returns a stable 32-byte
 * secret for that salt on every assertion, from which we derive an AES-256-GCM
 * wrapping key via HKDF.
 *
 * PRF support is best-effort: not all browsers/authenticators implement the
 * WebAuthn `prf` extension. Every helper here fails soft (returns null) so the
 * caller can silently fall back to the password slot — PRF never blocks login.
 * Native WebCrypto only; no new dependency, no CSP change.
 *
 * The DOM lib + @simplewebauthn types do not yet declare the WebAuthn L3 `prf`
 * extension shapes, so the input/output forms are defined locally and applied
 * with narrow casts at the single extension boundary.
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from './payload-crypto';

const AES_GCM_KEY_BITS = 256;
/** HKDF info label — domain-separates the PRF-derived wrap key. */
const PRF_WRAP_LABEL = 'passkey-prf-wrap';

/** WebAuthn PRF extension input (WebAuthn L3 — not yet in the DOM lib). */
interface PrfExtensionInput {
  prf: { eval: { first: BufferSource } };
}

/** WebAuthn PRF extension output (WebAuthn L3 — not yet in the DOM lib). */
interface PrfExtensionOutput {
  prf?: { results?: { first?: BufferSource } };
}

/**
 * Add a PRF evaluation request for `prfSalt` to the assertion options. The
 * authenticator evaluates its PRF over the salt and returns the result in
 * `clientExtensionResults.prf.results.first`. Returns a new options object;
 * the input is not mutated.
 */
export function addPrfEvalToOptions(
  options: PublicKeyCredentialRequestOptionsJSON,
  prfSalt: string,
): PublicKeyCredentialRequestOptionsJSON {
  const prfInput: PrfExtensionInput = {
    prf: { eval: { first: base64UrlToBytes(prfSalt) } },
  };
  return {
    ...options,
    // The PRF extension is not in `AuthenticationExtensionsClientInputs`; merge
    // it in alongside any server-provided extensions via a narrow cast.
    extensions: { ...options.extensions, ...prfInput },
  };
}

/**
 * Extract the PRF result bytes from an assertion response, or null when the
 * browser/authenticator did not return one (unsupported, or no PRF eval was
 * requested). Fails soft so the caller can fall back to password unlock.
 */
export function extractPrfResult(response: AuthenticationResponseJSON): Uint8Array<ArrayBuffer> | null {
  const ext = response.clientExtensionResults as PrfExtensionOutput | undefined;
  const first = ext?.prf?.results?.first;
  if (!first) return null;
  // `first` is an ArrayBuffer (or a view) per the WebAuthn L3 spec.
  if (first instanceof ArrayBuffer) return new Uint8Array(first);
  if (ArrayBuffer.isView(first)) {
    return new Uint8Array(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength));
  }
  return null;
}

/**
 * Derive the PRF wrapping key from the authenticator's PRF output via
 * HKDF-SHA-256. The PRF output is a high-entropy authenticator secret, so no
 * PBKDF2 stretching is needed (mirrors the recovery-slot derivation).
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

/**
 * Generate a fresh base64url PRF salt for a new `passkey_prf` slot. Stored in
 * the slot's `prfSalt` metadata and fed back to the authenticator on unlock.
 */
export function generatePrfSalt(): string {
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  return bytesToBase64Url(salt);
}
