/**
 * QCD display-basis integration tests at NON-ZERO inflation (regression guard).
 *
 * The QCD suite's other integration tests run at 0% inflation — the one regime
 * where every inflation anchor (year-mean, year-end, none) coincides, so a
 * convention mismatch between the engine's gift inflation and the page's
 * display deflation is invisible there. This suite pins the year-END anchor at
 * 3% inflation:
 *
 *  - the engine inflates the REAL gift by the December `inflationFactorAt`
 *    factor and stamps that EXACT factor as `qcdInflationFactor`;
 *  - the standalone QCD chart / tile / PDF rows (`buildQcdRows.qcdDollars`)
 *    round-trip to the configured amount;
 *  - the QCD-RMD split bar's amber offset (`rmdOffsetDollars`, deflated on the
 *    RMD's year-end `basisDeflator`) ALSO equals the configured amount when the
 *    gift is fully counted — the year-mean convention this replaces showed a
 *    $10,000 gift as a constant ~$9,866 here.
 */
import { describe, expect, it } from 'vitest';
import { runBalanceProjectionForPage } from './balance-projection-runner';
import { buildQcdRows } from '../pages/balance-projection-burden-rows';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  QcdEntry,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';

const TODAY = new Date('2026-06-15T00:00:00Z');
const TODAY_YEAR = TODAY.getUTCFullYear();
const TODAY_MONTH = TODAY.getUTCMonth();
const INFLATION_PCT = 3;
const GIFT_DOLLARS = 10_000;

const PRIMARY: Aggregate<HouseholdMemberPayload> = {
  id: 'm1',
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'd',
  aggregateType: 'householdMember',
  payload: {
    isPrimary: true,
    firstName: 'Pat',
    lastName: 'Doe',
    email: 'm1@example.test',
    birthdate: '1955-01-01',
  },
};

const SS: Aggregate<SocialSecurityBenefitPayload> = {
  id: 'ss-m1',
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'd',
  aggregateType: 'socialSecurityBenefit',
  payload: { householdMemberId: 'm1', pia: 2_500, piaAsOfDate: '2026-01-01', notes: null },
};

const IRA: Aggregate<AccountPayload> = {
  id: 'ira',
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'd',
  aggregateType: 'account',
  payload: {
    name: 'ira',
    type: 'RETIREMENT_IRA',
    ownershipType: 'INDIVIDUAL',
    taxTreatment: 'PRE_TAX',
    ownerId: 'm1',
    institution: 'Vanguard',
    notes: '',
    planningReturnPct: 4,
    active: true,
    plannedContributionPreTax: 0,
    plannedContributionPostTax: 0,
    assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
  },
};

const BALANCE: Aggregate<AccountBalancePayload> = {
  id: 'b-ira-2025',
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'd',
  aggregateType: 'accountBalance',
  payload: {
    accountId: 'ira',
    year: 2025,
    lastUpdated: '2025-12-31',
    startingBalance: 1_900_000,
    startingBalancePreTax: null,
    startingBalancePostTax: null,
    contributionsPreTax: null,
    contributionsPostTax: null,
    companyContributions: 0,
    companyContributionsPreTax: null,
    companyContributionsPostTax: null,
    rollover: 0,
    distributions: 0,
    endingBalance: 2_000_000,
    endingBalancePreTax: null,
    endingBalancePostTax: null,
    totalContributions: 0,
    comment: null,
  },
};

const EXPENSE: Aggregate<ExpensePayload> = {
  id: 'e-living',
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'd',
  aggregateType: 'expense',
  payload: {
    name: 'Living',
    categoryId: 'cat-housing',
    amount: 40_000,
    frequency: 'yearly',
    classification: 'essential',
    start: { kind: 'retirementStart' },
    end: { kind: 'lifetime', whose: 'last' },
  },
};

const QCD: QcdEntry = {
  memberId: 'm1',
  sourceAccountId: 'ira',
  annualAmountDollars: GIFT_DOLLARS,
  start: { kind: 'year', year: 2028 },
  end: { kind: 'year', year: 2034 },
};

const SCENARIO: ScenarioAggregate = {
  id: 's',
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'd',
  aggregateType: 'scenario',
  payload: {
    name: 'Base',
    description: '',
    parentScenarioId: null,
    isPrimary: true,
    notes: '',
    overrides: {
      socialSecurity: { primary: { ageYears: 70, ageMonths: 0 } },
      retirementAge: { primary: { ageYears: 73, ageMonths: 0 } },
      inflation: { ratePct: INFLATION_PCT },
      lifeExpectancy: { primary: 88 },
      withdrawalStrategy: { kind: 'taxEfficient' },
      qualifiedCharitableDistributions: [QCD],
    },
  },
};

/** The page's deterministic Today's-dollars display deflator: the December
 *  anchor `1 / inflationFactorAt(year, 11)` with `asOfMonth` = today. */
const asOfMonth = TODAY_YEAR * 12 + TODAY_MONTH;
function decemberFactor(year: number): number {
  return Math.pow(1 + INFLATION_PCT / 100, (year * 12 + 11 - asOfMonth) / 12);
}

describe('QCD display basis at 3% inflation (year-end anchor)', () => {
  const page = runBalanceProjectionForPage({
    scenarioId: 's',
    scenarios: [SCENARIO],
    accounts: [IRA],
    balances: [BALANCE],
    members: [PRIMARY],
    ssBenefits: [SS],
    expenses: [EXPENSE],
    incomeStreams: [],
    todayYear: TODAY_YEAR,
    todayMonthIndex: TODAY_MONTH,
  });
  const years = page.planned?.years ?? [];
  const qcdYears = years.filter((y) => (y.qcdCents ?? 0) > 0);

  it('inflates the REAL gift by the December factor and stamps that exact factor', () => {
    expect(qcdYears.length).toBeGreaterThan(0);
    for (const y of qcdYears) {
      const expected = decemberFactor(y.year);
      expect(y.qcdInflationFactor).toBeCloseTo(expected, 10);
      expect(y.qcdCents).toBe(Math.round(GIFT_DOLLARS * expected * 100));
    }
  });

  it('gift chart/tile/PDF rows AND the split-bar amber offset both round-trip to the configured $10,000', () => {
    const rows = buildQcdRows({
      drawdown: {
        years,
        preRetirementConversionCentsByYear: new Map(),
      } as never,
      basisDeflator: (y) => 1 / decemberFactor(y),
      lastDeathFractional: null,
      displayMode: 'today',
    });
    expect(rows.length).toBe(qcdYears.length);
    for (const r of rows) {
      // Standalone QCD chart / "QCD distributed" tile / PDF table basis.
      expect(r.qcdDollars).toBeCloseTo(GIFT_DOLLARS, 2);
      // Split-bar amber slice: the gift is far below the ~$75k gross IRA RMD in
      // every gift year, so the offset is the FULL gift — and on the shared
      // year-end anchor it must equal the configured amount, not ~$9,866.
      expect(r.rmdOffsetDollars).toBeCloseTo(GIFT_DOLLARS, 2);
    }
  });
});
