/**
 * Unit tests for the pure account tax-profile logic — the draft readers, the
 * payload serializer, the ENGINE-sourced readiness/blocker list, the sync payload
 * budget, and the completeness classifier the account editor, the accounts list,
 * and the exported report all share.
 */
import { describe, expect, it } from 'vitest';
import type { AccountPayload } from '../db/types';
import {
  EMPTY_TAX_PROFILE_DRAFT,
  MAX_ACCOUNT_PAYLOAD_PLAINTEXT_BYTES,
  accountPayloadSizeError,
  readTaxProfileDraft,
  rmdBlockerMessages,
  showsDesignatedRothFields,
  showsRmdFields,
  showsRothIraFields,
  taxProfileCompleteness,
  taxProfileToPayloadFields,
  taxProfileValidationError,
  type TaxProfileDraft,
} from './account-tax-profile';

/** A minimal valid account payload plus any tax facts under test. */
function payload(over: Partial<AccountPayload> = {}): AccountPayload {
  return {
    name: 'Test account',
    type: 'RETIREMENT_ROTH_IRA',
    ownershipType: 'INDIVIDUAL',
    taxTreatment: 'ROTH',
    ownerId: 'm1',
    institution: 'Vanguard',
    notes: '',
    planningReturnPct: 5,
    active: true,
    plannedContributionPreTax: 0,
    plannedContributionPostTax: 0,
    assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    ...over,
  } as AccountPayload;
}

const draft = (over: Partial<TaxProfileDraft> = {}): TaxProfileDraft => ({
  ...EMPTY_TAX_PROFILE_DRAFT,
  ...over,
});

describe('field visibility', () => {
  it('shows Roth-IRA fields only for a Roth IRA', () => {
    expect(showsRothIraFields('RETIREMENT_ROTH_IRA')).toBe(true);
    expect(showsRothIraFields('RETIREMENT_ROTH_401K')).toBe(false);
    expect(showsRothIraFields('')).toBe(false);
  });

  it('shows designated-Roth fields for a pure Roth plan and for a MIXED employer plan', () => {
    expect(showsDesignatedRothFields('RETIREMENT_ROTH_401K', 'ROTH')).toBe(true);
    expect(showsDesignatedRothFields('RETIREMENT_401K', 'MIXED')).toBe(true);
    // A pre-tax-only employer plan has no Roth-designated slice.
    expect(showsDesignatedRothFields('RETIREMENT_401K', 'PRE_TAX')).toBe(false);
    expect(showsDesignatedRothFields('BROKERAGE', 'POST_TAX')).toBe(false);
  });

  it('shows required-withdrawal fields for retirement types only', () => {
    expect(showsRmdFields('RETIREMENT_IRA')).toBe(true);
    // A Roth IRA can be INHERITED, which owes beneficiary distributions.
    expect(showsRmdFields('RETIREMENT_ROTH_IRA')).toBe(true);
    expect(showsRmdFields('BROKERAGE')).toBe(false);
    expect(showsRmdFields('HSA')).toBe(false);
  });
});

describe('readTaxProfileDraft — every stored value is re-validated', () => {
  it('reads recorded facts back into the draft', () => {
    const d = readTaxProfileDraft(payload({ rothIraFirstContributionTaxYear: 2012 }));
    expect(d.rothIraFirstContributionTaxYear).toBe('2012');
  });

  it('drops corrupt / out-of-range stored values to BLANK rather than round-tripping them', () => {
    const d = readTaxProfileDraft(
      payload({
        // Out of the documented [1998, 2200] tax-year bounds.
        rothIraFirstContributionTaxYear: 1899,
        rmdBeneficiaryBirthdate: '1965-02-30', // calendar-impossible
        rmdBeneficiaryType: 'NOT_A_CATEGORY' as never,
        rmdFivePercentOwner: 'yes' as never, // not a boolean
      }),
    );
    expect(d.rothIraFirstContributionTaxYear).toBe('');
    expect(d.rmdBeneficiaryBirthdate).toBe('');
    expect(d.rmdBeneficiaryType).toBe('');
    // A non-boolean tri-state reads back UNKNOWN, the conservative default.
    expect(d.rmdFivePercentOwner).toBe('');
  });
});

