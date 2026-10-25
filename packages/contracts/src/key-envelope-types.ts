/** Credential that unwraps a key-envelope slot; `oidc` is inert plumbing, no external login is enabled. */
export const SLOT_TYPES = ['password', 'recovery', 'passkey_prf', 'oidc'] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

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

/** The exact phrase the user must type to reset the encrypted workspace. */
export const ENCRYPTED_WORKSPACE_RESET_PHRASE = 'DELETE';
