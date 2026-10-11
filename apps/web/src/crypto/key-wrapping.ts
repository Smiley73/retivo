/**
 * Household data key (HDK) generation, per-slot authenticated wrapping, and the
 * household-level envelope-set HMAC for the zero-knowledge encryption boundary
 * (see "Encryption" in docs/security.md).
 *
 * Wraps use AES-256-GCM (not AES-KW: WebCrypto AES-KW accepts no
 * `additionalData`, so it cannot carry the slot-metadata AAD this needs).
 * New password slots derive their wrap key with Argon2id via `hash-wasm`
 * (m=65536, t=3, p=4); legacy PBKDF2-HMAC-
 * SHA-256 slots stay unwrappable read-only (no migration). The recovery
 * slot uses a >=128-bit random key as high-entropy IKM via HKDF. The
 * envelope-set tag is an HDK-keyed HMAC so any unlock method can verify it.
 *
 * Argon2id runs as a WASM module (`hash-wasm` embeds the binary base64 in the
 * JS bundle — no runtime fetch), so the CloudFront CSP `script-src` carries
 * `'wasm-unsafe-eval'` (WASM compile only, not JS `eval`).
 */
import { argon2id } from 'hash-wasm';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalJsonBytes,
  utf8Bytes,
} from './payload-crypto';
import { readDeviceMetadata, updateDeviceMetadata } from '../db/store';
import type {
  Argon2idKdfParams,
  EncryptedPayloadEnvelope,
  EnvelopeSetIntegrity,
  KdfParams,
  KeyEnvelopeSlot,
  SlotType,
} from './encryption-types';

const AES_GCM_KEY_BITS = 256;
const GCM_NONCE_BYTES = 12;
const SALT_BYTES = 16;
const RECOVERY_ENTROPY_BYTES = 16; // 128 bits — the high-entropy unlocker.
/** OWASP 2023 baseline for PBKDF2-HMAC-SHA-256; versioned in `kdf`. */
const DEFAULT_PBKDF2_ITERATIONS = 600_000;
/**
 * Upper bound on server-stored PBKDF2 iterations (10x the ~600k baseline).
 * Caps a tampered/hostile `kdf.iterations` from forcing an unbounded PBKDF2
 * that would hang the unlock; the algorithm is upgradeable via versioned `kdf`.
 */
const MAX_PBKDF2_ITERATIONS = 2_000_000;
/** OWASP 2024 interactive Argon2id baseline: 64 MiB, 3 passes, 4 lanes. */
const DEFAULT_ARGON2ID_M = 65_536; // memory cost (KiB)
const DEFAULT_ARGON2ID_T = 3; // time cost (passes)
const DEFAULT_ARGON2ID_P = 4; // parallelism (lanes)
/**
 * Upper bounds on server-stored Argon2id params. A tampered/hostile
 * server could send `m` = multiple GiB (OOM) or a huge `t`/`p` (hang) during
 * unlock; reject anything above the baseline so the work factor stays bounded.
 * Equal-to-baseline is the only accepted value here (new slots write the
 * baseline; a future raise bumps both the default and these caps together).
 */
const MAX_ARGON2ID_M = 65_536;
const MAX_ARGON2ID_T = 10;
const MAX_ARGON2ID_P = 16;
/** Derived AES-256 key material length in bytes. */
const ARGON2ID_HASH_BYTES = 32;
/** HKDF info labels — domain-separate the wrap key, MAC key, and recovery IKM. */
const ENVELOPE_AUTH_LABEL = 'envelope-auth';
const RECOVERY_WRAP_LABEL = 'recovery-wrap';
/** Grouping for the human-readable recovery key display string. */
const RECOVERY_GROUP_SIZE = 4;

/**
 * Fill a fresh ArrayBuffer-backed view with CSPRNG bytes. `getRandomValues`
 * returns a `Uint8Array<ArrayBufferLike>`; the explicit allocation pins the
 * backing buffer type for WebCrypto's `BufferSource` (TS5.9 generics).
 */
function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/** Error thrown on any key-wrapping failure; lets callers fail closed. */
export class KeyWrappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyWrappingError';
  }
}

/**
 * Generate a fresh 256-bit AES-GCM household data key. Non-extractable: the
 * cache path ({@link exportHdk}) re-generates an extractable copy on demand so
 * the in-memory working key cannot be exported by accident.
 */