describe('taxProfileToPayloadFields — only type-appropriate facts are emitted', () => {
  it('omits every blank field (absent ≠ zero)', () => {
    const out = taxProfileToPayloadFields(draft(), 'RETIREMENT_ROTH_IRA', 'ROTH');
    expect(out).toEqual({});
  });

  it('emits the Roth-IRA year fact for a Roth IRA and drops it for a brokerage account', () => {
    const d = draft({ rothIraFirstContributionTaxYear: '2012' });
    expect(taxProfileToPayloadFields(d, 'RETIREMENT_ROTH_IRA', 'ROTH')).toEqual({
      rothIraFirstContributionTaxYear: 2012,
    });
    // Switching the type must not leave orphan Roth facts behind.
    expect(taxProfileToPayloadFields(d, 'BROKERAGE', 'POST_TAX')).toEqual({});
  });

  it('emits inherited-beneficiary facts only on an inherited account, and owner facts only on an owner account', () => {
    const inherited = taxProfileToPayloadFields(
      draft({
        rmdInheritedAccount: true,
        rmdBeneficiaryType: 'SPOUSE',
        rmdInheritedOwnerDeathDate: '2023-04-02',
        rmdInheritedOwnerDiedOnOrAfterRbd: 'no',
        // Hidden legacy copy must not be re-saved; the household member record is
        // now the canonical beneficiary birthdate.
        rmdBeneficiaryBirthdate: '1983-05-01',
        // Owner-side facts must NOT survive on an inherited account.
        rmdCurrentEmployerPlan: true,
        rmdSoleSpouseBeneficiary: true,
      }),
      'RETIREMENT_IRA',
      'PRE_TAX',
    );
    expect(inherited.rmdInheritedAccount).toBe(true);
    expect(inherited.rmdBeneficiaryType).toBe('SPOUSE');
    expect(inherited.rmdInheritedOwnerDiedOnOrAfterRbd).toBe(false);
    expect(inherited.rmdBeneficiaryBirthdate).toBeUndefined();
    expect(inherited.rmdCurrentEmployerPlan).toBeUndefined();
    expect(inherited.rmdSoleSpouseBeneficiary).toBeUndefined();

    // The still-working facts only apply to employer plans, never an IRA.
    const ownerIra = taxProfileToPayloadFields(
      draft({ rmdCurrentEmployerPlan: true, rmdFivePercentOwner: 'no' }),
      'RETIREMENT_IRA',
      'PRE_TAX',
    );
    expect(ownerIra.rmdCurrentEmployerPlan).toBeUndefined();
    expect(ownerIra.rmdFivePercentOwner).toBeUndefined();
    const ownerPlan = taxProfileToPayloadFields(
      draft({ rmdCurrentEmployerPlan: true, rmdFivePercentOwner: 'no' }),
      'RETIREMENT_401K',
      'PRE_TAX',
    );
    expect(ownerPlan.rmdCurrentEmployerPlan).toBe(true);
    expect(ownerPlan.rmdFivePercentOwner).toBe(false);
  });

  it('stores a sole-spouse election only when household dates prove eligibility', () => {
    const d = draft({ rmdSoleSpouseBeneficiary: true });
    expect(
      taxProfileToPayloadFields(d, 'RETIREMENT_IRA', 'PRE_TAX', false)
        .rmdSoleSpouseBeneficiary,
    ).toBeUndefined();
    expect(
      taxProfileToPayloadFields(d, 'RETIREMENT_IRA', 'PRE_TAX', true)
        .rmdSoleSpouseBeneficiary,
    ).toBe(true);
  });

  it('drops owner-RMD facts for an RMD-exempt POST_TAX TSP', () => {
    const out = taxProfileToPayloadFields(
      draft({
        rmdCurrentEmployerPlan: true,
        rmdFivePercentOwner: 'no',
        rmdPlanRequiresDistributionAtStatutoryAge: 'no',
        rmdFirstYearDeferralElected: true,
        rmdSoleSpouseBeneficiary: true,
      }),
      'RETIREMENT_TSP',
      'POST_TAX',
      true,
    );
    expect(out).toEqual({});
  });
});

