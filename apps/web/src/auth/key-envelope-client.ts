/**
 * HTTP client for the zero-knowledge key-envelope endpoints
 * (`/auth/key-envelopes`).
 *
 *   GET    /api/v1/auth/key-envelopes            — list slots + envelope-set meta
 *   POST   /api/v1/auth/key-envelopes/activate    — atomic first-slot-set activation
 *   PUT    /api/v1/auth/key-envelopes/:slotId     — upsert a slot
 *   DELETE /api/v1/auth/key-envelopes/:slotId     — remove a slot
 *
 * Uses {@link apiRequest}, which attaches the bearer token and — for the
 * state-changing methods (POST/PUT/DELETE) — the `X-CSRF-Token` header from
 * the `csrf-token` cookie automatically (double-submit pattern).
 */
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import { apiRequest } from '../api/client';
import type { EnvelopeSetIntegrity, KeyEnvelopeSlot } from '../crypto/encryption-types';

/**
 * The household's key-envelope collection plus the envelope-set integrity meta.
 * On a household with no envelopes the server returns an empty `slots`
 * array, `envelopeSetVersion: 0`, and an empty `envelopeSetTag`.
 */
export interface KeyEnvelopesResponse extends EnvelopeSetIntegrity {
  slots: KeyEnvelopeSlot[];
  /**
   * The account credential's CURRENT revision, server-authored on every
   * read of this route — never derived or
   * cached client-side. Compared against a `password` slot's own
   * `credentialRevision` to decide whether a re-wrap is owed: not equal
   * (including a slot carrying no revision at all) means owed. Carries no
   * integrity protection of its own (the envelope-set tag excludes it) — a
   * forged value can only cause or suppress a prompt, never cause a wrap,
   * because the tag still gates the unwrap/wrap conclusion.
   */
  currentCredentialRevision: string;
}

/** Fetch the household's key-envelope slot set + integrity meta. */
export function getKeyEnvelopes(): Promise<KeyEnvelopesResponse> {
  return apiRequest<KeyEnvelopesResponse>('/api/v1/auth/key-envelopes');
}

/**
 * Body for a slot upsert: the slot material plus the recomputed envelope-set
 * version/tag, applied server-side under a conditional monotonic-version bump.
 *
 * `method`/`code`/`response` are the wire
 * fields `stepUpProofFields(proof)` (`components/useStepUp`) builds — merge
 * its result into the body when the caller collected a fresh factor. Required
 * only when the server's exemption matrix says this write requires a proof
 * (a household that already holds a slot, unless the write is an owed
 * post-reset password re-wrap) AND `AUTH_MFA_ENFORCED` is on; every other
 * write omits them.
 *
 * `currentPassword` is the password floor on a `passkey_prf`
 * enrollment write — required in EITHER `AUTH_MFA_ENFORCED` state whenever
 * the write is proof-required; every other write omits it. Never logged.
 */
export interface UpsertKeyEnvelopeSlotBody extends EnvelopeSetIntegrity {
  slot: KeyEnvelopeSlot;
  method?: string;
  code?: string;
  response?: AuthenticationResponseJSON;
  currentPassword?: string;
}

/**
 * Upsert a single key-envelope slot (state-changing — CSRF header attached).
 *
 * The server applies the slot write + the envelope-set meta bump as one atomic
 * transaction whose meta condition pins the exact predecessor version. Callers already recompute `envelopeSetVersion` as `current + 1`, so the
 * client sends `expectedEnvelopeSetVersion = envelopeSetVersion - 1` (the
 * version it currently holds) alongside the proposed version. The server
 * rejects a version that does not advance the stored one by exactly one with
 * the existing `409 STALE_ENVELOPE_VERSION`, on which the caller refetches and
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

/**
 * Body for `POST /auth/key-envelopes/activate`: the household's WHOLE
 * initial slot set, written atomically at one
 * version bump. Always proofless — no `method`/`code`/`response`/
 * `currentPassword` fields; the server refuses the route outright when the
 * set is not genuinely empty, so there is nothing to prove a factor against.
 */
export interface ActivateKeyEnvelopesBody extends EnvelopeSetIntegrity {
  slots: KeyEnvelopeSlot[];
}

/**
 * Atomically activate a household's initial key-envelope slot set
 * (state-changing — CSRF header attached). Replaces the old two-PUT
 * activation sequence (a `password` PUT, then a separate `recovery` PUT):
 * one request, one server-side transaction, one version bump, so no
 * intermediate "password committed, recovery not yet" state is ever
 * observable. The server rejects with a distinct `409
 * ENVELOPE_SET_NOT_EMPTY` — never `STALE_ENVELOPE_VERSION` — when the
 * household already holds a slot.
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
 * Remove a single key-envelope slot (state-changing — CSRF header attached).
 * `proof` is `stepUpProofFields(proof)`'s
 * result — a DELETE is never exempt from the server's step-up gate (when
 * `AUTH_MFA_ENFORCED` is on). No production caller exists today; the server
 * gate closes this reachable-but-unused endpoint regardless.
 */
export function deleteKeyEnvelopeSlot(
  slotId: string,
  integrity: EnvelopeSetIntegrity,
  proof?: { method?: string; code?: string; response?: AuthenticationResponseJSON },
): Promise<void> {
  return apiRequest(`/api/v1/auth/key-envelopes/${encodeURIComponent(slotId)}`, {
    method: 'DELETE',
    body: {
      ...integrity,
      expectedEnvelopeSetVersion: integrity.envelopeSetVersion - 1,
      ...(proof ?? {}),
    },
  });
}

/**
 * The exact confirmation phrase the user must type to reset the encrypted
 * workspace. Must match the server-side
 * `ENCRYPTED_WORKSPACE_RESET_PHRASE` in `apps/api/src/auth/dto/auth.dto.ts`
 * — the server rejects any other value with a 400.
 */
export const ENCRYPTED_WORKSPACE_RESET_PHRASE = 'DELETE';

/**
 * A verified step-up factor proof carried alongside the reset.
 * Structurally matches `StepUpProof` from `components/useStepUp`.
 */
export interface EncryptedWorkspaceResetProof {
  method: string;
  code?: string;
  response?: AuthenticationResponseJSON;
}

/**
 * Account-preserving encrypted-workspace reset. Wipes the unreadable household sync state + snapshots + key
 * envelopes and revokes all sessions server-side, while keeping the account.
 * Now carries a REQUIRED `currentPassword` re-verify plus, when
 * `AUTH_MFA_ENFORCED` is on, a fresh step-up factor `proof`. State-changing
 * — the `X-CSRF-Token` header is attached automatically by {@link apiRequest}.
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