export function generateHdk(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: AES_GCM_KEY_BITS }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/** Export the HDK as raw bytes for IDB caching. */
export async function exportHdk(hdk: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.exportKey('raw', hdk);
}

/** Import a cached HDK from its raw bytes. */
export function importHdk(raw: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: AES_GCM_KEY_BITS }, true, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Canonical wrap AAD for a slot: binds `slotType`, KDF params, and version
 * so a server tampering with any of them fails the unlock closed.
 */
function canonicalSlotAad(input: {
  slotType: SlotType;
  kdf?: KdfParams;
  encryptionVersion: number;
}): Uint8Array<ArrayBuffer> {
  return canonicalJsonBytes({
    encryptionVersion: input.encryptionVersion,
    kdf: input.kdf ?? null,
    slotType: input.slotType,
  });
}

/**
 * Validate server-stored KDF params before they drive a derivation. The
 * server holds `kdf` opaquely, so a tampered/hostile algorithm, salt, or an
 * out-of-range iteration count must fail closed rather than feed WebCrypto an
 * unbounded or undefined work factor. Throws {@link KeyWrappingError}.
 */
export function validateKdfParams(kdf: KdfParams): void {
  if (typeof kdf.salt !== 'string' || kdf.salt.length === 0) {
    throw new KeyWrappingError('kdf salt missing or empty');
  }
  if (kdf.algorithm === 'PBKDF2-HMAC-SHA-256') {
    if (
      !Number.isInteger(kdf.iterations) ||
      kdf.iterations <= 0 ||
      kdf.iterations > MAX_PBKDF2_ITERATIONS
    ) {
      throw new KeyWrappingError(`kdf iterations out of range ${String(kdf.iterations)}`);
    }
    return;
  }
  if (kdf.algorithm === 'Argon2id') {
    // Reject out-of-bounds m/t/p: a hostile server could otherwise
    // force OOM (huge m) or a hang (huge t/p) during unlock.
    if (!Number.isInteger(kdf.m) || kdf.m <= 0 || kdf.m > MAX_ARGON2ID_M) {
      throw new KeyWrappingError(`argon2id memory cost out of range ${String(kdf.m)}`);
    }
    if (!Number.isInteger(kdf.t) || kdf.t <= 0 || kdf.t > MAX_ARGON2ID_T) {
      throw new KeyWrappingError(`argon2id time cost out of range ${String(kdf.t)}`);
    }
    if (!Number.isInteger(kdf.p) || kdf.p <= 0 || kdf.p > MAX_ARGON2ID_P) {
      throw new KeyWrappingError(`argon2id parallelism out of range ${String(kdf.p)}`);
    }
    return;
  }
  throw new KeyWrappingError(`unsupported kdf algorithm ${String((kdf as KdfParams).algorithm)}`);
}

/**
 * Derive an AES-GCM wrapping key from a password, dispatching on the slot's
 * stored KDF algorithm. New slots use Argon2id; legacy slots that
 * were written under PBKDF2-HMAC-SHA-256 stay unwrappable read-only.
 * `validateKdfParams` runs first so a tampered/hostile work factor fails closed.
 */
export async function derivePasswordWrapKey(
  password: string,
  kdf: KdfParams,
): Promise<CryptoKey> {
  validateKdfParams(kdf);
  if (kdf.algorithm === 'Argon2id') {
    return deriveArgon2idWrapKey(password, kdf);
  }
  try {
    // Decode the server-stored salt + import/derive inside the catch so a
    // malformed base64url salt fails closed as KeyWrappingError, not a raw
    // DOMException (validateKdfParams checks shape, not base64url validity).
    const salt = base64UrlToBytes(kdf.salt);
    const baseKey = await crypto.subtle.importKey('raw', utf8Bytes(password), 'PBKDF2', false, [
      'deriveKey',
    ]);
    return await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        iterations: kdf.iterations,
        salt,
      },
      baseKey,
      { name: 'AES-GCM', length: AES_GCM_KEY_BITS },
      false,
      ['encrypt', 'decrypt'],
    );
  } catch (error) {
    if (error instanceof KeyWrappingError) throw error;
    throw new KeyWrappingError('password wrap-key derivation failed (malformed kdf salt)');
  }
}

