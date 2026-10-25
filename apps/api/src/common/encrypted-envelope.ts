// Strict structural detector for an encrypted aggregate payload envelope, shared by the push guard and the compactor.
// A pure shape check: the server never decrypts.

const ENCRYPTED_ENVELOPE_ALG = 'AES-256-GCM';

// Every key the envelope may carry; anything else fails the guard.
const ENVELOPE_KEYS = new Set([
  'encryptionVersion',
  'keyId',
  'alg',
  'nonce',
  'ciphertext',
  'aadVersion',
]);

/** The encrypted-envelope wire shape (a complete payload, never a patch). */
export interface EncryptedPayloadEnvelope {
  encryptionVersion: 1;
  keyId: string;
  alg: 'AES-256-GCM';
  nonce: string;
  ciphertext: string;
  aadVersion?: number;
}

/**
 * True only for a well-formed encrypted aggregate payload with no key outside the documented five (plus an optional
 * numeric `aadVersion`), so plaintext riding alongside ciphertext is rejected. Mirrors the web `isStrictEncryptedEnvelope`;
 * no real client write is affected, since `encryptPayload` emits exactly those keys.
 */
export function isStrictEncryptedEnvelope(
  payload: unknown,
): payload is EncryptedPayloadEnvelope {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (p.encryptionVersion !== 1) return false;
  if (p.alg !== ENCRYPTED_ENVELOPE_ALG) return false;
  if (typeof p.keyId !== 'string') return false;
  if (typeof p.nonce !== 'string') return false;
  if (typeof p.ciphertext !== 'string') return false;
  if (p.aadVersion !== undefined && typeof p.aadVersion !== 'number') return false;
  if (!Object.keys(p).every((k) => ENVELOPE_KEYS.has(k))) return false;
  return true;
}
