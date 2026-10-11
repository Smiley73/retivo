/**
 * AES-256-GCM payload encrypt/decrypt + the shared canonical-serialization and
 * base64url helpers for the zero-knowledge encryption boundary (see "The
 * household key and the payloads" in docs/security.md).
 *
 * Native WebCrypto only (no new dependency, no CSP change). The
 * per-payload encryption key is derived from the HDK via HKDF so the HDK itself
 * never directly encrypts payloads. Decrypt fails closed: any AAD mismatch,
 * wrong key, or unsupported version throws (never returns null silently).
 */
import type { AadMetadata, EncryptedPayloadEnvelope } from './encryption-types';

const SUPPORTED_ENCRYPTION_VERSION = 1;
const GCM_NONCE_BYTES = 12;
const AES_GCM_KEY_BITS = 256;
/** HKDF info label for the payload encryption key (distinct from wrap/MAC). */
const PAYLOAD_ENC_LABEL = 'payload-enc';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Error thrown on any decrypt-time failure; lets callers fail closed cleanly. */
export class PayloadCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadCryptoError';
  }
}

/**
 * base64url-encode raw bytes (RFC 4648 §5, no padding). Used for every binary
 * field that crosses the wire/storage boundary so the shapes are JSON-safe.
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inverse of {@link bytesToBase64Url}. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Deterministic JSON serialization: object keys are emitted in sorted order at
 * every depth so any device produces byte-identical output for equal data
 * regardless of field order. The single canonical-serialization primitive
 * reused by AAD, envelope-set MAC, and freshness MAC.
 */
export function canonicalJsonBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return utf8Bytes(canonicalStringify(value));
}

/**
 * UTF-8 encode a string into a fresh ArrayBuffer-backed view. TextEncoder
 * returns a `Uint8Array<ArrayBufferLike>`, which WebCrypto's `BufferSource`
 * (ArrayBuffer only) rejects under TS5.9's stricter typed-array generics; the
 * explicit copy pins the backing buffer type.
 */
export function utf8Bytes(value: string): Uint8Array<ArrayBuffer> {
  const encoded = textEncoder.encode(value);
  const out = new Uint8Array(encoded.length);
  out.set(encoded);
  return out;
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Canonical AES-GCM AAD bytes for a payload (stable identity
 * only). Field order is normalized via {@link canonicalJsonBytes}.
 */
export function canonicalAad(meta: AadMetadata): Uint8Array<ArrayBuffer> {
  return canonicalJsonBytes({
    aggregateId: meta.aggregateId,
    aggregateType: meta.aggregateType,
    encryptionVersion: meta.encryptionVersion,
    householdId: meta.householdId,
  });
}

/**
 * Derive the AES-256-GCM payload encryption key from the HDK via HKDF-SHA-256.
 * Keeps the HDK as a key-deriving root rather than a direct content key.
 */
async function derivePayloadKey(hdk: CryptoKey): Promise<CryptoKey> {
  const hdkBytes = await crypto.subtle.exportKey('raw', hdk);
  const baseKey = await crypto.subtle.importKey('raw', hdkBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: textEncoder.encode(PAYLOAD_ENC_LABEL),
    },
    baseKey,
    { name: 'AES-GCM', length: AES_GCM_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * AES-256-GCM-encrypt a JSON-serializable payload, binding the AAD. Returns
 * a v1 envelope with a fresh random 12-byte nonce; `keyId` identifies the HDK.
 */
export async function encryptPayload(
  payload: unknown,
  meta: AadMetadata,
  hdk: CryptoKey,
  keyId: string,
): Promise<EncryptedPayloadEnvelope> {
  if (meta.encryptionVersion !== SUPPORTED_ENCRYPTION_VERSION) {
    throw new PayloadCryptoError(
      `unsupported encryptionVersion ${String(meta.encryptionVersion)}`,
    );
  }
  const key = await derivePayloadKey(hdk);
  const nonce = new Uint8Array(GCM_NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const plaintext = utf8Bytes(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: canonicalAad(meta) },
    key,
    plaintext,
  );
  return {
    encryptionVersion: SUPPORTED_ENCRYPTION_VERSION,
    keyId,
    alg: 'AES-256-GCM',
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

/**
 * AES-256-GCM-decrypt an envelope, verifying the AAD. Fails closed: an
 * unsupported version, AAD mismatch, or wrong key throws {@link
 * PayloadCryptoError} (never returns null/undefined).
 */
export async function decryptPayload(
  envelope: EncryptedPayloadEnvelope,
  meta: AadMetadata,
  hdk: CryptoKey,
): Promise<unknown> {
  if (envelope.encryptionVersion !== SUPPORTED_ENCRYPTION_VERSION) {
    throw new PayloadCryptoError(
      `unsupported encryptionVersion ${String(envelope.encryptionVersion)}`,
    );
  }
  if (envelope.alg !== 'AES-256-GCM') {
    throw new PayloadCryptoError(`unsupported alg ${String(envelope.alg)}`);
  }
  if (meta.encryptionVersion !== envelope.encryptionVersion) {
    throw new PayloadCryptoError(
      `encryptionVersion mismatch: meta ${String(meta.encryptionVersion)} vs envelope ${String(
        envelope.encryptionVersion,
      )}`,
    );
  }
  const key = await derivePayloadKey(hdk);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64UrlToBytes(envelope.nonce),
        additionalData: canonicalAad(meta),
      },
      key,
      base64UrlToBytes(envelope.ciphertext),
    );
  } catch {
    // GCM tag failure: wrong key, tampered ciphertext, or AAD mismatch.
    throw new PayloadCryptoError('payload decryption failed (auth tag mismatch)');
  }
  try {
    return JSON.parse(textDecoder.decode(plaintext));
  } catch {
    throw new PayloadCryptoError('decrypted payload is not valid JSON');
  }
}