/**
 * Derive an AES-256-GCM wrapping key from a password via Argon2id,
 * using the slot's stored m/t/p + base64url salt. `hash-wasm` runs the KDF in
 * a bundled WASM module (no runtime fetch; CSP `'wasm-unsafe-eval'`). Returns
 * the raw 32-byte digest imported as a non-extractable AES-GCM key.
 */
export async function deriveArgon2idWrapKey(
  password: string,
  kdf: Argon2idKdfParams,
): Promise<CryptoKey> {
  try {
    // Decode the server-stored salt + derive inside the catch so a malformed
    // base64url salt fails closed as KeyWrappingError, not a raw DOMException.
    const salt = base64UrlToBytes(kdf.salt);
    const digest = await argon2id({
      password: utf8Bytes(password),
      salt,
      memorySize: kdf.m,
      iterations: kdf.t,
      parallelism: kdf.p,
      hashLength: ARGON2ID_HASH_BYTES,
      outputType: 'binary',
    });
    // Copy into a fresh ArrayBuffer-backed view so the key material is a
    // `BufferSource` over a plain `ArrayBuffer` (not `ArrayBufferLike`) for
    // WebCrypto's TS5.9 generics — mirrors {@link randomBytes}.
    const keyBytes = new Uint8Array(digest.length);
    keyBytes.set(digest);
    return await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-GCM', length: AES_GCM_KEY_BITS },
      false,
      ['encrypt', 'decrypt'],
    );
  } catch (error) {
    if (error instanceof KeyWrappingError) throw error;
    throw new KeyWrappingError('argon2id wrap-key derivation failed (malformed kdf salt)');
  }
}

/**
 * Derive the recovery wrapping key from the high-entropy recovery secret via
 * HKDF-SHA-256. The recovery key is its own >=128-bit entropy source, so no
 * PBKDF2 stretching is needed.
 */
async function deriveRecoveryWrapKey(
  recoverySecret: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', recoverySecret, 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: utf8Bytes(RECOVERY_WRAP_LABEL),
    },
    baseKey,
    { name: 'AES-GCM', length: AES_GCM_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Wrap the HDK with an AES-256-GCM key, nonce-prefixing the ciphertext. */
async function wrapHdk(
  hdk: CryptoKey,
  wrapKey: CryptoKey,
  aad: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const hdkBytes = await crypto.subtle.exportKey('raw', hdk);
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad },
    wrapKey,
    hdkBytes,
  );
  const combined = new Uint8Array(nonce.length + wrapped.byteLength);
  combined.set(nonce, 0);
  combined.set(new Uint8Array(wrapped), nonce.length);
  return bytesToBase64Url(combined);
}

/** Unwrap a nonce-prefixed AES-256-GCM wrap back into the HDK. */
async function unwrapHdk(
  wrappedKey: string,
  wrapKey: CryptoKey,
  aad: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  let rawHdk: ArrayBuffer;
  try {
    // Decode + decrypt + import all inside the catch so a malformed server
    // base64url `wrappedKey` surfaces as KeyWrappingError, not a raw DOMException.
    const combined = base64UrlToBytes(wrappedKey);
    const nonce = combined.subarray(0, GCM_NONCE_BYTES);
    const ciphertext = combined.subarray(GCM_NONCE_BYTES);
    rawHdk = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad },
      wrapKey,
      ciphertext,
    );
  } catch {
    // Malformed wrappedKey, wrong secret, tampered ciphertext, or tampered slot
    // metadata (AAD) — all fail closed as a single domain error.
    throw new KeyWrappingError('slot unwrap failed (malformed or auth tag mismatch)');
  }
  return importHdk(rawHdk);
}

function newPbkdf2Kdf(): KdfParams {
  return {
    algorithm: 'PBKDF2-HMAC-SHA-256',
    iterations: DEFAULT_PBKDF2_ITERATIONS,
    salt: bytesToBase64Url(randomBytes(SALT_BYTES)),
  };
}

/** Fresh Argon2id KDF params for a new password slot. */
function newArgon2idKdf(): Argon2idKdfParams {
  return {
    algorithm: 'Argon2id',
    m: DEFAULT_ARGON2ID_M,
    t: DEFAULT_ARGON2ID_T,
    p: DEFAULT_ARGON2ID_P,
    salt: bytesToBase64Url(randomBytes(SALT_BYTES)),
  };
}

