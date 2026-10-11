/**
 * Tests for the working-years Roth-conversion deterministic pre-pass
 * (`computePreRetirementRothConversions`): full-gross transfer, source clamp,
 * flat-nominal annual amount, working-years + pre-RMD bounds, and the
 * per-owner at-retirement Roth-basis fold.
 */
import { computePreRetirementRothConversions } from './roth-conversion-projection';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';

const HH = 'hh-1';

function agg<T extends Record<string, unknown>>(
  id: string,
  aggregateType: string,
  payload: T,
): Aggregate<T> {
  return {
    id,
    householdId: HH,
    aggregateType: aggregateType as Aggregate<T>['aggregateType'],
    schemaVersion: 1,
    version: 1,
    updatedAt: '2025-12-31T00:00:00Z',
    deviceId: 'd1',
    payload,
  };
}

function account(id: string, p: Partial<AccountPayload>): Aggregate<AccountPayload> {
  return agg<AccountPayload>(id, 'account', {
    name: id,
    type: p.type ?? 'RETIREMENT_401K',
    ownershipType: 'INDIVIDUAL',
    taxTreatment: p.taxTreatment ?? 'PRE_TAX',
    ownerId: p.ownerId ?? 'm1',
    institution: 'Bank',
    notes: '',
    planningReturnPct: p.planningReturnPct ?? 0,
    active: true,
    plannedContributionPreTax: 0,
    plannedContributionPostTax: 0,
    assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
  });
}

function balance(accountId: string, endingBalance: number): Aggregate<AccountBalancePayload> {
  return agg<AccountBalancePayload>(`bal-${accountId}`, 'accountBalance', {
    accountId,
    year: 2025,
    lastUpdated: '2025-12-31T00:00:00Z',
    startingBalance: 0,
    startingBalancePreTax: null,
    startingBalancePostTax: null,
    contributionsPreTax: null,
    contributionsPostTax: null,
    companyContributions: 0,
    companyContributionsPreTax: null,
    companyContributionsPostTax: null,
    rollover: 0,
    distributions: 0,
    endingBalance,
    endingBalancePreTax: null,
    endingBalancePostTax: null,
    totalContributions: 0,
    comment: null,
  });
}

/** Balance for a MIXED account: endingBalancePreTax must be set so the
 *  projection seeds the pre bucket (projection.ts#seedBuckets uses
 *  `endingBalancePreTax ?? 0` for MIXED accounts). */
function balanceMixed(
  accountId: string,
  endingBalancePreTax: number,
  endingBalancePostTax = 0,
): Aggregate<AccountBalancePayload> {
  const endingBalance = endingBalancePreTax + endingBalancePostTax;
  return agg<AccountBalancePayload>(`bal-${accountId}`, 'accountBalance', {
    accountId,
    year: 2025,
    lastUpdated: '2025-12-31T00:00:00Z',
    startingBalance: 0,
    startingBalancePreTax: null,
    startingBalancePostTax: null,
    contributionsPreTax: null,
    contributionsPostTax: null,
    companyContributions: 0,
    companyContributionsPreTax: null,
    companyContributionsPostTax: null,
    rollover: 0,
    distributions: 0,
    endingBalance,
    endingBalancePreTax,
    endingBalancePostTax,
    totalContributions: 0,
    comment: null,
  });
}

function member(id: string, isPrimary: boolean, birthdate: string): Aggregate<HouseholdMemberPayload> {
  return agg<HouseholdMemberPayload>(id, 'householdMember', {
    isPrimary,
    firstName: id,
    lastName: 'X',
    email: `${id}@x.test`,
    birthdate,
  } as HouseholdMemberPayload);
}

function scenarioWith(overrides: ScenarioPayload['overrides']): ScenarioAggregate {
  return agg<ScenarioPayload>('p', 'scenario', {
    name: 'Base',
    description: '',
    parentScenarioId: null,
    isPrimary: true,
    notes: '',
    overrides,
  });
}

