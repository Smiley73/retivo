// Wire and storage shapes for the zero-knowledge encryption boundary (types only); see docs/security.md "Encryption".

/** Encrypted aggregate payload; the server stores it opaquely. `keyId` names the HDK generation. */
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
 * Stable-identity fields bound into the AES-GCM AAD: only fields every device reproduces byte-identically after
 * snapshot compaction (so never `operation`, `version`, `updatedAt` or `deviceId`).
 */
export interface AadMetadata {
  householdId: string;
  aggregateId: string;
  aggregateType: string;
  encryptionVersion: number;
}

/** Credential that unwraps a key-envelope slot; `oidc` is inert plumbing, no external login is enabled. */
export type SlotType = 'password' | 'recovery' | 'passkey_prf' | 'oidc';

/** Legacy PBKDF2 KDF parameters for a password slot. */
export interface Pbkdf2KdfParams {
  algorithm: 'PBKDF2-HMAC-SHA-256';
  iterations: number;
  /** base64url-encoded per-slot random salt. */
  salt: string;
}

/**
 * Argon2id parameters for a new password slot: `m` memory KiB, `t` iterations, `p` lanes (OWASP 2024 interactive
 * baseline m=65536, t=3, p=4).
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
 * One unlock slot: an AES-256-GCM wrap of the HDK, bound via the wrap AAD to its own metadata so a server cannot
 * substitute a key or downgrade the KDF.
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
   * Credential revision a `password` slot was wrapped under (server-written); compared with `currentCredentialRevision`
   * to derive whether a re-wrap is owed. Excluded from the envelope-set tag.
   */
  credentialRevision?: string;
}

/**
 * Version plus HDK-keyed HMAC over the canonical slot set: detects slot stripping, reorder, injection and (with a newer
 * local counter) rollback.
 */
export interface EnvelopeSetIntegrity {
  envelopeSetVersion: number;
  /** base64url HMAC-SHA-256 over the canonical slot set + version. */
  envelopeSetTag: string;
}

/**
 * Client-owned counter and its MAC; the server's `syncCursor` is deliberately not bound. The server stores both
 * opaquely.
 */
export interface FreshnessHead {
  freshnessCounter: number;
  /** base64url HMAC-SHA-256 over the canonical counter. */
  cursorTag: string;
}
