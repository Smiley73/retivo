// Step-up exemption matrix for key-envelope writes: every write into a set that already holds a slot needs a fresh proof; only genuine first
// activation (zero live slot rows) is proofless.

type EnvelopeWriteAction = 'put' | 'delete';

/**
 * Which branch of the exemption matrix a write fell into, recorded in the `key_envelope_*` audit metadata.
 * `not-enforced` is stamped by the controller when a proof is required but `AUTH_MFA_ENFORCED` is off; `verified`
 * when the factor checked out.
 */
export type EnvelopeStepUpBranch =
  | 'verified'
  | 'exempt-activation'
  | 'exempt-rewrap'
  | 'not-enforced';

export interface EnvelopeWriteExemptionInput {
  action: EnvelopeWriteAction;
  /**
   * Whether the household holds any live slot row; never derived from the envelope-set version, since a failed
   * attempt can leave meta-only residue at a non-zero version.
   */
  householdHasAnySlot: boolean;
  /**
   * True only when the write targets the canonical `password` slot id, the existing slot is it, and a re-wrap is owed
   * (its `credentialRevision` differs from the credential current one).
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
