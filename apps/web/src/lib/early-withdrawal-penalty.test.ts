/**
 * Source-cited tests for the early-withdrawal / HSA additional-tax engine.
 * IRC §72(t) (10% before 59½); IRC §223(f)(4) (20% HSA before 65).
 */
import { describe, it, expect } from 'vitest';
import {
  computeEarlyWithdrawalPenalty,
  penaltyFractionForYear,
  carriesTenPercentPenalty,
  EARLY_WITHDRAWAL_PENALTY_RATE,
  HSA_ADDITIONAL_TAX_RATE,
  type PenaltyAccountInput,
} from './early-withdrawal-penalty';

describe('penaltyFractionForYear', () => {
  it('returns 6/12 in the 59½ transition year for a July-1 half-birthday', () => {
    // Born Jan 1 1965 → +59y6m = Jul 1 2024 → cutoffMonth1 = 7 → (7-1)/12.
    const f = penaltyFractionForYear('1965-01-01', 2024, { ageYears: 59, ageMonths: 6 });
    expect(f).toBeCloseTo(6 / 12, 10);
  });

  it('returns 1 for a year entirely before the cutoff', () => {
    expect(penaltyFractionForYear('1965-01-01', 2023, { ageYears: 59, ageMonths: 6 })).toBe(1);
  });

  it('returns 0 for the year after the cutoff', () => {
    expect(penaltyFractionForYear('1965-01-01', 2025, { ageYears: 59, ageMonths: 6 })).toBe(0);
  });

  it('returns null for a missing birthdate', () => {
    expect(penaltyFractionForYear(null, 2024, { ageYears: 59, ageMonths: 6 })).toBeNull();
  });

  it('prorates the HSA 65 boundary via the same helper', () => {
    // Born Mar 1 1960 → +65y = Mar 1 2025 → cutoffMonth1 = 3 → (3-1)/12.
    const f = penaltyFractionForYear('1960-03-01', 2025, { ageYears: 65, ageMonths: 0 });
    expect(f).toBeCloseTo(2 / 12, 10);
  });
});

describe('carriesTenPercentPenalty', () => {
  it('includes 401k/IRA/403b/TSP/cash-balance', () => {
    for (const t of ['RETIREMENT_401K', 'RETIREMENT_IRA', 'RETIREMENT_403B', 'RETIREMENT_TSP', 'RETIREMENT_CASH_BALANCE'] as const) {
      expect(carriesTenPercentPenalty(t)).toBe(true);
    }
  });
  it('includes the designated-Roth employer types with 10% penalty (401K/403B/TSP)', () => {
    // The earnings-tranche penalty on a pre-59½ designated-Roth employer draw is
    // 10% for these three types — they are members of PENALTY_10_TYPES.
    for (const t of ['RETIREMENT_ROTH_401K', 'RETIREMENT_ROTH_403B', 'RETIREMENT_ROTH_TSP'] as const) {
      expect(carriesTenPercentPenalty(t)).toBe(true);
    }
  });
  it('excludes 457b, Roth IRA, brokerage, and cash-like from the contribution-penalty set', () => {
    // RETIREMENT_ROTH_IRA stays OUT of PENALTY_10_TYPES (the contribution
    // tranche must remain penalty-free); the earnings-tranche penalty is a
    // dedicated branch, not membership in this set.
    // RETIREMENT_ROTH_457B is excluded — governmental §72(t) exemption → 0% penalty.
    for (const t of ['RETIREMENT_457B', 'RETIREMENT_ROTH_IRA', 'RETIREMENT_ROTH_457B', 'BROKERAGE', 'SAVINGS', 'CD', 'HSA', 'OTHER'] as const) {
      expect(carriesTenPercentPenalty(t)).toBe(false);
    }
  });
});

