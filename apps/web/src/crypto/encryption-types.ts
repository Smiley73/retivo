// Wire and storage shapes for the zero-knowledge encryption boundary (types only); see docs/security.md "Encryption".
import type { KdfParams, SlotType } from '@retirement/contracts';

export type {
  Argon2idKdfParams,
  KdfParams,
  Pbkdf2KdfParams,
  SlotType,
} from '@retirement/contracts';

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
