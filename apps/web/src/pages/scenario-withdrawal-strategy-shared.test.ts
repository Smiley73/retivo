/**
 * Unit tests for `seedTierState`.
 *
 * Covers: HSA defaults to Excluded; non-HSA accounts default to tier 0;
 * existing customDrawdownOrder is respected (not re-seeded); stale IDs pruned.
 */
import { describe, expect, it } from 'vitest';
import {
  EARLY_WITHDRAWAL_PENALTY_ELIGIBLE_TYPES,
  healthCoverageBlockReason,
  isPenaltyEligibleAccount,
  isRothConversionTarget,
  rothConversionTargets,
  seedTierState,
  toDraftBenchmarkRows,
  type DraftHealthCoverageRow,
} from './scenario-withdrawal-strategy-shared';
import type { AccountPayload, AccountType, Aggregate } from '../db/types';

function makeAccount(
  id: string,
  type: AccountPayload['type'],
  active = true,
): Aggregate<AccountPayload> {
  return {
    id,
    householdId: 'hh',
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd1',
    payload: {
      name: id,
      type,
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'PRE_TAX',
      ownerId: 'member-1',
      institution: '',
      notes: '',
      planningReturnPct: 7,
      active,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 80, bondsPct: 20, cashPct: 0 },
    },
  };
}

/** An active, INHERITED Roth IRA (`rmdInheritedAccount: true`). */
function makeInheritedRothIra(id: string): Aggregate<AccountPayload> {
  const a = makeAccount(id, 'RETIREMENT_ROTH_IRA');
  return { ...a, payload: { ...a.payload, rmdInheritedAccount: true } };
}

describe('seedTierState — default seeding (no existing order)', () => {
  it('places non-HSA accounts in tier 0', () => {
    const accounts = [
      makeAccount('a1', 'RETIREMENT_401K'),
      makeAccount('a2', 'RETIREMENT_ROTH_IRA'),
    ];
    const { tiers, excludedAccountIds } = seedTierState(accounts, undefined);
    expect(tiers).toHaveLength(1);
    expect(tiers[0]).toContain('a1');
    expect(tiers[0]).toContain('a2');
    expect(excludedAccountIds).toHaveLength(0);
  });

  it('places HSA accounts in Excluded by default', () => {
    const accounts = [
      makeAccount('a1', 'RETIREMENT_401K'),
      makeAccount('hsa', 'HSA'),
    ];
    const { tiers, excludedAccountIds } = seedTierState(accounts, undefined);
    expect(tiers[0]).toContain('a1');
    expect(tiers[0]).not.toContain('hsa');
    expect(excludedAccountIds).toContain('hsa');
  });

  it('skips inactive accounts entirely', () => {
    const accounts = [
      makeAccount('a1', 'RETIREMENT_401K'),
      makeAccount('inactive', 'BROKERAGE', false),
    ];
    const { tiers, excludedAccountIds } = seedTierState(accounts, undefined);
    expect(tiers[0]).toEqual(['a1']);
    expect(excludedAccountIds).toHaveLength(0);
  });
});

describe('seedTierState — existing customDrawdownOrder respected', () => {
  it('returns the existing tier layout unchanged when all IDs still active', () => {
    const accounts = [
      makeAccount('a1', 'RETIREMENT_401K'),
      makeAccount('a2', 'BROKERAGE'),
    ];
    const existing = {
      tiers: [['a2'], ['a1']],
      excludedAccountIds: [] as string[],
    };
    const { tiers, excludedAccountIds } = seedTierState(accounts, existing);
    expect(tiers).toEqual([['a2'], ['a1']]);
    expect(excludedAccountIds).toEqual([]);
  });

  it('prunes stale IDs that are no longer in the household', () => {
    const accounts = [makeAccount('a1', 'RETIREMENT_401K')];
    const existing = {
      tiers: [['a1', 'stale-id'], ['another-stale']],
      excludedAccountIds: ['hsa-stale'],
    };
    const { tiers, excludedAccountIds } = seedTierState(accounts, existing);
    expect(tiers[0]).toEqual(['a1']);
    expect(tiers[1]).toEqual([]);
    expect(excludedAccountIds).toEqual([]);
  });

  it('preserves excluded accounts from existing order', () => {
    const accounts = [
      makeAccount('a1', 'RETIREMENT_401K'),
      makeAccount('hsa', 'HSA'),
    ];
    const existing = {
      tiers: [['a1']],
      excludedAccountIds: ['hsa'],
    };
    const { tiers, excludedAccountIds } = seedTierState(accounts, existing);
    expect(tiers[0]).toEqual(['a1']);
    expect(excludedAccountIds).toEqual(['hsa']);
  });
});

