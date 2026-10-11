/**
 * Strict structural detector for an encrypted aggregate payload envelope.
 * Single source of truth for "is this an encrypted
 * envelope" on the server side, shared by the sync push guard (which rejects
 * plaintext for a keyed household) and the compactor (which
 * REPLACES — rather than spread-merges — an encrypted snapshot payload).
 *
 * The server stores payloads opaquely and never decrypts; this is a pure shape check. It mirrors
 * the web client's `isStrictEncryptedEnvelope` (apps/web/src/crypto/key-wrapping.ts) byte-for-byte
 * against the wire shape in apps/web/src/crypto/encryption-types.ts `EncryptedPayloadEnvelope`:
 * `encryptionVersion === 1`, `alg === 'AES-256-GCM'`, string `keyId` / `nonce` / `ciphertext`, an
 * OPTIONAL numeric `aadVersion` (absent or number — any other type fails), and NO OTHER KEYS — a
 * payload carrying any key outside this documented shape is rejected, closing the gap where a
 * plaintext field riding alongside real ciphertext would otherwise be stored and served back. A
 * plaintext domain payload that merely carries an `encryptionVersion` field is NOT mistaken for
 * ciphertext. This tightening cannot reject any envelope a real client has ever written: the only
 * producer, `encryptPayload` (apps/web/src/crypto/payload-crypto.ts), always returns exactly these
 * five keys and never sets `aadVersion`.
 */

/** The exact wire algorithm string for an encrypted aggregate payload. */
const ENCRYPTED_ENVELOPE_ALG = 'AES-256-GCM';

/** Every key the envelope shape may carry — anything else fails the guard. */
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

/** Strict guard: true only for a well-formed encrypted aggregate payload
 *  carrying no key outside the documented shape. */
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
