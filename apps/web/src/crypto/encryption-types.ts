/**
 * Type definitions for zero-knowledge payload encryption (see "Encryption"
 * in docs/security.md).
 *
 * These are the wire/storage shapes for the client-side encryption boundary:
 * the encrypted aggregate payload envelope, the per-slot key envelopes +
 * household-level envelope-set integrity, the freshness head, and the
 * device-local HDK cache form. This module is types only.
 */

/**
 * Encrypted form of a single synced aggregate payload. The server stores this
 * opaquely; only `nonce` + `ciphertext` carry data, and neither reveals any
 * domain field. `keyId` identifies the HDK generation that encrypted it.
 */
export interface EncryptedPayloadEnvelope {
  encryptionVersion: 1;
  keyId: string;
  alg: 'AES-256-GCM';
  /** base64url-encoded 12-byte GCM nonce. */
  nonce: string;
  /** base64url-encoded GCM ciphertext (includes the auth tag). */
  ciphertext: string;
  /** Reserved for a future AAD-shape revision; absent means the v1 shape. */
  aadVersion?: number;
}

/**
 * Stable-identity fields bound into the AES-GCM AAD. Only fields
 * that any device reproduces byte-identically after hourly snapshot compaction
 * — deliberately excludes `operation`, `version`, `updatedAt`, `deviceId`.
 */
export interface AadMetadata {
  householdId: string;
  aggregateId: string;
  aggregateType: string;
  encryptionVersion: number;
}

/**
 * Which credential unwraps a given key-envelope slot. `oidc` is inert
 * OIDC-ready plumbing — no external login is enabled.
 */
export type SlotType = 'password' | 'recovery' | 'passkey_prf' | 'oidc';

/** Legacy PBKDF2 KDF parameters for a password slot. */
export interface Pbkdf2KdfParams {
  algorithm: 'PBKDF2-HMAC-SHA-256';
  iterations: number;
  /** base64url-encoded per-slot random salt. */
  salt: string;
}

/**
 * Argon2id KDF parameters for a new password slot. `m` = memory cost in
 * KiB, `t` = time cost (iterations), `p` = parallelism lanes (m=65536,
 * t=3, p=4 — the OWASP 2024 interactive baseline).
 */
export interface Argon2idKdfParams {
  algorithm: 'Argon2id';
  m: number;
  t: number;
  p: number;
  /** base64url-encoded per-slot random salt. */
  salt: string;
}

/** Key-derivation parameters for password/recovery slots. */
export type KdfParams = Pbkdf2KdfParams | Argon2idKdfParams;

/**
 * One unlock slot: an authenticated AES-256-GCM wrap of the HDK, bound (via the
 * wrap AAD) to its own metadata so a server cannot silently substitute a key or
 * downgrade the KDF. `wrappedKey` is base64url.
 */
export interface KeyEnvelopeSlot {
  householdId: string;
  slotId: string;
  slotType: SlotType;
  /** Credential association for password/passkey/OIDC slots. */
  credentialBinding?: string;
  /** Present for password/recovery slots. */
  kdf?: KdfParams;
  /** base64url PRF salt, present for `passkey_prf` slots. */
  prfSalt?: string;
  /** base64url AES-256-GCM wrap of the HDK (nonce-prefixed). */
  wrappedKey: string;
  encryptionVersion: number;
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string;
  /**
   * The credential revision a `password`-type slot was wrapped under
   * (server-written — see
   * `apps/api/src/dynamo/types.ts` → `HouseholdKeyEnvelopeRow.credentialRevision`).
   * Absent on every other slot type, and on a `password` slot written before
   * this field existed. Compared against the server-authored
   * `currentCredentialRevision` on the same `GET /auth/key-envelopes` response
   * to derive whether a re-wrap is owed; never trusted for anything else — the
   * envelope-set tag deliberately excludes it.
   */
  credentialRevision?: string;
}

/**
 * Household-level envelope-set integrity. The monotonic version
 * + HDK-keyed HMAC over the canonical slot set detect slot stripping, reorder,
 * injection, and (on devices holding a newer counter) rollback.
 */
export interface EnvelopeSetIntegrity {
  envelopeSetVersion: number;
  /** base64url HMAC-SHA-256 over the canonical slot set + version. */
  envelopeSetTag: string;
}

/**
 * Freshness head. The client owns the monotonic counter and
 * MACs only the counter (the server-assigned `syncCursor` is deliberately not
 * bound). The server stores both opaquely and never recomputes the MAC.
 */
export interface FreshnessHead {
  freshnessCounter: number;
  /** base64url HMAC-SHA-256 over the canonical counter. */
  cursorTag: string;
}