describe('EARLY_WITHDRAWAL_PENALTY_ELIGIBLE_TYPES — Option A', () => {
  it('includes RETIREMENT_ROTH_IRA now that its earnings tranche can be penalized', () => {
    expect(EARLY_WITHDRAWAL_PENALTY_ELIGIBLE_TYPES.has('RETIREMENT_ROTH_IRA')).toBe(true);
  });

  it('keeps the pre-existing pre-59½ retirement types eligible', () => {
    for (const t of [
      'RETIREMENT_401K',
      'RETIREMENT_IRA',
      'RETIREMENT_403B',
      'RETIREMENT_TSP',
      'RETIREMENT_CASH_BALANCE',
    ] as const) {
      expect(EARLY_WITHDRAWAL_PENALTY_ELIGIBLE_TYPES.has(t)).toBe(true);
    }
  });

  it('includes the 10%-penalty designated-Roth employer types (401K/403B/TSP)', () => {
    for (const t of ['RETIREMENT_ROTH_401K', 'RETIREMENT_ROTH_403B', 'RETIREMENT_ROTH_TSP'] as const) {
      expect(EARLY_WITHDRAWAL_PENALTY_ELIGIBLE_TYPES.has(t)).toBe(true);
    }
  });

  it('still excludes 457(b), Roth 457(b), brokerage, savings, and HSA', () => {
    // RETIREMENT_ROTH_457B: governmental §72(t) exemption → 0% penalty, excluded.
    for (const t of ['RETIREMENT_457B', 'RETIREMENT_ROTH_457B', 'BROKERAGE', 'SAVINGS', 'HSA'] as const) {
      expect(EARLY_WITHDRAWAL_PENALTY_ELIGIBLE_TYPES.has(t)).toBe(false);
    }
  });

  it('isPenaltyEligibleAccount is true for Roth IRA and employer Roth types, false for excluded', () => {
    const eligible: AccountType[] = [
      'RETIREMENT_ROTH_IRA',
      'RETIREMENT_ROTH_401K',
      'RETIREMENT_ROTH_403B',
      'RETIREMENT_ROTH_TSP',
      'RETIREMENT_401K',
    ];
    const excluded: AccountType[] = ['RETIREMENT_457B', 'RETIREMENT_ROTH_457B', 'BROKERAGE', 'SAVINGS', 'HSA'];
    for (const t of eligible) {
      expect(isPenaltyEligibleAccount(makeAccount('x', t))).toBe(true);
    }
    for (const t of excluded) {
      expect(isPenaltyEligibleAccount(makeAccount('x', t))).toBe(false);
    }
  });
});