const SRC = account('pre', { type: 'RETIREMENT_401K', taxTreatment: 'PRE_TAX', ownerId: 'm1' });
const ROTH = account('roth', { type: 'RETIREMENT_ROTH_IRA', taxTreatment: 'ROTH', ownerId: 'm1' });
// Born 1975 → RMD trigger 75 → trigger year 2050. Retires (primary) 2040 well
// before trigger; working years 2026..2039.
const M1 = member('m1', true, '1975-06-01');

function baseArgs(overrides: ScenarioPayload['overrides']) {
  return {
    scenarioId: 'p',
    scenarios: [scenarioWith(overrides)],
    accounts: [SRC, ROTH],
    balances: [balance('pre', 200_000)],
    members: [M1],
    retirementByMember: new Map<string, string | null>([['m1', '2040-01-01']]),
    primaryRetIso: '2040-01-01',
    todayYear: 2026,
    todayMonthIndex: 0,
    stopContributionsToday: true,
  };
}

describe('computePreRetirementRothConversions', () => {
  it('moves the full gross from source pre-tax to target Roth each working year', () => {
    const r = computePreRetirementRothConversions(
      baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'pre',
            targetRothAccountId: 'roth',
            annualAmountDollars: 10_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2028 }, // active 2026, 2027, 2028
          },
        ],
      }),
    );
    const wd = r.preWithdrawalsByAccount.get('pre');
    const dep = r.preDepositsByAccount.get('roth');
    expect(wd).toHaveLength(3);
    expect(dep).toHaveLength(3);
    // Full gross, no haircut: each leg is the same $10k; deposit lands post-tax.
    for (const w of wd!) expect(w.preTax).toBe(10_000);
    for (const d of dep!) {
      expect(d.postTax).toBe(10_000);
      expect(d.preTax).toBe(0);
    }
    // Pinned to January (month0 = 0).
    expect(wd!.every((w) => w.month0 === 0)).toBe(true);
  });

  it('folds the converted principal into the owner Roth basis (integer cents)', () => {
    const r = computePreRetirementRothConversions(
      baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'pre',
            targetRothAccountId: 'roth',
            annualAmountDollars: 10_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2028 },
          },
        ],
      }),
    );
    // 3 working years × $10,000 = $30,000 = 3,000,000 cents folded for owner m1.
    expect(r.basisCentsByOwner.get('m1')).toBe(3_000_000);
  });

  it('clamps a conversion larger than the source pre-tax balance (no negative)', () => {
    const r = computePreRetirementRothConversions({
      ...baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'pre',
            targetRothAccountId: 'roth',
            annualAmountDollars: 1_000_000, // exceeds the 200k balance
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2026 },
          },
        ],
      }),
      balances: [balance('pre', 200_000)],
    });
    const wd = r.preWithdrawalsByAccount.get('pre')!;
    expect(wd).toHaveLength(1);
    // Clamped to the 200k source pre-tax balance (0% growth → flat 200k in 2026).
    expect(wd[0].preTax).toBeCloseTo(200_000, 2);
    expect(r.basisCentsByOwner.get('m1')).toBe(Math.round(wd[0].preTax * 100));
  });

  it('converts the flat nominal amount each year (no inflation growth)', () => {
    const r = computePreRetirementRothConversions(
      baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'pre',
            targetRothAccountId: 'roth',
            annualAmountDollars: 10_000,
            start: { kind: 'year', year: 2028 },
            end: { kind: 'year', year: 2028 },
          },
        ],
        inflation: { ratePct: 3 },
      }),
    );
    const wd = r.preWithdrawalsByAccount.get('pre')!;
    // Flat nominal: the typed $10k is converted as-is regardless of inflation.
    expect(wd[0].preTax).toBeCloseTo(10_000, 2);
  });

  it('drops conversion years at or after the source owner retirement (working-years bound)', () => {
    const r = computePreRetirementRothConversions(
      baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'pre',
            targetRothAccountId: 'roth',
            annualAmountDollars: 5_000,
            start: { kind: 'year', year: 2039 },
            end: { kind: 'year', year: 2045 }, // window runs past 2040 retirement
          },
        ],
      }),
    );
    // Owner retires 2040 → only 2039 is a working year.
    expect(r.preWithdrawalsByAccount.get('pre')).toHaveLength(1);
    expect(r.preWithdrawalsByAccount.get('pre')![0].year).toBe(2039);
  });

  it('drops conversion years at or after the MIXED source owner RMD trigger year', () => {
    // Born 1975, SECURE 2.0 RMD trigger age 75 → RMD trigger year 2050.
    // Window 2048–2052 must be truncated to 2048..2049 (before 2050).
    // Retirement is set past 2052 (2060) so only the RMD trigger bounds the window.
    const MIXED_SRC = account('mixed-src', {
      type: 'RETIREMENT_401K',
      taxTreatment: 'MIXED',
      ownerId: 'm1', // M1 = born 1975
    });
    const r = computePreRetirementRothConversions({
      ...baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'mixed-src',
            targetRothAccountId: 'roth',
            annualAmountDollars: 5_000,
            start: { kind: 'year', year: 2048 },
            end: { kind: 'year', year: 2052 }, // window runs past 2050 RMD trigger
          },
        ],
      }),
      accounts: [MIXED_SRC, ROTH],
      balances: [balanceMixed('mixed-src', 500_000)],
      // Push retirement to 2060 so only the RMD trigger (2050) bounds the window.
      retirementByMember: new Map([['m1', '2060-01-01']]),
      primaryRetIso: '2060-01-01',
    });
    // 2048 and 2049 are before the 2050 trigger; 2050+ must be dropped.
    const wd = r.preWithdrawalsByAccount.get('mixed-src');
    expect(wd).toHaveLength(2);
    expect(wd![0].year).toBe(2048);
    expect(wd![1].year).toBe(2049);
  });

  it('returns empty maps when there are no conversions', () => {
    const r = computePreRetirementRothConversions(baseArgs({}));
    expect(r.preWithdrawalsByAccount.size).toBe(0);
    expect(r.preDepositsByAccount.size).toBe(0);
    expect(r.basisCentsByOwner.size).toBe(0);
  });

  // Two conversion entries from the SAME source account in the SAME year
  // must NOT each independently read the full un-depleted source balance. The
  // depletion tracker caps the COMBINED deposit + basis at the source's
  // starting balance for that year (the kernel re-clamps the withdrawal list
  // cumulatively; without the tracker the deposit/basis legs would over-credit).
  it('caps two same-source same-year entries at the source balance', () => {
    const r = computePreRetirementRothConversions({
      ...baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'pre',
            targetRothAccountId: 'roth',
            annualAmountDollars: 150_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2026 }, // active 2026 only
          },
          {
            sourceAccountId: 'pre',
            targetRothAccountId: 'roth',
            annualAmountDollars: 150_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2026 }, // SAME source + SAME year
          },
        ],
      }),
      // 0% growth → flat 200k in 2026; combined scheduled (300k) exceeds it.
      balances: [balance('pre', 200_000)],
    });
    const dep = r.preDepositsByAccount.get('roth')!;
    const totalDeposit = dep.reduce((s, d) => s + d.postTax, 0);
    // Total Roth credited that year must never exceed the source start balance.
    expect(totalDeposit).toBeCloseTo(200_000, 2);
    // The basis fold mirrors the same cap (never over-credits the owner).
    expect(r.basisCentsByOwner.get('m1')!).toBeCloseTo(200_000 * 100, 0);
    // And the withdrawal legs sum to the same clamped total.
    const wd = r.preWithdrawalsByAccount.get('pre')!;
    const totalWd = wd.reduce((s, w) => s + w.preTax, 0);
    expect(totalWd).toBeCloseTo(200_000, 2);
  });

  // Two entries with the SAME Roth target but DIFFERENT source accounts
  // accumulate (lists concatenate, basis sums) — they do not overwrite.
  it('accumulates two entries into the same Roth target', () => {
    const SRC2 = account('pre2', {
      type: 'RETIREMENT_401K',
      taxTreatment: 'PRE_TAX',
      ownerId: 'm1',
    });
    const r = computePreRetirementRothConversions({
      ...baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'pre',
            targetRothAccountId: 'roth',
            annualAmountDollars: 10_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2026 },
          },
          {
            sourceAccountId: 'pre2',
            targetRothAccountId: 'roth',
            annualAmountDollars: 7_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2026 },
          },
        ],
      }),
      accounts: [SRC, SRC2, ROTH],
      balances: [balance('pre', 200_000), balance('pre2', 200_000)],
    });
    const dep = r.preDepositsByAccount.get('roth')!;
    // Both entries land in the same Roth target's 2026 deposits (accumulate).
    expect(dep).toHaveLength(2);
    const totalDeposit = dep.reduce((s, d) => s + d.postTax, 0);
    expect(totalDeposit).toBeCloseTo(17_000, 2);
    // Basis sums both entries for the shared Roth owner.
    expect(r.basisCentsByOwner.get('m1')!).toBeCloseTo(17_000 * 100, 0);
    // Each source's own withdrawal leg is recorded independently.
    expect(r.preWithdrawalsByAccount.get('pre')![0].preTax).toBeCloseTo(10_000, 2);
    expect(r.preWithdrawalsByAccount.get('pre2')![0].preTax).toBeCloseTo(7_000, 2);
  });

  // ── MIXED source + Roth IRA target ─────────────────────────────────

  it('accepts a MIXED 401k as a source and credits basisCentsByOwner (Roth IRA target)', () => {
    const MIXED_SRC = account('mixed-src', {
      type: 'RETIREMENT_401K',
      taxTreatment: 'MIXED',
      ownerId: 'm1',
    });
    const r = computePreRetirementRothConversions({
      ...baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'mixed-src',
            targetRothAccountId: 'roth',
            annualAmountDollars: 10_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2026 },
          },
        ],
      }),
      accounts: [MIXED_SRC, ROTH],
      balances: [balanceMixed('mixed-src', 200_000)],
    });
    // Withdrawal comes from the source; deposit goes to the Roth IRA.
    expect(r.preWithdrawalsByAccount.get('mixed-src')).toHaveLength(1);
    expect(r.preDepositsByAccount.get('roth')).toHaveLength(1);
    // Roth IRA target → credits basisCentsByOwner.
    expect(r.basisCentsByOwner.get('m1')).toBe(1_000_000);
    // No same-account MIXED in-plan credit (different source and target ids).
    expect(r.mixedInPlanBasisCentsByOwner.size).toBe(0);
  });

  // ── same-account MIXED in-plan conversion ─────────────────────────

  it('same-account MIXED in-plan: pre bucket decreases, post bucket increases (conservation)', () => {
    const MIXED = account('mixed', {
      type: 'RETIREMENT_401K',
      taxTreatment: 'MIXED',
      ownerId: 'm1',
    });
    const r = computePreRetirementRothConversions({
      ...baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'mixed',
            targetRothAccountId: 'mixed', // same id = in-plan conversion
            annualAmountDollars: 20_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2026 },
          },
        ],
      }),
      accounts: [MIXED, ROTH],
      balances: [balanceMixed('mixed', 200_000)],
    });
    // Both withdrawal leg and deposit leg are on the same account id.
    const wd = r.preWithdrawalsByAccount.get('mixed')!;
    const dep = r.preDepositsByAccount.get('mixed')!;
    expect(wd).toHaveLength(1);
    expect(dep).toHaveLength(1);
    expect(wd[0].preTax).toBeCloseTo(20_000, 2);
    expect(dep[0].postTax).toBeCloseTo(20_000, 2);
    expect(dep[0].preTax).toBe(0);
  });

  it('same-account MIXED in-plan: does NOT credit basisCentsByOwner (no double-credit)', () => {
    const MIXED = account('mixed', {
      type: 'RETIREMENT_401K',
      taxTreatment: 'MIXED',
      ownerId: 'm1',
    });
    const r = computePreRetirementRothConversions({
      ...baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'mixed',
            targetRothAccountId: 'mixed',
            annualAmountDollars: 20_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2026 },
          },
        ],
      }),
      accounts: [MIXED, ROTH],
      balances: [balanceMixed('mixed', 200_000)],
    });
    // Same-account MIXED in-plan → does NOT credit preRetirementConversionBasisCentsByOwner.
    expect(r.basisCentsByOwner.get('m1')).toBeUndefined();
    // Instead, it credits mixedInPlanBasisCentsByOwner.
    expect(r.mixedInPlanBasisCentsByOwner.get('m1')).toBe(2_000_000);
  });

  it('same-account MIXED in-plan: credits mixedInPlanBasisCentsByOwner for zero-starting post balance', () => {
    // The account has no post-tax balance recorded — the conversion creates the
    // Roth side from scratch. The basis credit must still happen.
    const MIXED = account('mixed', {
      type: 'RETIREMENT_401K',
      taxTreatment: 'MIXED',
      ownerId: 'm1',
    });
    // Balance has endingBalance=100k, all pre-tax (endingBalancePostTax=0).
    const bal = agg<AccountBalancePayload>('bal-mixed', 'accountBalance', {
      accountId: 'mixed',
      year: 2025,
      lastUpdated: '2025-12-31T00:00:00Z',
      startingBalance: 0,
      startingBalancePreTax: null,
      startingBalancePostTax: null,
      contributionsPreTax: null,
      contributionsPostTax: null,
      companyContributions: 0,
      companyContributionsPreTax: null,
      companyContributionsPostTax: null,
      rollover: 0,
      distributions: 0,
      endingBalance: 100_000,
      endingBalancePreTax: 100_000, // all pre-tax; projection seeds pre bucket from this
      endingBalancePostTax: 0, // zero post balance
      totalContributions: 0,
      comment: null,
    });
    const r = computePreRetirementRothConversions({
      ...baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'mixed',
            targetRothAccountId: 'mixed',
            annualAmountDollars: 10_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2026 },
          },
        ],
      }),
      accounts: [MIXED, ROTH],
      balances: [bal],
    });
    // Even with zero starting post balance, the basis credit must happen.
    expect(r.mixedInPlanBasisCentsByOwner.get('m1')).toBe(1_000_000);
    expect(r.basisCentsByOwner.get('m1')).toBeUndefined();
  });

  it('same-account MIXED in-plan: credits mixedInPlanBasisCentsByOwner even when post balance is positive', () => {
    // Positive recorded post balance — B's seed reads input snapshot. The
    // projection-created dollars are NOT in that snapshot, so we must still credit.
    const MIXED = account('mixed', {
      type: 'RETIREMENT_401K',
      taxTreatment: 'MIXED',
      ownerId: 'm1',
    });
    const bal = agg<AccountBalancePayload>('bal-mixed', 'accountBalance', {
      accountId: 'mixed',
      year: 2025,
      lastUpdated: '2025-12-31T00:00:00Z',
      startingBalance: 0,
      startingBalancePreTax: null,
      startingBalancePostTax: null,
      contributionsPreTax: null,
      contributionsPostTax: null,
      companyContributions: 0,
      companyContributionsPreTax: null,
      companyContributionsPostTax: null,
      rollover: 0,
      distributions: 0,
      endingBalance: 200_000,
      endingBalancePreTax: 150_000, // 200k total − 50k post = 150k pre; projection seeds pre bucket from this
      endingBalancePostTax: 50_000, // non-zero starting post balance
      totalContributions: 0,
      comment: null,
    });
    const r = computePreRetirementRothConversions({
      ...baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'mixed',
            targetRothAccountId: 'mixed',
            annualAmountDollars: 15_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2026 },
          },
        ],
      }),
      accounts: [MIXED, ROTH],
      balances: [bal],
    });
    // Must credit by actualGross regardless of positive starting post balance.
    expect(r.mixedInPlanBasisCentsByOwner.get('m1')).toBe(1_500_000);
  });

  it('displayed tax burden uses actualGross for same-account MIXED in-plan (not $0 net change)', () => {
    // The displayed burden must be actualGross × ratePct — not the net household
    // change (which is $0 since source and target are the same account).
    const MIXED = account('mixed', {
      type: 'RETIREMENT_401K',
      taxTreatment: 'MIXED',
      ownerId: 'm1',
    });
    // The projection emits actualGross into preWithdrawals; the caller computes
    // burden via resolveConversionLeg(actualGross * 100, ratePct).
    const r = computePreRetirementRothConversions({
      ...baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'mixed',
            targetRothAccountId: 'mixed',
            annualAmountDollars: 25_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2026 },
          },
        ],
      }),
      accounts: [MIXED, ROTH],
      balances: [balanceMixed('mixed', 200_000)],
    });
    // The withdrawal leg carries the actualGross (not $0), so burden can be computed.
    const wd = r.preWithdrawalsByAccount.get('mixed')!;
    expect(wd[0].preTax).toBeCloseTo(25_000, 2);
  });

  it('multi-entry same-account MIXED: two conversions in same year do not over-withdraw', () => {
    const MIXED = account('mixed', {
      type: 'RETIREMENT_401K',
      taxTreatment: 'MIXED',
      ownerId: 'm1',
    });
    const r = computePreRetirementRothConversions({
      ...baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'mixed',
            targetRothAccountId: 'mixed',
            annualAmountDollars: 80_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2026 },
          },
          {
            sourceAccountId: 'mixed',
            targetRothAccountId: 'mixed',
            annualAmountDollars: 80_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2026 },
          },
        ],
      }),
      accounts: [MIXED, ROTH],
      balances: [balanceMixed('mixed', 100_000)],
    });
    // Combined scheduled = 160k but source balance = 100k → total capped at 100k.
    const totalDeposit = r.preDepositsByAccount
      .get('mixed')!
      .reduce((s, d) => s + d.postTax, 0);
    expect(totalDeposit).toBeCloseTo(100_000, 2);
    // mixedInPlanBasisCentsByOwner also capped at the same 100k.
    expect(r.mixedInPlanBasisCentsByOwner.get('m1')!).toBeCloseTo(100_000 * 100, 0);
  });

  it('populates conversionCentsByYear with the clamped gross per working year', () => {
    const r = computePreRetirementRothConversions(
      baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'pre',
            targetRothAccountId: 'roth',
            annualAmountDollars: 10_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2027 },
          },
        ],
      }),
    );
    expect(r.conversionCentsByYear.get(2026)).toBe(10_000 * 100);
    expect(r.conversionCentsByYear.get(2027)).toBe(10_000 * 100);
    expect(r.conversionCentsByYear.size).toBe(2);
  });

  it('conversionCentsByYear sums across multiple conversions in the same year', () => {
    const r = computePreRetirementRothConversions(
      baseArgs({
        preRetirementRothConversions: [
          {
            sourceAccountId: 'pre',
            targetRothAccountId: 'roth',
            annualAmountDollars: 10_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2026 },
          },
          {
            sourceAccountId: 'pre',
            targetRothAccountId: 'roth',
            annualAmountDollars: 5_000,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2026 },
          },
        ],
      }),
    );
    expect(r.conversionCentsByYear.get(2026)).toBe(15_000 * 100);
  });
});