describe('taxProfileValidationError — a mistyped year is refused, not silently dropped', () => {
  it('is null when every year is readable (or blank)', () => {
    expect(taxProfileValidationError(draft(), 'RETIREMENT_ROTH_IRA', 'ROTH')).toBeNull();
    expect(
      taxProfileValidationError(
        draft({ rothIraFirstContributionTaxYear: '2012' }),
        'RETIREMENT_ROTH_IRA',
        'ROTH',
      ),
    ).toBeNull();
  });

  it('names the year field whose value is outside the supported range', () => {
    const message = taxProfileValidationError(
      draft({ rothIraFirstContributionTaxYear: '1971' }),
      'RETIREMENT_ROTH_IRA',
      'ROTH',
    );
    expect(message).toContain('Year of your first Roth IRA contribution');
    expect(message).toContain('four digits');
  });

  it('names the designated-Roth participation year too', () => {
    const message = taxProfileValidationError(
      draft({ designatedRothFirstParticipationTaxYear: 'nineteen' }),
      'RETIREMENT_ROTH_401K',
      'ROTH',
    );
    expect(message).toContain('Year Roth contributions to this plan began');
  });

  it('names the ORIGINAL-OWNER label variant on an inherited Roth IRA', () => {
    // The editor relabels the year field for the original owner when the inherited
    // toggle is on (it is the DECEDENT's year), so the refusal has to quote the
    // label actually on screen.
    const message = taxProfileValidationError(
      draft({
        rmdInheritedAccount: true,
        rothIraFirstContributionTaxYear: '1971',
      }),
      'RETIREMENT_ROTH_IRA',
      'ROTH',
    );
    expect(message).toContain('Year the original owner first contributed to a Roth IRA');
    expect(message).not.toContain('Year of your first Roth IRA contribution');
  });

  it('ignores fields the account type does not show', () => {
    // A brokerage account emits no Roth facts at all, so a leftover draft value
    // cannot block its save.
    expect(
      taxProfileValidationError(
        draft({ rothIraFirstContributionTaxYear: 'nonsense' }),
        'BROKERAGE',
        'POST_TAX',
      ),
    ).toBeNull();
  });
});