describe('rothConversionTargets / isRothConversionTarget', () => {
  it('matches only an active RETIREMENT_ROTH_IRA by type', () => {
    expect(isRothConversionTarget(makeAccount('r', 'RETIREMENT_ROTH_IRA'))).toBe(true);
  });

  it('does NOT match designated-Roth employer types (would re-tax the basis fold)', () => {
    // Employer Roth accounts are excluded as conversion targets: routing a
    // pre-tax → Roth employer conversion would silently no-op the at-retirement
    // basis fold and re-tax the principal.
    for (const t of [
      'RETIREMENT_ROTH_401K',
      'RETIREMENT_ROTH_403B',
      'RETIREMENT_ROTH_457B',
      'RETIREMENT_ROTH_TSP',
    ] as const) {
      expect(isRothConversionTarget(makeAccount('emp', t))).toBe(false);
    }
  });

  it('rejects a pre-tax / non-Roth account', () => {
    expect(isRothConversionTarget(makeAccount('p', 'RETIREMENT_401K'))).toBe(false);
    expect(isRothConversionTarget(makeAccount('b', 'BROKERAGE'))).toBe(false);
  });

  it('rejects an inactive Roth IRA account', () => {
    expect(isRothConversionTarget(makeAccount('r', 'RETIREMENT_ROTH_IRA', false))).toBe(false);
  });

  it('rejects an INHERITED Roth IRA (the engine refuses it as a Fill target)', () => {
    // A beneficiary cannot roll into an inherited IRA (§408A(e)), and
    // `findTargetRothIndex` returns undefined for one — offering it in the
    // picker would advertise a conversion that runs $0.
    expect(isRothConversionTarget(makeInheritedRothIra('inh'))).toBe(false);
  });

  it('rothConversionTargets returns only active, non-inherited RETIREMENT_ROTH_IRA accounts', () => {
    const accounts = [
      makeAccount('p', 'RETIREMENT_401K'),
      makeAccount('r1', 'RETIREMENT_ROTH_IRA'),
      makeAccount('r2', 'RETIREMENT_ROTH_401K'), // employer Roth — excluded
      makeAccount('r3', 'RETIREMENT_ROTH_IRA', false), // inactive — excluded
      makeInheritedRothIra('r4'), // inherited — excluded
    ];
    expect(rothConversionTargets(accounts).map((a) => a.id)).toEqual(['r1']);
  });
});

// ---------------------------------------------------------------------------
// The modal seed reads the benchmark override through the ONE
// shape-checked enumerator (the array arrives from an envelope-only-validated
// import, so a non-array payload used to throw out of the whole modal).
// ---------------------------------------------------------------------------
describe('toDraftBenchmarkRows', () => {
  it('seeds the editor rows ascending by tax year', () => {
    expect(
      toDraftBenchmarkRows([
        { taxYear: 2032, annualSlcspDollars: 9_600 },
        { taxYear: 2030, annualSlcspDollars: 9_000 },
      ]),
    ).toEqual([
      { taxYear: 2030, annualSlcspDollars: 9_000 },
      { taxYear: 2032, annualSlcspDollars: 9_600 },
    ]);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a non-array object', { taxYear: 2030, annualSlcspDollars: 9_000 }],
  ])('seeds NO rows for %s instead of throwing', (_label, stored) => {
    expect(
      toDraftBenchmarkRows(stored as Parameters<typeof toDraftBenchmarkRows>[0]),
    ).toEqual([]);
  });

  it('drops a malformed row rather than seeding a year the picker cannot show', () => {
    expect(
      toDraftBenchmarkRows([
        { taxYear: 1999, annualSlcspDollars: 9_000 },
        { taxYear: 2030, annualSlcspDollars: 0 },
        { taxYear: 2031, annualSlcspDollars: 9_600 },
      ] as Parameters<typeof toDraftBenchmarkRows>[0]),
    ).toEqual([{ taxYear: 2031, annualSlcspDollars: 9_600 }]);
  });
});

describe('healthCoverageBlockReason — duplicate coverage rows', () => {
  const row = (memberId: string, taxYear: number): DraftHealthCoverageRow => ({
    memberId,
    taxYear,
    partBMonths: 12,
    partDMonths: null,
    marketplaceMonths: null,
  });

  it('blocks Save when one person has two rows for the same year', () => {
    expect(healthCoverageBlockReason([row('m1', 2030), row('m1', 2030)], [])).toBe(
      'Two coverage rows cover the same person in 2030. Combine them into one row, or remove the duplicate.',
    );
  });

  it('allows the same person in different years and different people in the same year', () => {
    expect(healthCoverageBlockReason([row('m1', 2030), row('m1', 2031)], [])).toBeNull();
    expect(healthCoverageBlockReason([row('m1', 2030), row('m2', 2030)], [])).toBeNull();
  });

  it('does not mistake two different people for one when their id and year read alike', () => {
    // "m1" + 230 and "m12" + 30 both spell "m1230" if the key has no separator.
    expect(healthCoverageBlockReason([row('m1', 230), row('m12', 30)], [])).toBeNull();
  });
});
