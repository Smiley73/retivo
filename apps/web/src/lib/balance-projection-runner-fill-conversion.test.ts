/**
 * End-to-end runner coverage for Fill-mode MAGI-cap Roth conversions.
 *
 * Closes the gap that let a real regression ship undetected: isolated engine
 * and solver units were well-covered, but nothing exercised a saved Fill-mode
 * scenario through the PUBLIC runner (`runBalanceProjection` /
 * `runBalanceProjectionForPage`) — so a zero-balance target Roth being dropped
 * from the per-account drawdown ledger produced silent $0 conversions that no
 * test caught.
 */
import { describe, expect, it } from 'vitest';
import { runBalanceProjection, runBalanceProjectionForPage } from './balance-projection-runner';
import type {
  AccountBalancePayload,
  AccountPayload,
  ExpensePayload,
  HouseholdMemberPayload,
  MagiCapLine,
  MagiCapMode,
  MagiCapOverride,
  SocialSecurityBenefitPayload,
  Aggregate,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';

const TODAY = new Date('2026-06-15T00:00:00Z');

function member(id: string, isPrimary: boolean, firstName: string, birthYear: number): Aggregate<HouseholdMemberPayload> {
  return {
    id, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'householdMember',
    payload: { isPrimary, firstName, lastName: 'Doe', email: `${id}@example.test`, birthdate: `${birthYear}-01-01` },
  };
}
function ssBenefit(memberId: string, pia: number | null): Aggregate<SocialSecurityBenefitPayload> {
  return {
    id: `ss-${memberId}`, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'socialSecurityBenefit',
    payload: { householdMemberId: memberId, pia, piaAsOfDate: '2026-01-01', notes: null },
  };
}
function account(id: string, ownerId: string, type: AccountPayload['type'], taxTreatment: AccountPayload['taxTreatment']): Aggregate<AccountPayload> {
  return {
    id, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'account',
    payload: {
      name: id, type, ownershipType: 'INDIVIDUAL', taxTreatment, ownerId, institution: 'V', notes: '',
      planningReturnPct: 5, active: true, plannedContributionPreTax: 0, plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}
function balanceRow(accountId: string, year: number, endingBalance: number): Aggregate<AccountBalancePayload> {
  return {
    id: `b-${accountId}-${year}`, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'accountBalance',
    payload: {
      accountId, year, lastUpdated: `${year}-12-31`, startingBalance: endingBalance * 0.9,
      startingBalancePreTax: null, startingBalancePostTax: null, contributionsPreTax: null, contributionsPostTax: null,
      companyContributions: 0, companyContributionsPreTax: null, companyContributionsPostTax: null,
      rollover: 0, distributions: 0, endingBalance, endingBalancePreTax: null, endingBalancePostTax: null,
      totalContributions: 0, comment: null,
    },
  };
}
/** The auto-$0 seed an account picks up at creation: id
 *  `bal-${accountId}-${todayYear}`, current year, every numeric field 0,
 *  splits null. Mirrors AccountFormModal's seed payload exactly. */
function seedBalanceRow(accountId: string, year: number): Aggregate<AccountBalancePayload> {
  return {
    id: `bal-${accountId}-${year}`, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'accountBalance',
    payload: {
      accountId, year, lastUpdated: `${year}-01-01T00:00:00Z`, startingBalance: 0,
      startingBalancePreTax: null, startingBalancePostTax: null, contributionsPreTax: null, contributionsPostTax: null,
      companyContributions: 0, companyContributionsPreTax: null, companyContributionsPostTax: null,
      rollover: 0, distributions: 0, endingBalance: 0, endingBalancePreTax: null, endingBalancePostTax: null,
      totalContributions: 0, comment: null,
    },
  };
}

function expense(id: string, annual: number): Aggregate<ExpensePayload> {
  return {
    id, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'expense',
    payload: {
      name: id, categoryId: 'cat-housing', amount: annual, frequency: 'yearly',
      classification: 'essential', start: { kind: 'retirementStart' }, end: { kind: 'lifetime', whose: 'last' },
    },
  };
}

/** Build runner args for a single-member household whose only Roth is the
 *  designated Fill-mode conversion target, seeded at `rothBalance`. */
function fillArgs(opts: {
  capMode: MagiCapMode;
  rothBalance: number;
  targetRothAccountId?: string;
  capMagiLine?: MagiCapLine;
  /** Use the auto-$0 seed row shape (current-year `bal-roth-<year>`) for the
   *  target Roth instead of a `balanceRow` — exercises the path where a
   *  freshly-created account's only balance is the auto-seed. */
  seedTargetRoth?: boolean;
}) {
  const magiCap: MagiCapOverride = {
    windows: [
      {
        start: { kind: 'retirementStart' },
        end: { kind: 'age', memberId: 'primary', years: 85, months: 0 },
        magiCeilingAnnualDollars: 120_000,
        capMode: opts.capMode,
        capMagiLine: opts.capMagiLine ?? 'irmaa',
        targetRothAccountId: opts.targetRothAccountId ?? 'roth',
      },
    ],
  };
  const scenario: ScenarioAggregate = {
    id: 's', householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'scenario',
    payload: {
      name: 'Fill', description: '', parentScenarioId: null, isPrimary: true, notes: '',
      overrides: {
        retirementAge: { primary: { ageYears: 64, ageMonths: 0 }, secondary: { ageYears: 64, ageMonths: 0 } },
        socialSecurity: { primary: { ageYears: 67, ageMonths: 0 }, secondary: { ageYears: 67, ageMonths: 0 } },
        inflation: { ratePct: 2 },
        lifeExpectancy: { primary: 90, secondary: 90 },
        withdrawalStrategy: { kind: 'taxEfficient' },
        magiCap,
      },
    },
  };
  return {
    scenarioId: 's',
    scenarios: [scenario],
    accounts: [
      account('ira', 'm1', 'RETIREMENT_IRA', 'PRE_TAX'),
      account('roth', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'),
      account('brk', 'm1', 'BROKERAGE', 'POST_TAX'),
    ],
    balances: [
      balanceRow('ira', 2025, 1_500_000),
      opts.seedTargetRoth
        ? seedBalanceRow('roth', TODAY.getUTCFullYear())
        : balanceRow('roth', 2025, opts.rothBalance),
      balanceRow('brk', 2025, 300_000),
    ],
    members: [member('m1', true, 'John', 1962)],
    ssBenefits: [ssBenefit('m1', 2000)],
    expenses: [expense('living', 60_000)],
    incomeStreams: [],
    todayYear: TODAY.getUTCFullYear(),
    todayMonthIndex: TODAY.getUTCMonth(),
  };
}

function totalConvertedCents(args: ReturnType<typeof fillArgs>): number {
  return runBalanceProjection(args).drawdownYears.reduce(
    (sum, y) => sum + (y.rothConvertedCents ?? 0),
    0,
  );
}

describe('runBalanceProjection — Fill-mode Roth conversions (end-to-end)', () => {
  it('should_convert_into_a_zero_balance_target_roth', () => {
    // Regression: a freshly-created $0 Roth set as the Fill target must still
    // receive conversions. Before the fix it was dropped from the drawdown
    // ledger by the zero-balance filter, so conversions silently degraded to 0.
    const converted = totalConvertedCents(fillArgs({ capMode: 'fill', rothBalance: 0 }));
    expect(converted).toBeGreaterThan(0);
  });

  it('should_grow_the_target_roth_balance_by_the_conversion', () => {
    const page = runBalanceProjectionForPage(fillArgs({ capMode: 'fill', rothBalance: 0 }));
    expect(page.planned).not.toBeNull();
    const rothBalances = (page.planned?.years ?? []).map(
      (y) => y.accountBalances?.get('roth')?.balance ?? 0,
    );
    // The $0 Roth ends up holding converted principal in at least one year.
    expect(Math.max(...rothBalances)).toBeGreaterThan(0);
  });

  it('should_not_convert_in_minimize_mode', () => {
    const converted = totalConvertedCents(fillArgs({ capMode: 'minimize', rothBalance: 0 }));
    expect(converted).toBe(0);
  });

  it('should_not_convert_when_the_target_roth_is_unknown', () => {
    // Dangling target id → engine degrades to withdrawal-only, no conversion.
    const converted = totalConvertedCents(
      fillArgs({ capMode: 'fill', rothBalance: 0, targetRothAccountId: 'does-not-exist' }),
    );
    expect(converted).toBe(0);
  });

  // A NEW account auto-seeds a current-year $0 balance at creation, so
  // a freshly-created Roth IRA is immediately a working Fill conversion target
  // with no hand-entered balance. These tests drive the runner with the actual
  // auto-seed row shape (`bal-roth-<year>`) under each MAGI line and assert the
  // conversion lands (no degraded-no-target).
  for (const capMagiLine of ['irmaa', 'aca'] as const) {
    it(`converts into an auto-$0-seeded target Roth under capMagiLine '${capMagiLine}'`, () => {
      const args = fillArgs({
        capMode: 'fill',
        rothBalance: 0,
        seedTargetRoth: true,
        capMagiLine,
      });
      const result = runBalanceProjection(args);
      const converted = result.drawdownYears.reduce(
        (sum, y) => sum + (y.rothConvertedCents ?? 0),
        0,
      );
      // Conversion lands (> 0) — the seed makes the account a valid target.
      expect(converted).toBeGreaterThan(0);
      // No year degrades to "no target" — the auto-seeded Roth IS the target.
      expect(
        result.drawdownYears.some((y) => y.rothConversionDegradedNoTarget),
      ).toBe(false);
      // The converted principal lands in the target Roth's balance.
      const page = runBalanceProjectionForPage(args);
      const rothBalances = (page.planned?.years ?? []).map(
        (y) => y.accountBalances?.get('roth')?.balance ?? 0,
      );
      expect(Math.max(...rothBalances)).toBeGreaterThan(0);
    });
  }

  it('Fill mode does NOT convert into a MIXED 401k target (Fill stays Roth-IRA-only)', () => {
    // Working-years SOURCE eligibility includes MIXED accounts, but
    // Fill-mode target eligibility is still Roth-IRA-only. Pointing the Fill
    // window's targetRothAccountId at a MIXED 401k must degrade to no conversion.
    const scenario: ScenarioAggregate = {
      id: 's', householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
      aggregateType: 'scenario',
      payload: {
        name: 'Fill-MIXED', description: '', parentScenarioId: null, isPrimary: true, notes: '',
        overrides: {
          retirementAge: { primary: { ageYears: 64, ageMonths: 0 }, secondary: { ageYears: 64, ageMonths: 0 } },
          socialSecurity: { primary: { ageYears: 67, ageMonths: 0 }, secondary: { ageYears: 67, ageMonths: 0 } },
          inflation: { ratePct: 2 },
          lifeExpectancy: { primary: 90, secondary: 90 },
          withdrawalStrategy: { kind: 'taxEfficient' },
          magiCap: {
            windows: [
              {
                start: { kind: 'retirementStart' },
                end: { kind: 'age', memberId: 'primary', years: 85, months: 0 },
                magiCeilingAnnualDollars: 120_000,
                capMode: 'fill',
                capMagiLine: 'irmaa',
                targetRothAccountId: 'mixed-401k', // MIXED, not a Roth IRA
              },
            ],
          },
        },
      },
    };
    const args = {
      scenarioId: 's',
      scenarios: [scenario],
      accounts: [
        account('ira', 'm1', 'RETIREMENT_IRA', 'PRE_TAX'),
        account('mixed-401k', 'm1', 'RETIREMENT_401K', 'MIXED'),
      ],
      balances: [
        balanceRow('ira', 2025, 1_500_000),
        balanceRow('mixed-401k', 2025, 300_000),
      ],
      members: [member('m1', true, 'John', 1962)],
      ssBenefits: [ssBenefit('m1', 2000)],
      expenses: [expense('living', 60_000)],
      incomeStreams: [],
      todayYear: TODAY.getUTCFullYear(),
      todayMonthIndex: TODAY.getUTCMonth(),
    };
    const result = runBalanceProjection(args);
    const converted = result.drawdownYears.reduce(
      (sum, y) => sum + (y.rothConvertedCents ?? 0),
      0,
    );
    // MIXED target must not receive Fill conversions.
    expect(converted).toBe(0);
    // The engine degrades to withdrawal-only (no target = valid Roth IRA).
    expect(
      result.drawdownYears.some((y) => y.rothConversionDegradedNoTarget),
    ).toBe(true);
  });
});