describe('rmdBlockerMessages — derived from the ENGINE’s own withhold reasons', () => {
  it('never blocks an owner (non-inherited) account', () => {
    expect(rmdBlockerMessages(draft(), 'RETIREMENT_IRA')).toEqual([]);
    expect(
      rmdBlockerMessages(draft({ rmdSoleSpouseBeneficiary: true }), 'RETIREMENT_401K'),
    ).toEqual([]);
  });

  it('lists the baseline inherited facts the rules require', () => {
    const messages = rmdBlockerMessages(draft({ rmdInheritedAccount: true }), 'RETIREMENT_IRA');
    expect(messages).toContain('Who inherited this account');
    expect(messages).toContain("The original owner's date of death");
    expect(messages).toContain(
      'Whether the original owner had reached their RMD start date',
    );
  });

  it('prefers the canonical household beneficiary birthdate over a conflicting legacy copy', () => {
    const messages = rmdBlockerMessages(
      draft({
        rmdInheritedAccount: true,
        rmdBeneficiaryType: 'MINOR_CHILD_OF_OWNER',
        rmdInheritedOwnerDeathDate: '2023-05-01',
        rmdInheritedOwnerDiedOnOrAfterRbd: 'no',
        rmdBeneficiaryBirthdate: '1983-05-01',
        rmdBeneficiaryElection: 'LIFE_EXPECTANCY',
      }),
      'RETIREMENT_IRA',
      '2010-05-01',
    );
    expect(messages).toEqual([]);
  });

  // The pre-fix predicate demanded a beneficiary birthdate AND an election from an
  // estate/charity/trust, neither of which any rule for that category needs.
  it('does NOT demand a birthdate or an election from an estate / charity / trust beneficiary', () => {
    const messages = rmdBlockerMessages(
      draft({
        rmdInheritedAccount: true,
        rmdBeneficiaryType: 'NON_PERSON',
        rmdInheritedOwnerDeathDate: '2023-04-02',
        rmdInheritedOwnerDiedOnOrAfterRbd: 'no',
      }),
      'RETIREMENT_IRA',
    );
    // Owner died BEFORE their required beginning date → the five-year rule applies
    // with no further facts needed, so nothing blocks.
    expect(messages).toEqual([]);
  });

  it('does NOT demand an election from a plain named (non-eligible) beneficiary', () => {
    const messages = rmdBlockerMessages(
      draft({
        rmdInheritedAccount: true,
        rmdBeneficiaryType: 'OTHER_DESIGNATED',
        rmdInheritedOwnerDeathDate: '2023-04-02',
        rmdInheritedOwnerDiedOnOrAfterRbd: 'no',
      }),
      'RETIREMENT_IRA',
    );
    expect(messages).toEqual([]);
  });

  // Engine blockers the pre-fix predicate never surfaced.
  it('surfaces the original owner’s birthdate when they died on/after their start date', () => {
    const messages = rmdBlockerMessages(
      draft({
        rmdInheritedAccount: true,
        rmdBeneficiaryType: 'NOT_MORE_THAN_10_YEARS_YOUNGER',
        rmdInheritedOwnerDeathDate: '2023-04-02',
        rmdInheritedOwnerDiedOnOrAfterRbd: 'yes',
        rmdBeneficiaryBirthdate: '1968-03-01',
        rmdBeneficiaryElection: 'LIFE_EXPECTANCY',
      }),
      'RETIREMENT_IRA',
    );
    expect(messages).toContain("The original owner's date of birth");
  });

  it('surfaces a pre-2020 death as an unsupported rule set rather than guessing', () => {
    const messages = rmdBlockerMessages(
      draft({
        rmdInheritedAccount: true,
        rmdBeneficiaryType: 'SPOUSE',
        rmdInheritedOwnerDeathDate: '2015-04-02',
        rmdInheritedOwnerDiedOnOrAfterRbd: 'no',
        rmdBeneficiaryBirthdate: '1968-03-01',
        rmdBeneficiaryElection: 'LIFE_EXPECTANCY',
      }),
      'RETIREMENT_IRA',
    );
    expect(messages.join(' ')).toContain('before 2020');
  });

  it('surfaces an impossible ten-year election for an on/after-start-date death', () => {
    const messages = rmdBlockerMessages(
      draft({
        rmdInheritedAccount: true,
        rmdBeneficiaryType: 'SPOUSE',
        rmdInheritedOwnerDeathDate: '2023-04-02',
        rmdInheritedOwnerDiedOnOrAfterRbd: 'yes',
        rmdBeneficiaryBirthdate: '1968-03-01',
        rmdBeneficiaryElection: 'TEN_YEAR',
      }),
      'RETIREMENT_IRA',
    );
    expect(messages.join(' ')).toContain('ten-year choice is not available');
  });

  it('does not demand the died-on/after-RBD fact for an inherited ROTH account (its owner has no lifetime RBD)', () => {
    // Every other required fact is recorded; `rmdInheritedOwnerDiedOnOrAfterRbd`
    // is deliberately left blank. A pre-tax IRA in the same shape WOULD be
    // blocked on it (next test) — a Roth account must not be, since the engine
    // (`resolveRmdRule` -> `resolveInheritedRmdRule`) always forces the
    // pre-RBD regime for a Roth owner and never reads the stored flag.
    const messages = rmdBlockerMessages(
      draft({
        rmdInheritedAccount: true,
        rmdBeneficiaryType: 'SPOUSE',
        rmdInheritedOwnerDeathDate: '2023-04-02',
        rmdBeneficiaryBirthdate: '1968-03-01',
        rmdOriginalOwnerBirthdate: '1950-01-01',
        rmdBeneficiaryElection: 'LIFE_EXPECTANCY',
      }),
      'RETIREMENT_ROTH_IRA',
    );
    expect(messages).toEqual([]);
  });

  it('still demands the died-on/after-RBD fact for the same inherited facts on a pre-tax IRA', () => {
    const messages = rmdBlockerMessages(
      draft({
        rmdInheritedAccount: true,
        rmdBeneficiaryType: 'SPOUSE',
        rmdInheritedOwnerDeathDate: '2023-04-02',
        rmdBeneficiaryBirthdate: '1968-03-01',
        rmdBeneficiaryElection: 'LIFE_EXPECTANCY',
      }),
      'RETIREMENT_IRA',
    );
    expect(messages).toContain(
      'Whether the original owner had reached their RMD start date',
    );
  });

  it('does not block an inherited account whose type owes no required withdrawal', () => {
    expect(
      rmdBlockerMessages(draft({ rmdInheritedAccount: true }), 'BROKERAGE'),
    ).toEqual([]);
  });
});

