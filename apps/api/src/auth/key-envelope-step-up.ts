/**
 * Step-up exemption matrix for `KeyEnvelopeController` writes. A stolen bearer session
 * must not be able to destroy — or extend — a household's ability to unlock
 * its own data, so every write into a set that ALREADY holds a slot demands a
 * fresh step-up proof: a replace, a brand-new slot id, or the passkey-PRF
 * enrollment write. The ONLY proofless add is genuine first-time activation,
 * on a household that holds zero live slot rows right now.
 *
 * A prior draft of this matrix also exempted a `PUT` that created a slot id
 * that did not exist yet ("adds don't destroy anything"). That was rejected:
 * the exemption was reachable
 * indefinitely on a household that already held a slot — `PUT
 * /key-envelopes/passkey_prf` from a stolen bearer session could mint a
 * brand-new unlock path with no proof at all, any time, forever. The
 * intermediate "password slot committed, recovery slot not yet" state that
 * exemption existed to serve is now served by a single atomic activation
 * transaction (see `KeyEnvelopeController.activate`) instead of two proofless
 * PUTs, so nothing depends on the old branch and it is gone.
 *
 * This module is the single, testable, named predicate the gate is built on —
 * never a condition spread across `upsert` and `remove`. It is pure and
 * matrix-only: it does not know about `AUTH_MFA_ENFORCED` (every existing
 * step-up consumer reads that flag itself, and degrades to the bare session —
 * or, for the passkey-PRF enrollment write, a password floor — when it is
 * off; see the controller). It also does not know about slot TYPE: the
 * separate password floor on a `passkey_prf` write is layered on top by the
 * controller, keyed on the matrix verdict plus the written slot's type, never
 * folded into this predicate.
 */

/** The two write shapes the controller gates. Not exported past this module
 *  — callers pass the literal `'put'` / `'delete'` into
 *  {@link EnvelopeWriteExemptionInput.action}. */
type EnvelopeWriteAction = 'put' | 'delete';

/**
 * Which branch of the exemption matrix a write fell into — recorded verbatim
 * in the `key_envelope_created` / `key_envelope_updated` / `key_envelope_deleted`
 * audit metadata. `not-enforced` is stamped by the controller (never this
 * module) when the matrix says a proof is required but `AUTH_MFA_ENFORCED`
 * is off; `verified` when the matrix required a proof and the caller's factor
 * checked out.
 */
export type EnvelopeStepUpBranch =
  | 'verified'
  | 'exempt-activation'
  | 'exempt-rewrap'
  | 'not-enforced';

export interface EnvelopeWriteExemptionInput {
  action: EnvelopeWriteAction;
  /** Whether the household holds ANY live slot row (never derived from the
   *  envelope-set version — a failed prior attempt can leave meta-only
   *  residue at a non-zero version). */
  householdHasAnySlot: boolean;
  /**
   * True only when this write targets the canonical `password` slot id, the
   * existing slot IS that canonical password slot, AND a re-wrap is owed
   * (the stored slot's `credentialRevision` does not equal the credential's
   * current revision). `false` for every other write, including a
   * not-yet-owed password-slot replace.
   */
  isCanonicalPasswordRewrapOwed: boolean;
}

/** A write the matrix exempts outright — no proof, regardless of `AUTH_MFA_ENFORCED`. */
export interface EnvelopeWriteExempt {
  required: false;
  branch: Extract<EnvelopeStepUpBranch, 'exempt-activation' | 'exempt-rewrap'>;
}

/** A write the matrix requires a proof for (subject to `AUTH_MFA_ENFORCED`). */
export interface EnvelopeWriteRequired {
  required: true;
}

/**
 * Resolve which branch of the gate matrix a write falls into. Pure — no I/O,
 * no config read — so it is directly unit-testable against every row of the
 * matrix:
 *
 * | Request                                                | Proof |
 * |---------------------------------------------------------|-------|
 * | `DELETE :slotId`                                         | required |
 * | `PUT` on a household with no live slot rows (genuine first activation) | exempt — first activation |
 * | `PUT` on the canonical `password` slot, re-wrap owed      | exempt — post-reset re-wrap |
 * | `PUT` creating a brand-new slot id on a non-empty household | required |
 * | `PUT` replacing any other existing slot                   | required |
 */
export function resolveEnvelopeWriteExemption(
  input: EnvelopeWriteExemptionInput,
): EnvelopeWriteExempt | EnvelopeWriteRequired {
  if (input.action === 'delete') return { required: true };
  if (!input.householdHasAnySlot) return { required: false, branch: 'exempt-activation' };
  if (input.isCanonicalPasswordRewrapOwed) return { required: false, branch: 'exempt-rewrap' };
  return { required: true };
}