/** Encode raw recovery-key bytes as a grouped, uppercase hex display string. */
function encodeRecoveryKey(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += RECOVERY_GROUP_SIZE) {
    groups.push(hex.slice(i, i + RECOVERY_GROUP_SIZE));
  }
  return groups.join('-');
}

/** Decode a grouped recovery display string back into its raw bytes. */
function decodeRecoveryKey(display: string): Uint8Array<ArrayBuffer> {
  const hex = display.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length === 0 || hex.length % 2 !== 0) {
    throw new KeyWrappingError('malformed recovery key');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Build a password unlock slot from a fully-specified KDF: derive the wrap key,
 * AES-256-GCM-wrap the HDK with the slot metadata bound in AAD. Shared by
 * the Argon2id (default) and the now-dead PBKDF2 builders so the slot assembly
 * lives in one place.
 */
async function buildPasswordSlot(
  householdId: string,
  slotId: string,
  password: string,
  hdk: CryptoKey,
  kdf: KdfParams,
): Promise<KeyEnvelopeSlot> {
  const wrapKey = await derivePasswordWrapKey(password, kdf);
  const aad = canonicalSlotAad({ slotType: 'password', kdf, encryptionVersion: 1 });
  const wrappedKey = await wrapHdk(hdk, wrapKey, aad);
  const now = new Date().toISOString();
  return {
    householdId,
    slotId,
    slotType: 'password',
    kdf,
    wrappedKey,
    encryptionVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Build a password unlock slot with an Argon2id wrap key: fresh
 * random salt + the m=65536/t=3/p=4 baseline, AES-256-GCM wrap of the HDK.
 */
export function generateArgon2idPasswordSlot(
  householdId: string,
  slotId: string,
  password: string,
  hdk: CryptoKey,
): Promise<KeyEnvelopeSlot> {
  return buildPasswordSlot(householdId, slotId, password, hdk, newArgon2idKdf());
}

/**
 * Build a password unlock slot with a legacy PBKDF2 wrap key. Dead-code
 * — new slots use {@link generateArgon2idPasswordSlot}; retained only
 * so the PBKDF2 wrap path stays exercisable in tests for backward-compat.
 */
export function generatePbkdf2PasswordSlot(
  householdId: string,
  slotId: string,
  password: string,
  hdk: CryptoKey,
): Promise<KeyEnvelopeSlot> {
  return buildPasswordSlot(householdId, slotId, password, hdk, newPbkdf2Kdf());
}

/**
 * Build the default password unlock slot. Argon2id is the default for new
 * password slots (replacing the earlier PBKDF2 default); the
 * PBKDF2 generation path is dead-code but its unwrap path stays live for
 * pre-existing legacy slots.
 */
export function generatePasswordSlot(
  householdId: string,
  slotId: string,
  password: string,
  hdk: CryptoKey,
): Promise<KeyEnvelopeSlot> {
  return generateArgon2idPasswordSlot(householdId, slotId, password, hdk);
}

/**
 * Build a recovery unlock slot. Generates a >=128-bit recovery key, wraps the
 * HDK with a key derived from it, and returns the slot plus the grouped display
 * string the user must save. The raw recovery bytes are never persisted.
 */
export async function generateRecoverySlot(
  householdId: string,
  slotId: string,
  hdk: CryptoKey,
): Promise<{ slot: KeyEnvelopeSlot; recoveryKey: string }> {
  const recoveryBytes = randomBytes(RECOVERY_ENTROPY_BYTES);
  const recoveryKey = encodeRecoveryKey(recoveryBytes);
  const wrapKey = await deriveRecoveryWrapKey(recoveryBytes);
  const aad = canonicalSlotAad({ slotType: 'recovery', encryptionVersion: 1 });
  const wrappedKey = await wrapHdk(hdk, wrapKey, aad);
  const now = new Date().toISOString();
  const slot: KeyEnvelopeSlot = {
    householdId,
    slotId,
    slotType: 'recovery',
    wrappedKey,
    encryptionVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  return { slot, recoveryKey };
}

/**
 * Build a `passkey_prf` unlock slot: wraps the HDK under a wrap key already
 * derived from the authenticator's PRF output (see crypto/passkey-prf.ts), with
 * the slot metadata bound in AAD. PRF slots carry no `kdf` — the
 * authenticator secret is the high-entropy IKM — so the wrap AAD binds only
 * `slotType` + `encryptionVersion` (mirrors the recovery slot and
 * {@link unwrapPrfSlot}). `credentialBinding` is the WebAuthn credential ID the
 * slot is bound to; it is NOT in the per-slot wrap AAD — its integrity is
 * carried by the household envelope-set tag (which canonicalizes
 * `credentialBinding`), so a server cannot silently rebind the slot to a
 * different credential without breaking the set tag.
 */
export async function generatePasskeyPrfSlot(
  householdId: string,
  slotId: string,
  prfWrapKey: CryptoKey,
  hdk: CryptoKey,
  prfSalt: string,
  credentialId: string,
): Promise<KeyEnvelopeSlot> {
  const aad = canonicalSlotAad({ slotType: 'passkey_prf', encryptionVersion: 1 });
  const wrappedKey = await wrapHdk(hdk, prfWrapKey, aad);
  const now = new Date().toISOString();
  return {
    householdId,
    slotId,
    slotType: 'passkey_prf',
    credentialBinding: credentialId,
    prfSalt,
    wrappedKey,
    encryptionVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Unwrap a slot back to the HDK. For password slots `secret` is the password
 * string; for recovery slots it is the grouped recovery display string (or its
 * raw bytes). Throws {@link KeyWrappingError} on any failure.
 */
export async function unwrapSlot(
  slot: KeyEnvelopeSlot,
  secret: string | ArrayBuffer,
): Promise<CryptoKey> {
  if (slot.slotType === 'password') {
    if (typeof secret !== 'string') {
      throw new KeyWrappingError('password slot requires a string secret');
    }
    if (!slot.kdf) throw new KeyWrappingError('password slot missing kdf metadata');
    const wrapKey = await derivePasswordWrapKey(secret, slot.kdf);
    const aad = canonicalSlotAad({
      slotType: 'password',
      kdf: slot.kdf,
      encryptionVersion: slot.encryptionVersion,
    });
    return unwrapHdk(slot.wrappedKey, wrapKey, aad);
  }
  if (slot.slotType === 'recovery') {
    const recoveryBytes =
      typeof secret === 'string' ? decodeRecoveryKey(secret) : new Uint8Array(secret);
    const wrapKey = await deriveRecoveryWrapKey(recoveryBytes);
    const aad = canonicalSlotAad({
      slotType: 'recovery',
      encryptionVersion: slot.encryptionVersion,
    });
    return unwrapHdk(slot.wrappedKey, wrapKey, aad);
  }
  throw new KeyWrappingError(`unsupported slot type ${slot.slotType}`);
}

/**
 * Unwrap a `passkey_prf` slot back to the HDK using a wrap key already derived
 * from the authenticator's PRF output (see crypto/passkey-prf.ts). PRF slots
 * carry no `kdf` — the authenticator secret is the high-entropy IKM — so the
 * wrap AAD binds only `slotType` + `encryptionVersion` (mirrors the recovery
 * slot). Throws {@link KeyWrappingError} on any failure so the caller can fall
 * back to password unlock. The PRF wrap-key derivation lives in passkey-prf.ts
 * so this module stays free of WebAuthn concerns.
 */
export function unwrapPrfSlot(slot: KeyEnvelopeSlot, prfWrapKey: CryptoKey): Promise<CryptoKey> {
  if (slot.slotType !== 'passkey_prf') {
    throw new KeyWrappingError(`expected passkey_prf slot, got ${slot.slotType}`);
  }
  const aad = canonicalSlotAad({
    slotType: 'passkey_prf',
    encryptionVersion: slot.encryptionVersion,
  });
  return unwrapHdk(slot.wrappedKey, prfWrapKey, aad);
}

/**
 * Derive the envelope-set MAC key from the HDK via HKDF-SHA-256. Keyed by
 * the HDK so any unlock method that recovers the HDK can verify the full set.
 */
async function deriveEnvelopeMacKey(hdk: CryptoKey): Promise<CryptoKey> {
  const hdkBytes = await crypto.subtle.exportKey('raw', hdk);
  const baseKey = await crypto.subtle.importKey('raw', hdkBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: utf8Bytes(ENVELOPE_AUTH_LABEL),
    },
    baseKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Canonical bytes over the slot set + version. Slots are sorted by
 * `slotId` and reduced to integrity-relevant fields so wire-order or volatile
 * timestamps do not change the tag, while stripping/reorder/injection do.
 */
function canonicalEnvelopeSet(
  slots: KeyEnvelopeSlot[],
  envelopeSetVersion: number,
): Uint8Array<ArrayBuffer> {
  const ordered = [...slots]
    .sort((a, b) => (a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0))
    .map((slot) => ({
      credentialBinding: slot.credentialBinding ?? null,
      encryptionVersion: slot.encryptionVersion,
      householdId: slot.householdId,
      kdf: slot.kdf ?? null,
      prfSalt: slot.prfSalt ?? null,
      slotId: slot.slotId,
      slotType: slot.slotType,
      wrappedKey: slot.wrappedKey,
    }));
  return canonicalJsonBytes({ envelopeSetVersion, slots: ordered });
}

/**
 * Compute the household envelope-set tag: HMAC-SHA-256 under the
 * HDK-derived MAC key over the canonical slot set + version. base64url.
 */
export async function computeEnvelopeSetTag(
  slots: KeyEnvelopeSlot[],
  envelopeSetVersion: number,
  hdk: CryptoKey,
): Promise<string> {
  const macKey = await deriveEnvelopeMacKey(hdk);
  const signature = await crypto.subtle.sign(
    'HMAC',
    macKey,
    canonicalEnvelopeSet(slots, envelopeSetVersion),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

/**
 * An envelope-set version strictly below the locally pinned value is a genuine
 * rollback (mirrors {@link isRollback} in freshness.ts). The MAC alone
 * cannot catch this: a server can replay an older slot set with its own valid
 * tag, so a device holding the newer counter must compare versions too. Equal
 * or higher is accepted; first-contact (pinned 0) accepts any non-negative
 * served version as the TOFU pin.
 */
export function isEnvelopeSetRollback(servedVersion: number, pinnedVersion: number): boolean {
  return servedVersion < pinnedVersion;
}

/** The wire algorithm string for an encrypted aggregate payload. */
const ENCRYPTED_ENVELOPE_ALG = 'AES-256-GCM';

/** Every key the envelope shape may carry — anything else fails the guard.
 * Mirrors the server's
 *  `ENVELOPE_KEYS` in apps/api/src/common/encrypted-envelope.ts. */
const ENVELOPE_KEYS = new Set([
  'encryptionVersion',
  'keyId',
  'alg',
  'nonce',
  'ciphertext',
  'aadVersion',
]);

/**
 * Strict structural guard for an encrypted aggregate payload. The previous loose check (`encryptionVersion !== undefined`) misfires
 * on a domain payload that happens to carry an `encryptionVersion` field and
 * would trigger a false decrypt attempt. This requires ALL of the
 * envelope's load-bearing fields and the exact `alg` byte string, so a
 * plaintext payload can never be mistaken for ciphertext. The optional
 * `aadVersion?: number` reserved field is allowed — present-and-number or
 * absent both pass; any other type fails. No key outside the documented shape
 * is allowed — this producer
 * (`encryptPayload`, payload-crypto.ts) never emits one, so the tightening
 * cannot reject anything this client has ever written.
 *
 * Shared between the client sync path (`sync/sync-client.ts`) and the API/
 * compactor encrypted-replacement logic so "is this an encrypted envelope" has
 * one definition.
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
  // Optional reserved field: allow absent, reject a non-number.
  if (p.aadVersion !== undefined && typeof p.aadVersion !== 'number') return false;
  if (!Object.keys(p).every((k) => ENVELOPE_KEYS.has(k))) return false;
  return true;
}

/**
 * localStorage key for {@link readEnvelopeSetPinFloor} / {@link raiseEnvelopeSetPinFloor},
 * scoped to a single household:
 * `deviceMetadata` — and the whole IndexedDB working store — is dropped
 * wholesale on an account switch (`user-transition.ts`), but this
 * independent localStorage fallback is not touched by that drop. An
 * unscoped key would let a floor raised for one household on this device
 * survive a switch and incorrectly block a *different* household signing in
 * afterwards with a genuinely lower envelope version.
 */
function envelopeSetPinFloorKey(householdId: string): string {
  return `envelopeSetPinFloor:${householdId}`;
}

/**
 * Read the localStorage-backed rollback floor for `householdId`. This is a
 * SEPARATE, independent backstop to the `deviceMetadata` pin:
 * a caller raises it directly
 * (via {@link raiseEnvelopeSetPinFloor}) when the durable IndexedDB pin write
 * itself fails, so `readEnvelopeSetPin` still rejects a replay of the version
 * that failed write was retiring, even though `deviceMetadata` was never
 * updated. Never throws — storage can be unavailable (quota, private
 * browsing) or absent (non-DOM test environment). Returns 0 when
 * `householdId` is unknown (no session to scope the floor to).
 */
function readEnvelopeSetPinFloor(householdId: string | undefined): number {
  if (!householdId || typeof localStorage === 'undefined') return 0;
  try {
    const raw = localStorage.getItem(envelopeSetPinFloorKey(householdId));
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/**
 * Best-effort, monotonic raise of the localStorage rollback floor for
 * `householdId` to at least `version` (never lowers it). Called when a
 * durable `deviceMetadata` pin write has failed but the version must still
 * be treated as the new minimum — fail closed against replay rather than
 * merely locking the current session.
 *
 * Never throws, but DOES verify: `localStorage.setItem` can return without
 * throwing yet not actually persist the value (pre-2017 Safari private
 * browsing silently no-ops; a write landing exactly on a quota boundary can
 * behave the same way in some engines), which would otherwise leave this
 * device with no durable record at all that the version advanced — while the
 * caller believes the fallback succeeded. Re-reads the key after writing and
 * returns `true` only when the stored value is confirmed to be at least
 * `version`; a `false` return means the caller must treat this as a hard
 * failure, not as a degraded-but-successful raise.
 */
export function raiseEnvelopeSetPinFloor(version: number, householdId: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  const key = envelopeSetPinFloorKey(householdId);
  try {
    if (version > readEnvelopeSetPinFloor(householdId)) {
      localStorage.setItem(key, String(version));
    }
    const confirmed = localStorage.getItem(key);
    const parsed = confirmed === null ? 0 : Number.parseInt(confirmed, 10);
    return Number.isFinite(parsed) && parsed >= version;
  } catch {
    // Storage unavailable — nothing more this device can do; the caller's
    // own fail-closed handling (locking the session) still applies.
    return false;
  }
}

/**
 * Read this device's pinned envelope-set version for `householdId` from
 * `deviceMetadata`. Returns 0 (TOFU first contact — accepts
 * any non-negative served version) when no metadata row or no pin exists
 * yet. Takes the max against {@link readEnvelopeSetPinFloor} — scoped to the
 * SAME `householdId` — so a version raised there —
 * because the `deviceMetadata` pin write itself failed — is still enforced,
 * without leaking into a different household's pin on the same device.
 */
export async function readEnvelopeSetPin(householdId: string | undefined): Promise<number> {
  const meta = await readDeviceMetadata();
  return Math.max(meta?.envelopeSetVersion ?? 0, readEnvelopeSetPinFloor(householdId));
}

/**
 * Thrown by {@link writeEnvelopeSetPin} when the caller-supplied `isStale`
 * check reports a session/household switch AFTER this call's own internal
 * awaits (the existence probe, or `updateDeviceMetadata`'s read) but BEFORE
 * the pin write commits. `deviceMetadata` is a single
 * unscoped `'self'` row per physical IndexedDB, so a cross-household logout
 * that drops and recreates that database strictly inside one of those awaits
 * would otherwise let this write land in the NEW household's freshly-created
 * row, corrupting ITS rollback pin. This abort makes the write atomically
 * conditional on the captured session instead: the caller's write never
 * lands on a household it wasn't computed for. Callers that pass no
 * `isStale` keep the prior unconditional behaviour (e.g. this module's own
 * `readEnvelopeSetPin`-adjacent pinning of the OLD version, which is not on
 * the corruption path this guards).
 */
export class EnvelopeSetPinAbortedError extends KeyWrappingError {
  constructor(public readonly servedVersion: number) {
    super(
      `Envelope-set pin write at version ${servedVersion} aborted: the session changed before the write could commit`,
    );
    this.name = 'EnvelopeSetPinAbortedError';
  }
}

/**
 * Advance this device's pinned envelope-set version after a successful
 * verification. Monotonic: stores `max(existingPin,
 * servedVersion)` so a later legitimate-but-lower fetch never lowers the pin.
 *
 * When there is no `deviceMetadata` row yet (the device has not synced) the pin
 * MUST still be persisted if we know the `deviceId` — otherwise setup/rotation
 * that runs before the first sync write leaves the pin at 0, and a later replay
 * of an old valid set passes the rollback check (`isEnvelopeSetRollback(N, 0)`
 * is false for all N > 0). So when `meta` is absent we seed a minimal row from
 * `deviceId` carrying the pin; the next sync round-trip fills the rest. Without
 * a `deviceId` we cannot seed a valid row (it lives alongside `deviceId`), so we
 * keep the historical no-op for callers that have no `deviceId` in scope.
 *
 * `isStale`, when supplied, is re-checked right after each of this
 * function's own internal awaits (the existence probe below, and again
 * inside the `updateDeviceMetadata` updater, which runs synchronously right
 * after that call's own internal read) so a session/household switch that
 * lands inside either await ABORTS the write — throwing
 * {@link EnvelopeSetPinAbortedError} — before anything is put to the
 * singleton row, instead of only being noticed afterward once it may already
 * have landed on the wrong household.
 */
export async function writeEnvelopeSetPin(
  servedVersion: number,
  deviceId?: string,
  isStale?: () => boolean,
): Promise<void> {
  // Existence probe ONLY for the historical no-op cases (no row + nothing
  // to seed). The pin merge itself runs inside the atomic
  // `updateDeviceMetadata` transaction: the unlock/rotation flows calling
  // this sit OUTSIDE the SyncContext mutex, so a stale full-row spread here
  // could revert a concurrently-persisted `syncCursor`/`freshnessCounter`
  // (a lost-update).
  const probe = await readDeviceMetadata();
  if (isStale?.()) throw new EnvelopeSetPinAbortedError(servedVersion);
  if (!probe && (!deviceId || servedVersion <= 0)) return;
  const seedDeviceId = deviceId ?? probe?.deviceId;
  if (!seedDeviceId) return;
  await updateDeviceMetadata((current) => {
    // Re-check immediately after `updateDeviceMetadata`'s own internal read
    // (this updater runs synchronously right after that await resolves, with
    // no further await before the write commits) — the last point at which
    // the write can still be refused instead of committed.
    if (isStale?.()) throw new EnvelopeSetPinAbortedError(servedVersion);
    return current
      ? {
          ...current,
          envelopeSetVersion: Math.max(
            current.envelopeSetVersion ?? 0,
            servedVersion,
          ),
        }
      : {
          deviceId: seedDeviceId,
          syncCursor: '0',
          lastSyncedAt: null,
          displayName: 'This device',
          envelopeSetVersion: servedVersion,
        };
  });
}

/**
 * Verify the envelope-set tag. Throws {@link KeyWrappingError} on mismatch
 * — slot stripping/reorder/injection or an envelope-set-version mismatch. A
 * replay of an older set under its own valid tag is caught by pairing this with
 * {@link isEnvelopeSetRollback} against the locally pinned version.
 */
export async function verifyEnvelopeSetTag(
  slots: KeyEnvelopeSlot[],
  integrity: EnvelopeSetIntegrity,
  hdk: CryptoKey,
): Promise<void> {
  let ok: boolean;
  try {
    // Decode the server-stored base64url tag + derive/verify inside the catch so
    // a malformed envelopeSetTag fails closed as KeyWrappingError, not a raw
    // DOMException from atob.
    const macKey = await deriveEnvelopeMacKey(hdk);
    ok = await crypto.subtle.verify(
      'HMAC',
      macKey,
      base64UrlToBytes(integrity.envelopeSetTag),
      canonicalEnvelopeSet(slots, integrity.envelopeSetVersion),
    );
  } catch {
    throw new KeyWrappingError('envelope-set tag verification failed (malformed tag)');
  }
  if (!ok) throw new KeyWrappingError('envelope-set tag verification failed (tamper or rollback)');
}
