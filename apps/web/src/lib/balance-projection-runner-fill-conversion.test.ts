/** End-to-end runner coverage for Fill-mode MAGI-cap Roth conversions through the public runner entry points. */
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

function fillArgs(opts: {
  capMode: MagiCapMode;
  rothBalance: number;
  targetRothAccountId?: string;
  capMagiLine?: MagiCapLine;
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
    // A $0 Roth set as the Fill target must stay in the drawdown ledger (the zero-balance filter must not drop it), or
    // conversions silently degrade to 0.
    const converted = totalConvertedCents(fillArgs({ capMode: 'fill', rothBalance: 0 }));
    expect(converted).toBeGreaterThan(0);
  });

  it('should_grow_the_target_roth_balance_by_the_conversion', () => {
    const page = runBalanceProjectionForPage(fillArgs({ capMode: 'fill', rothBalance: 0 }));
    expect(page.planned).not.toBeNull();
    const rothBalances = (page.planned?.years ?? []).map(
      (y) => y.accountBalances?.get('roth')?.balance ?? 0,
    );
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

  // A new account auto-seeds a current-year $0 balance, so a fresh Roth IRA is immediately a working Fill target: drive the
  // runner with that seed row shape under each MAGI line and assert the conversion lands.
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
      expect(converted).toBeGreaterThan(0);
      expect(
        result.drawdownYears.some((y) => y.rothConversionDegradedNoTarget),
      ).toBe(false);
      const page = runBalanceProjectionForPage(args);
      const rothBalances = (page.planned?.years ?? []).map(
        (y) => y.accountBalances?.get('roth')?.balance ?? 0,
      );
      expect(Math.max(...rothBalances)).toBeGreaterThan(0);
    });
  }

  it('Fill mode does NOT convert into a MIXED 401k target (Fill stays Roth-IRA-only)', () => {
    // Working-years source eligibility includes MIXED accounts, but Fill target eligibility is Roth-IRA-only: a MIXED 401k
    // target must degrade to no conversion.
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
    expect(converted).toBe(0);
    expect(
      result.drawdownYears.some((y) => y.rothConversionDegradedNoTarget),
    ).toBe(true);
  });
});
