// HDK generation, per-slot AES-256-GCM wrapping and the envelope-set HMAC; see docs/security.md "Encryption".
// AES-GCM, not AES-KW (no AAD); new password slots use Argon2id via WASM (CSP 'wasm-unsafe-eval'); PBKDF2 unwrap only.
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
// OWASP 2023 PBKDF2-HMAC-SHA-256 baseline.
const DEFAULT_PBKDF2_ITERATIONS = 600_000;
// Caps a hostile server-stored `kdf.iterations` (10x baseline) that would hang unlock.
const MAX_PBKDF2_ITERATIONS = 2_000_000;
// OWASP 2024 interactive Argon2id baseline: 64 MiB, 3 passes, 4 lanes.
const DEFAULT_ARGON2ID_M = 65_536;
const DEFAULT_ARGON2ID_T = 3;
const DEFAULT_ARGON2ID_P = 4;
// Caps on server-stored Argon2id params: a hostile server could send a multi-GiB `m` (OOM) or a huge `t`/`p` (hang).
// Equal to the baseline; a future raise bumps the defaults and these caps together.
const MAX_ARGON2ID_M = 65_536;
const MAX_ARGON2ID_T = 10;
const MAX_ARGON2ID_P = 16;
const ARGON2ID_HASH_BYTES = 32;
// HKDF info labels: domain-separate the MAC key and the recovery IKM.
const ENVELOPE_AUTH_LABEL = 'envelope-auth';
const RECOVERY_WRAP_LABEL = 'recovery-wrap';
const RECOVERY_GROUP_SIZE = 4;

// Allocates the view itself: `getRandomValues` returns `Uint8Array<ArrayBufferLike>`, which WebCrypto's `BufferSource`
// rejects (TS 5.9).
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

/** Generates a fresh 256-bit AES-GCM household data key. */
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

// Wrap AAD: binds slotType, KDF params and version, so a tampering server fails the unlock closed.
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
 * Validates server-stored KDF params before they drive a derivation; a hostile algorithm, salt or out-of-range work
 * factor throws {@link KeyWrappingError}.
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
 * Derives an AES-GCM wrap key from a password, dispatching on the slot's KDF; validates params first so a hostile work
 * factor fails closed.
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
    // Inside the try so a malformed server-stored base64url value fails closed as KeyWrappingError, not a raw
    // DOMException.
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
 * Derives the AES-GCM wrap key from a password via Argon2id (`hash-wasm`, bundled WASM) using the slot's m/t/p and
 * salt.
 */