describe('accountPayloadSizeError — sync payload budget', () => {
  it('accepts an ordinary account payload', () => {
    expect(accountPayloadSizeError(payload())).toBeNull();
  });

  it('rejects a payload that could never sync, in plain English', () => {
    const huge = payload({ notes: 'x'.repeat(MAX_ACCOUNT_PAYLOAD_PLAINTEXT_BYTES + 1) });
    const message = accountPayloadSizeError(huge);
    expect(message).not.toBeNull();
    expect(message).toContain('too large to save and sync');
  });

  it('rejects an oversized payload that crosses the sync budget', () => {
    // No repeatable list remains on the account payload — both dated Roth facts
    // moved to the annual balance rows — so a long notes field is now the only
    // way to reach the budget, and the only thing the error can usefully advise
    // shortening.
    expect(accountPayloadSizeError(payload({ notes: 'y'.repeat(1_000) }))).toBeNull();
    const message = accountPayloadSizeError(
      payload({ notes: 'y'.repeat(MAX_ACCOUNT_PAYLOAD_PLAINTEXT_BYTES + 1) }),
    );
    expect(message).not.toBeNull();
    expect(message).toContain('too large to save and sync');
    expect(message).toContain('shorten the notes');
    // The advice must not name rows that no longer exist.
    expect(message).not.toMatch(/conversion or rollover rows/i);
  });

  it('is notApplicable for an account type with no Roth / required-withdrawal facts', () => {
    expect(taxProfileCompleteness(payload({ type: 'BROKERAGE', taxTreatment: 'POST_TAX' }))).toBe(
      'notApplicable',
    );
  });

  it('is partial while the Roth IRA start year is blank', () => {
    expect(taxProfileCompleteness(payload())).toBe('partial');
  });

  it('is complete for a Roth IRA once its start year alone is recorded', () => {
    // The contribution-basis total is no longer collected (it is derived from
    // recorded balance history), so the start year is the whole Roth-IRA ask.
    expect(
      taxProfileCompleteness(payload({ rothIraFirstContributionTaxYear: 2012 })),
    ).toBe('complete');
  });

  it('scores an employer Roth plan on its participation year alone', () => {
    const plan = { type: 'RETIREMENT_ROTH_401K', taxTreatment: 'ROTH' } as const;
    expect(taxProfileCompleteness(payload(plan))).toBe('partial');
    expect(
      taxProfileCompleteness(payload({ ...plan, designatedRothFirstParticipationTaxYear: 2018 })),
    ).toBe('complete');
  });

  // The Roth first-contribution year still gates completeness on an
  // INHERITED Roth IRA exactly as on an owner account. The engines stop
  // consulting that year; it does not change what the field is or what the
  // completeness indicator does with it.
  it('still scores the first-contribution year on an INHERITED Roth IRA', () => {
    const inherited = {
      rmdInheritedAccount: true,
      rmdBeneficiaryType: 'OTHER_DESIGNATED' as const,
      rmdInheritedOwnerDeathDate: '2025-06-12',
      rmdInheritedOwnerDiedOnOrAfterRbd: false,
      rmdOriginalOwnerBirthdate: '1945-02-08',
    };
    expect(taxProfileCompleteness(payload(inherited))).toBe('partial');
    expect(
      taxProfileCompleteness(
        payload({ ...inherited, rothIraFirstContributionTaxYear: 2012 }),
      ),
    ).toBe('complete');
  });

  it('is blocked when an inherited account is missing a required fact', () => {
    expect(
      taxProfileCompleteness(
        payload({ type: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX', rmdInheritedAccount: true }),
      ),
    ).toBe('blocked');
  });

  it('is partial for an employer plan whose still-working questions are unanswered', () => {
    // A brand-new pre-tax 401(k) with nothing entered reported `complete` — the
    // 5%-owner and plan-terms questions are unanswered, so the projection is using a
    // cautious default and the badge must say there is something to add.
    expect(
      taxProfileCompleteness(payload({ type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX' })),
    ).toBe('partial');
  });

  it('is complete for an employer plan once both still-working questions are answered', () => {
    expect(
      taxProfileCompleteness(
        payload({
          type: 'RETIREMENT_401K',
          taxTreatment: 'PRE_TAX',
          rmdFivePercentOwner: false,
          rmdPlanRequiresDistributionAtStatutoryAge: false,
        }),
      ),
    ).toBe('complete');
  });

  it('is complete for an owner IRA, which is never asked the still-working questions', () => {
    expect(
      taxProfileCompleteness(payload({ type: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' })),
    ).toBe('complete');
  });
});