describe('computeEarlyWithdrawalPenalty', () => {
  const ownerYoung = '1980-06-15'; // well before 59½ for any near-term tax year

  it('applies 10% on a pre-59½ traditional IRA withdrawal', () => {
    const accounts: PenaltyAccountInput[] = [
      { id: 'a', type: 'RETIREMENT_IRA', penaltyBasisDollars: 10_000, ownerBirthdate: ownerYoung },
    ];
    const r = computeEarlyWithdrawalPenalty(accounts, 2030, []);
    expect(r.ira401kPenaltyDollars).toBe(10_000 * EARLY_WITHDRAWAL_PENALTY_RATE);
    expect(r.hsaAdditionalTaxDollars).toBe(0);
    expect(r.penaltyDollars).toBe(1_000);
  });

  it('exempts a 457b withdrawal (governmental exception)', () => {
    const accounts: PenaltyAccountInput[] = [
      { id: 'g457', type: 'RETIREMENT_457B', penaltyBasisDollars: 10_000, ownerBirthdate: ownerYoung },
    ];
    const r = computeEarlyWithdrawalPenalty(accounts, 2030, []);
    expect(r.penaltyDollars).toBe(0);
  });

  it('a pre-59½ Roth IRA earnings-excess basis incurs the 10% penalty', () => {
    // The owner-level tracker passes the EARNINGS EXCESS as penaltyBasisDollars
    // (the contribution tranche is split off upstream and stays penalty-free).
    const accounts: PenaltyAccountInput[] = [
      { id: 'roth', type: 'RETIREMENT_ROTH_IRA', penaltyBasisDollars: 10_000, ownerBirthdate: ownerYoung },
    ];
    const r = computeEarlyWithdrawalPenalty(accounts, 2030, []);
    expect(r.ira401kPenaltyDollars).toBe(1_000);
    expect(r.penaltyDollars).toBe(1_000);
  });

  it('a Roth IRA with zero earnings excess (all-contribution draw) incurs no penalty', () => {
    const accounts: PenaltyAccountInput[] = [
      { id: 'roth', type: 'RETIREMENT_ROTH_IRA', penaltyBasisDollars: 0, ownerBirthdate: ownerYoung },
    ];
    const r = computeEarlyWithdrawalPenalty(accounts, 2030, []);
    expect(r.penaltyDollars).toBe(0);
  });

  it('exemption (Option A): an exempt Roth IRA waives the 10% penalty leg only', () => {
    // $10k earnings excess → $1,000 penalty when non-exempt; $0 when exempt.
    // The ordinary-income tax on the $10k is routed by the engine (not this
    // function) and is unchanged by the exemption — verified at the engine
    // layer; here we assert only that the exemption zeroes the penalty.
    const accounts: PenaltyAccountInput[] = [
      { id: 'roth', type: 'RETIREMENT_ROTH_IRA', penaltyBasisDollars: 10_000, ownerBirthdate: ownerYoung },
    ];
    const nonExempt = computeEarlyWithdrawalPenalty(accounts, 2030, []);
    expect(nonExempt.penaltyDollars).toBe(1_000);
    const exempt = computeEarlyWithdrawalPenalty(accounts, 2030, ['roth']);
    expect(exempt.penaltyDollars).toBe(0);
  });

  it('MIXED basis: 10% on the pre-tax tranche only', () => {
    // Caller passes only the $6k pre-tax tranche as penaltyBasisDollars.
    const accounts: PenaltyAccountInput[] = [
      { id: 'mixed', type: 'RETIREMENT_401K', penaltyBasisDollars: 6_000, ownerBirthdate: ownerYoung },
    ];
    const r = computeEarlyWithdrawalPenalty(accounts, 2030, []);
    expect(r.penaltyDollars).toBe(600); // 6k × 10%, not 10k
  });

  it('HSA before 65 gets the 20% additional tax', () => {
    const accounts: PenaltyAccountInput[] = [
      { id: 'hsa', type: 'HSA', penaltyBasisDollars: 5_000, ownerBirthdate: ownerYoung },
    ];
    const r = computeEarlyWithdrawalPenalty(accounts, 2030, []);
    expect(r.hsaAdditionalTaxDollars).toBe(5_000 * HSA_ADDITIONAL_TAX_RATE);
    expect(r.ira401kPenaltyDollars).toBe(0);
  });

  it('scenario-marked exempt accounts skip the penalty', () => {
    const accounts: PenaltyAccountInput[] = [
      { id: 'a', type: 'RETIREMENT_IRA', penaltyBasisDollars: 10_000, ownerBirthdate: ownerYoung },
    ];
    const r = computeEarlyWithdrawalPenalty(accounts, 2030, ['a']);
    expect(r.penaltyDollars).toBe(0);
  });

  it('skips and flags a missing birthdate', () => {
    const accounts: PenaltyAccountInput[] = [
      { id: 'a', type: 'RETIREMENT_IRA', penaltyBasisDollars: 10_000, ownerBirthdate: null },
    ];
    const r = computeEarlyWithdrawalPenalty(accounts, 2030, []);
    expect(r.penaltyDollars).toBe(0);
    expect(r.skippedForMissingBirthdate).toBe(true);
  });

  it('prorates the penalty in the 59½ transition year', () => {
    // Born Jan 1 1971 → 59½ on Jul 1 2030 → fraction 6/12.
    const accounts: PenaltyAccountInput[] = [
      { id: 'a', type: 'RETIREMENT_IRA', penaltyBasisDollars: 10_000, ownerBirthdate: '1971-01-01' },
    ];
    const r = computeEarlyWithdrawalPenalty(accounts, 2030, []);
    expect(r.penaltyDollars).toBeCloseTo(10_000 * 0.1 * (6 / 12), 6);
  });

  it('designated-Roth 401k/403b/TSP earnings excess incurs the 10% penalty', () => {
    // The caller passes only the earnings tranche as penaltyBasisDollars (the
    // contribution tranche is shielded upstream by applyRothBasisOrdering).
    for (const type of ['RETIREMENT_ROTH_401K', 'RETIREMENT_ROTH_403B', 'RETIREMENT_ROTH_TSP'] as const) {
      const accounts: PenaltyAccountInput[] = [
        { id: 'roth-emp', type, penaltyBasisDollars: 10_000, ownerBirthdate: ownerYoung },
      ];
      const r = computeEarlyWithdrawalPenalty(accounts, 2030, []);
      expect(r.ira401kPenaltyDollars).toBe(1_000);
      expect(r.penaltyDollars).toBe(1_000);
    }
  });

  it('designated-Roth 457b earnings excess incurs NO penalty (governmental exemption)', () => {
    // RETIREMENT_ROTH_457B is NOT in PENALTY_10_TYPES: the §457(b) governmental
    // plan exception waives the §72(t) 10% penalty.
    const accounts: PenaltyAccountInput[] = [
      { id: 'roth-457b', type: 'RETIREMENT_ROTH_457B', penaltyBasisDollars: 10_000, ownerBirthdate: ownerYoung },
    ];
    const r = computeEarlyWithdrawalPenalty(accounts, 2030, []);
    expect(r.penaltyDollars).toBe(0);
  });

  it('scenario-exempting a Roth 401k account waives its earnings penalty', () => {
    const accounts: PenaltyAccountInput[] = [
      { id: 'r401k', type: 'RETIREMENT_ROTH_401K', penaltyBasisDollars: 10_000, ownerBirthdate: ownerYoung },
    ];
    expect(computeEarlyWithdrawalPenalty(accounts, 2030, []).penaltyDollars).toBe(1_000);
    expect(computeEarlyWithdrawalPenalty(accounts, 2030, ['r401k']).penaltyDollars).toBe(0);
  });

  // IRC §72(t)(2)(A)(ii): a distribution made on account of the
  // ORIGINAL owner's death carries no 10% additional tax at ANY beneficiary age.
  // The pre-fix engine applied the BENEFICIARY's 59½ test and charged 10% on money
  // a beneficiary is in fact REQUIRED to withdraw.
  it('an inherited account carries NO 10% at any beneficiary age (§72(t)(2)(A)(ii))', () => {
    for (const type of ['RETIREMENT_IRA', 'RETIREMENT_401K', 'RETIREMENT_ROTH_IRA'] as const) {
      const owned: PenaltyAccountInput[] = [
        { id: 'own', type, penaltyBasisDollars: 10_000, ownerBirthdate: ownerYoung },
      ];
      const inherited: PenaltyAccountInput[] = [
        {
          id: 'inh',
          type,
          penaltyBasisDollars: 10_000,
          ownerBirthdate: ownerYoung,
          inheritedFromDeceasedOwner: true,
        },
      ];
      // The beneficiary's own account (same age, same dollars) IS penalized …
      expect(computeEarlyWithdrawalPenalty(owned, 2030, []).penaltyDollars).toBe(1_000);
      // … the inherited one is not.
      const r = computeEarlyWithdrawalPenalty(inherited, 2030, []);
      expect(r.penaltyDollars).toBe(0);
      // And a MISSING beneficiary birthdate is irrelevant to an inherited account,
      // so it must not raise the estimate-note flag either.
      const noBirthdate = computeEarlyWithdrawalPenalty(
        [{ ...inherited[0], ownerBirthdate: undefined }],
        2030,
        [],
      );
      expect(noBirthdate.penaltyDollars).toBe(0);
      expect(noBirthdate.skippedForMissingBirthdate).toBe(false);
    }
  });

  it('an inherited §408A/§402A-ordered additional-tax base is likewise exempt', () => {
    const accounts: PenaltyAccountInput[] = [
      {
        id: 'inh-roth-457b',
        type: 'RETIREMENT_ROTH_457B',
        penaltyBasisDollars: 5_000,
        ownerBirthdate: ownerYoung,
        rothOrderedAdditionalTaxBase: true,
        inheritedFromDeceasedOwner: true,
      },
    ];
    expect(computeEarlyWithdrawalPenalty(accounts, 2030, []).penaltyDollars).toBe(0);
  });
});