export async function deriveArgon2idWrapKey(
  password: string,
  kdf: Argon2idKdfParams,
): Promise<CryptoKey> {
  try {
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

// The recovery key is its own >=128-bit entropy source, so HKDF suffices; no PBKDF2 stretching.
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

async function unwrapHdk(
  wrappedKey: string,
  wrapKey: CryptoKey,
  aad: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  let rawHdk: ArrayBuffer;
  try {
    const combined = base64UrlToBytes(wrappedKey);
    const nonce = combined.subarray(0, GCM_NONCE_BYTES);
    const ciphertext = combined.subarray(GCM_NONCE_BYTES);
    rawHdk = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad },
      wrapKey,
      ciphertext,
    );
  } catch {
    // Every failure (malformed, wrong secret, tampered ciphertext or AAD) fails closed as one error.
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

function newArgon2idKdf(): Argon2idKdfParams {
  return {
    algorithm: 'Argon2id',
    m: DEFAULT_ARGON2ID_M,
    t: DEFAULT_ARGON2ID_T,
    p: DEFAULT_ARGON2ID_P,
    salt: bytesToBase64Url(randomBytes(SALT_BYTES)),
  };
}

function encodeRecoveryKey(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += RECOVERY_GROUP_SIZE) {
    groups.push(hex.slice(i, i + RECOVERY_GROUP_SIZE));
  }
  return groups.join('-');
}

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

/** Password slot with an Argon2id wrap key: fresh salt and the m=65536/t=3/p=4 baseline. */
export function generateArgon2idPasswordSlot(
  householdId: string,
  slotId: string,
  password: string,
  hdk: CryptoKey,
): Promise<KeyEnvelopeSlot> {
  return buildPasswordSlot(householdId, slotId, password, hdk, newArgon2idKdf());
}

/** Password slot with a legacy PBKDF2 wrap key; unused for new slots, kept so the PBKDF2 wrap path stays testable. */
export function generatePbkdf2PasswordSlot(
  householdId: string,
  slotId: string,
  password: string,
  hdk: CryptoKey,
): Promise<KeyEnvelopeSlot> {
  return buildPasswordSlot(householdId, slotId, password, hdk, newPbkdf2Kdf());
}

/** Default password slot: Argon2id. */
export function generatePasswordSlot(
  householdId: string,
  slotId: string,
  password: string,
  hdk: CryptoKey,
): Promise<KeyEnvelopeSlot> {
  return generateArgon2idPasswordSlot(householdId, slotId, password, hdk);
}

/**
 * Recovery slot: wraps the HDK under a key derived from a fresh >=128-bit recovery key. Returns the slot and the
 * grouped display string the user must save; the raw bytes are never persisted.
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
 * `passkey_prf` slot: wraps the HDK under a wrap key already derived from the authenticator's PRF output. The wrap AAD
 * binds only `slotType` and `encryptionVersion` (no `kdf`, like the recovery slot). `credentialBinding` is not in the
 * wrap AAD: the envelope-set tag canonicalises it, so a server cannot rebind the slot undetected.
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
 * Unwraps a password slot (`secret` is the password) or recovery slot (display string or raw bytes) to the HDK. Throws
 * {@link KeyWrappingError}.
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
 * Unwraps a `passkey_prf` slot with a PRF-derived wrap key (see crypto/passkey-prf.ts); the AAD binds only `slotType`
 * and `encryptionVersion`. Throws {@link KeyWrappingError} so the caller can fall back to password unlock.
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

// Keyed by the HDK so any unlock method that recovers it can verify the whole set.
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

// Slots are sorted by `slotId` and reduced to integrity-relevant fields, so wire order and volatile timestamps do not
// change the tag but stripping, reorder and injection do.
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

/** Envelope-set tag: base64url HMAC-SHA-256 under the HDK-derived key over the canonical slot set and version. */
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
 * A served version below the pinned one is a rollback. The MAC alone cannot catch it (a server can replay an older set
 * under its own valid tag); first contact (pinned 0) accepts any non-negative version (TOFU).
 */
export function isEnvelopeSetRollback(servedVersion: number, pinnedVersion: number): boolean {
  return servedVersion < pinnedVersion;
}

const ENCRYPTED_ENVELOPE_ALG = 'AES-256-GCM';

// Every key the envelope may carry; mirrors `ENVELOPE_KEYS` in apps/api/src/common/encrypted-envelope.ts.
const ENVELOPE_KEYS = new Set([
  'encryptionVersion',
  'keyId',
  'alg',
  'nonce',
  'ciphertext',
  'aadVersion',
]);

/**
 * Strict structural guard for an encrypted payload: requires every load-bearing field and the exact `alg`, and allows
 * no key outside the documented shape, so a plaintext payload that merely carries `encryptionVersion` is never taken
 * for ciphertext. Shared by the client sync path and the API/compactor so "is this an encrypted envelope" has one
 * definition.
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

// Scoped per household: `deviceMetadata` and the IDB are dropped on an account switch but this localStorage fallback
// is not, so an unscoped floor would block a different household with a genuinely lower version.
function envelopeSetPinFloorKey(householdId: string): string {
  return `envelopeSetPinFloor:${householdId}`;
}

// Independent localStorage backstop to the `deviceMetadata` pin: raised when the durable pin write fails, so a replay
// of that version is still rejected. Never throws; 0 when unscoped or storage is unavailable.
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
 * Raises the localStorage rollback floor for `householdId` to at least `version` (never lowers it), for when the
 * durable `deviceMetadata` pin write failed. Never throws, but verifies: `setItem` can return without persisting (old
 * Safari private browsing, a write on a quota boundary), so it re-reads and returns `true` only when the stored value
 * is confirmed. A `false` return is a hard failure for the caller.
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
    // Storage unavailable; the caller's fail-closed handling still applies.
    return false;
  }
}

/**
 * This device's pinned envelope-set version: 0 (TOFU first contact) without metadata, else the max with the same
 * household's localStorage floor.
 */
export async function readEnvelopeSetPin(householdId: string | undefined): Promise<number> {
  const meta = await readDeviceMetadata();
  return Math.max(meta?.envelopeSetVersion ?? 0, readEnvelopeSetPinFloor(householdId));
}

/**
 * Thrown by {@link writeEnvelopeSetPin} when `isStale` reports a session switch before the pin write commits:
 * `deviceMetadata` is one unscoped `'self'` row per IDB, so a cross-household logout recreating the database mid-write
 * would otherwise land the pin on the new household's row and corrupt its rollback pin.
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
 * Advances the pinned envelope-set version after a successful verification; monotonic (`max(existing, served)`). With
 * no `deviceMetadata` row yet it seeds a minimal row from `deviceId`, since a pin left at 0 before the first sync would
 * let a replay of an old valid set pass; without a `deviceId` it is a no-op. `isStale` is re-checked after each
 * internal await and aborts with {@link EnvelopeSetPinAbortedError} before anything is written.
 */
export async function writeEnvelopeSetPin(
  servedVersion: number,
  deviceId?: string,
  isStale?: () => boolean,
): Promise<void> {
  // Probe only for the no-row, nothing-to-seed no-ops. The merge runs in the atomic `updateDeviceMetadata` transaction
  // because the unlock and rotation callers sit outside the SyncContext mutex, so a stale full-row spread could revert
  // a concurrent `syncCursor`/`freshnessCounter`.
  const probe = await readDeviceMetadata();
  if (isStale?.()) throw new EnvelopeSetPinAbortedError(servedVersion);
  if (!probe && (!deviceId || servedVersion <= 0)) return;
  const seedDeviceId = deviceId ?? probe?.deviceId;
  if (!seedDeviceId) return;
  await updateDeviceMetadata((current) => {
    // Last point the write can still be refused: this updater runs right after updateDeviceMetadata's read, with no
    // await before the commit.
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
 * Verifies the envelope-set tag; throws {@link KeyWrappingError} on stripping, reorder, injection or a version
 * mismatch. Pair with {@link isEnvelopeSetRollback} to catch a replay of an older set.
 */
export async function verifyEnvelopeSetTag(
  slots: KeyEnvelopeSlot[],
  integrity: EnvelopeSetIntegrity,
  hdk: CryptoKey,
): Promise<void> {
  let ok: boolean;
  try {
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
