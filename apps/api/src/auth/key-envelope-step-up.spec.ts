import { resolveEnvelopeWriteExemption } from './key-envelope-step-up.js';

describe('resolveEnvelopeWriteExemption', () => {
  it('a DELETE always requires a proof, regardless of household state', () => {
    expect(
      resolveEnvelopeWriteExemption({
        action: 'delete',
        householdHasAnySlot: true,
        isCanonicalPasswordRewrapOwed: false,
      }),
    ).toEqual({ required: true });
    expect(
      resolveEnvelopeWriteExemption({
        action: 'delete',
        householdHasAnySlot: false,
        isCanonicalPasswordRewrapOwed: false,
      }),
    ).toEqual({ required: true });
  });

  it('a PUT on a household with no live slot rows is exempt — genuine first activation', () => {
    expect(
      resolveEnvelopeWriteExemption({
        action: 'put',
        householdHasAnySlot: false,
        isCanonicalPasswordRewrapOwed: false,
      }),
    ).toEqual({ required: false, branch: 'exempt-activation' });
  });

  it('a PUT creating a slot id that does not exist yet on a household that already holds a slot now REQUIRES a proof — the reversal of the retired out-of-scope exemption', () => {
    // This case is deliberately the inverse of what this same predicate used
    // to assert: a brand-new slot id
    // was exempted there as "an add, not a displacement". That reasoning was
    // rejected because the exemption was reachable indefinitely
    // on a household that already holds a slot — a stolen bearer session could
    // mint a brand-new unlock path (e.g. a first `passkey_prf` slot) with no
    // proof, any time. The predicate no longer distinguishes "slot existed" at
    // all — every PUT on a non-empty household requires a proof unless the
    // post-reset re-wrap exemption applies.
    expect(
      resolveEnvelopeWriteExemption({
        action: 'put',
        householdHasAnySlot: true,
        isCanonicalPasswordRewrapOwed: false,
      }),
    ).toEqual({ required: true });
  });

  it('a PUT on the canonical password slot while a re-wrap is owed is exempt — post-reset re-wrap', () => {
    expect(
      resolveEnvelopeWriteExemption({
        action: 'put',
        householdHasAnySlot: true,
        isCanonicalPasswordRewrapOwed: true,
      }),
    ).toEqual({ required: false, branch: 'exempt-rewrap' });
  });

  it('a PUT replacing any other existing slot requires a proof', () => {
    expect(
      resolveEnvelopeWriteExemption({
        action: 'put',
        householdHasAnySlot: true,
        isCanonicalPasswordRewrapOwed: false,
      }),
    ).toEqual({ required: true });
  });

  it('the owed exemption is conditional — a password-slot replace that is NOT owed still requires a proof (never an unconditional password-slot bypass)', () => {
    expect(
      resolveEnvelopeWriteExemption({
        action: 'put',
        householdHasAnySlot: true,
        isCanonicalPasswordRewrapOwed: false,
      }),
    ).toEqual({ required: true });
  });
});
