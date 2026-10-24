// AES-256-GCM payload crypto and helpers; see docs/security.md "The household key and the payloads".
// The payload key is derived from the HDK via HKDF, so the HDK never encrypts directly. Decrypt fails closed.
import type { AadMetadata, EncryptedPayloadEnvelope } from './encryption-types';

const SUPPORTED_ENCRYPTION_VERSION = 1;
const GCM_NONCE_BYTES = 12;
const AES_GCM_KEY_BITS = 256;
// HKDF info label for the payload key; distinct from the wrap and MAC labels.
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

/** base64url (RFC 4648 §5, no padding) of raw bytes. */
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
 * JSON with keys sorted at every depth, so any device emits identical bytes for equal data; the one serialization used
 * by AAD, envelope-set MAC and freshness MAC.
 */
export function canonicalJsonBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return utf8Bytes(canonicalStringify(value));
}

/**
 * UTF-8 bytes in an ArrayBuffer-backed view: TextEncoder's `Uint8Array<ArrayBufferLike>` is rejected as a WebCrypto
 * `BufferSource` under TS 5.9.
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

/** AES-GCM AAD bytes for a payload: stable identity fields only, canonicalised. */
export function canonicalAad(meta: AadMetadata): Uint8Array<ArrayBuffer> {
  return canonicalJsonBytes({
    aggregateId: meta.aggregateId,
    aggregateType: meta.aggregateType,
    encryptionVersion: meta.encryptionVersion,
    householdId: meta.householdId,
  });
}

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

/** Encrypts a JSON-serializable payload into a v1 envelope with a fresh 12-byte nonce, binding the AAD. */
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
 * Decrypts an envelope and verifies the AAD; fails closed with {@link PayloadCryptoError} (unsupported version or alg,
 * mismatch, wrong key).
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
