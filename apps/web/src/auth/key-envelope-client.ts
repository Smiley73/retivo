// HTTP client for the key-envelope endpoints (`/auth/key-envelopes`: list, activate, upsert).
// The CSRF echo on state-changing calls comes from `apiRequest` (AGENTS.md "Project-specific security").
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import { apiRequest } from '../api/client';
import type { EnvelopeSetIntegrity, KeyEnvelopeSlot } from '../crypto/encryption-types';

/**
 * The key-envelope collection plus envelope-set meta; an envelope-less household gets empty `slots`, version 0 and an
 * empty tag.
 */
export interface KeyEnvelopesResponse extends EnvelopeSetIntegrity {
  slots: KeyEnvelopeSlot[];
  /**
   * The credential's current revision, server-authored on every read (never cached). A `password` slot whose own
   * `credentialRevision` differs (or is absent) is owed a re-wrap. The set tag does not cover it: a forged value can
   * only cause or suppress a prompt, since the tag still gates the wrap/unwrap.
   */
  currentCredentialRevision: string;
}

/** Fetch the household's key-envelope slot set + integrity meta. */
export function getKeyEnvelopes(): Promise<KeyEnvelopesResponse> {
  return apiRequest<KeyEnvelopesResponse>('/api/v1/auth/key-envelopes');
}

// The slot plus the recomputed envelope-set version and tag. `method`/`code`/`response` are the `stepUpProofFields(proof)`
// wire fields, required only when the server says the write needs a proof (the household already holds a slot, unless it
// is an owed post-reset re-wrap) and `AUTH_MFA_ENFORCED` is on. `currentPassword` is the password floor on a
// proof-required `passkey_prf` enrollment write, in either enforcement state; never logged.
interface UpsertKeyEnvelopeSlotBody extends EnvelopeSetIntegrity {
  slot: KeyEnvelopeSlot;
  method?: string;
  code?: string;
  response?: AuthenticationResponseJSON;
  currentPassword?: string;
}

/**
 * Upserts one slot (state-changing). The server writes the slot and bumps the envelope-set meta in one transaction
 * pinned to the exact predecessor version, so the client sends `expectedEnvelopeSetVersion = envelopeSetVersion - 1`; a
 * version that does not advance by exactly one gets `409 STALE_ENVELOPE_VERSION`, on which the caller refetches and
 * retries.
 */
export function upsertKeyEnvelopeSlot(
  slotId: string,
  body: UpsertKeyEnvelopeSlotBody,
): Promise<void> {
  return apiRequest(`/api/v1/auth/key-envelopes/${encodeURIComponent(slotId)}`, {
    method: 'PUT',
    body: {
      ...body,
      expectedEnvelopeSetVersion: body.envelopeSetVersion - 1,
    },
  });
}

// The household's whole initial slot set, always proofless: the server refuses a non-empty set outright.
interface ActivateKeyEnvelopesBody extends EnvelopeSetIntegrity {
  slots: KeyEnvelopeSlot[];
}

/**
 * Atomically activates a household's initial slot set in one request, transaction and version bump, so no
 * "password committed, recovery not yet" state is observable. Rejects with `409 ENVELOPE_SET_NOT_EMPTY` (never
 * `STALE_ENVELOPE_VERSION`) when the household already holds a slot.
 */
export function activateKeyEnvelopes(body: ActivateKeyEnvelopesBody): Promise<void> {
  return apiRequest('/api/v1/auth/key-envelopes/activate', {
    method: 'POST',
    body: {
      ...body,
      expectedEnvelopeSetVersion: body.envelopeSetVersion - 1,
    },
  });
}

/**
 * Confirmation phrase for the encrypted-workspace reset; must match the server's `ENCRYPTED_WORKSPACE_RESET_PHRASE`
 * (`apps/api/src/auth/dto/auth.dto.ts`), which rejects anything else with a 400.
 */
export const ENCRYPTED_WORKSPACE_RESET_PHRASE = 'DELETE';

// Structurally matches `StepUpProof` from `components/useStepUp`.
interface EncryptedWorkspaceResetProof {
  method: string;
  code?: string;
  response?: AuthenticationResponseJSON;
}

/**
 * Account-preserving encrypted-workspace reset: wipes the unreadable sync state, snapshots and key envelopes and
 * revokes all sessions server-side. Requires `currentPassword`, plus a fresh step-up `proof` when `AUTH_MFA_ENFORCED`
 * is on.
 */
export function resetEncryptedWorkspace(
  currentPassword: string,
  proof?: EncryptedWorkspaceResetProof,
): Promise<void> {
  return apiRequest('/api/v1/auth/encrypted-workspace-reset', {
    method: 'POST',
    // The server DTO's XOR rejects a `code` next to a passkey `response`, so
    // send only the field the chosen factor uses.
    body: {
      confirmation: ENCRYPTED_WORKSPACE_RESET_PHRASE,
      currentPassword,
      ...(proof
        ? proof.method === 'passkey'
          ? { method: proof.method, response: proof.response }
          : { method: proof.method, code: proof.code }
        : {}),
    },
  });
}
