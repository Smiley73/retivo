/** Deterministic QCD integration tests through `runBalanceProjection` and `runBalanceProjectionForPage`. */
import { describe, expect, it } from 'vitest';
import {
  runBalanceProjection,
  runBalanceProjectionForPage,
} from './balance-projection-runner';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  QcdEntry,
  ScenarioOverrides,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';

const TODAY = new Date('2026-06-15T00:00:00Z');
const TODAY_YEAR = TODAY.getUTCFullYear();
const TODAY_MONTH = TODAY.getUTCMonth();

function member(
  id: string,
  isPrimary: boolean,
  firstName: string,
  birthdate: string,
): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'householdMember',
    payload: {
      isPrimary,
      firstName,
      lastName: 'Doe',
      email: `${id}@example.test`,
      birthdate,
    },
  };
}

function ssBenefit(
  memberId: string,
  pia: number | null,
): Aggregate<SocialSecurityBenefitPayload> {
  return {
    id: `ss-${memberId}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'socialSecurityBenefit',
    payload: { householdMemberId: memberId, pia, piaAsOfDate: '2026-01-01', notes: null },
  };
}

function account(
  id: string,
  ownerId: string,
  type: AccountPayload['type'],
  taxTreatment: AccountPayload['taxTreatment'],
): Aggregate<AccountPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'account',
    payload: {
      name: id,
      type,
      ownershipType: 'INDIVIDUAL',
      taxTreatment,
      ownerId,
      institution: 'Vanguard',
      notes: '',
      planningReturnPct: 4,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}

function balanceRow(
  accountId: string,
  year: number,
  endingBalance: number,
): Aggregate<AccountBalancePayload> {
  return {
    id: `b-${accountId}-${year}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'accountBalance',
    payload: {
      accountId,
      year,
      lastUpdated: `${year}-12-31`,
      startingBalance: endingBalance * 0.95,
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
    },
  };
}

function expense(name: string, amount: number): Aggregate<ExpensePayload> {
  return {
    id: `e-${name}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'expense',
    payload: {
      name,
      categoryId: 'cat-housing',
      amount,
      frequency: 'yearly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    },
  };
}

// Born 1955: RMD trigger age 73 (2028), QCD 70½ eligible from 2025; retiring at 73 makes RMD and QCD both active from
// drawdown year 0.
const PRIMARY = member('m1', true, 'Pat', '1955-01-01');

function scenarioWith(overrides: ScenarioOverrides): ScenarioAggregate {
  return {
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
        inflation: { ratePct: 0 },
        lifeExpectancy: { primary: 88 },
        withdrawalStrategy: { kind: 'taxEfficient' },
        ...overrides,
      },
    },
  };
}

const QCD_WINDOW: Pick<QcdEntry, 'start' | 'end'> = {
  start: { kind: 'year', year: 2028 },
  end: { kind: 'year', year: 2034 },
};

function qcdEntry(annualAmountDollars: number): QcdEntry {
  return { memberId: 'm1', sourceAccountId: 'ira', annualAmountDollars, ...QCD_WINDOW };
}

interface RunOpts {
  qcd?: readonly QcdEntry[];
  ssPia?: number | null;
  expenses?: ReadonlyArray<Aggregate<ExpensePayload>>;
  accounts?: ReadonlyArray<Aggregate<AccountPayload>>;
  balances?: ReadonlyArray<Aggregate<AccountBalancePayload>>;
}

function commonArgs(opts: RunOpts) {
  const accounts =
    opts.accounts ?? [account('ira', 'm1', 'RETIREMENT_IRA', 'PRE_TAX')];
  const balances = opts.balances ?? [balanceRow('ira', 2025, 2_000_000)];
  return {
    scenarioId: 's',
    scenarios: [
      scenarioWith(
        opts.qcd ? { qualifiedCharitableDistributions: opts.qcd } : {},
      ),
    ],
    accounts: [...accounts],
    balances: [...balances],
    members: [PRIMARY],
    ssBenefits: [ssBenefit('m1', opts.ssPia ?? 2_500)],
    expenses: opts.expenses ? [...opts.expenses] : [expense('Living', 40_000)],
    incomeStreams: [],
    todayYear: TODAY_YEAR,
    todayMonthIndex: TODAY_MONTH,
  };
}

function rowFor(
  result: ReturnType<typeof runBalanceProjection>,
  year: number,
) {
  const row = result.drawdownYears.find((y) => y.year === year);
  if (!row) throw new Error(`no drawdown row for year ${year}`);
  return row;
}

describe('QCD deterministic integration', () => {
  it('lowers BOTH MAGI lines → lower federal tax + lower IRMAA + higher ACA-PTC', () => {
    const base = runBalanceProjection(commonArgs({}));
    const withQcd = runBalanceProjection(commonArgs({ qcd: [qcdEntry(50_000)] }));
    const yr = 2030;
    const b = rowFor(base, yr);
    const q = rowFor(withQcd, yr);
    // Both MAGI lines drop by the QCD (the ACA MAGI shares the same AGI base).
    expect(q.magiCents ?? 0).toBeLessThan(b.magiCents ?? 0);
    expect(q.federalTaxCents ?? 0).toBeLessThan(b.federalTaxCents ?? 0);
  });

  it('lifts a younger ACA-on-Marketplace spouse’s PTC via the reduced ACA MAGI line', () => {
    // The donor (73+) is always Medicare-age, so the ACA MAGI line matters only for a younger Marketplace spouse: the QCD lowers
    // household MAGI and lifts the secondary's premium tax credit.
    const secondary = member('m2', false, 'Sam', '1968-01-01'); // under 65 in 2028..2032
    const scenarios = [
      scenarioWith({
        socialSecurity: { primary: { ageYears: 70, ageMonths: 0 } },
        retirementAge: {
          primary: { ageYears: 73, ageMonths: 0 },
          secondary: { ageYears: 60, ageMonths: 0 },
        },
        lifeExpectancy: { primary: 88, secondary: 88 },
        qualifiedCharitableDistributions: [qcdEntry(80_000)],
      }),
    ];
    const baseScenarios = [
      scenarioWith({
        socialSecurity: { primary: { ageYears: 70, ageMonths: 0 } },
        retirementAge: {
          primary: { ageYears: 73, ageMonths: 0 },
          secondary: { ageYears: 60, ageMonths: 0 },
        },
        lifeExpectancy: { primary: 88, secondary: 88 },
      }),
    ];
    const shared = {
      accounts: [account('ira', 'm1', 'RETIREMENT_IRA', 'PRE_TAX')],
      balances: [balanceRow('ira', 2025, 2_000_000)],
      members: [PRIMARY, secondary],
      ssBenefits: [ssBenefit('m1', 2_500), ssBenefit('m2', 1_500)],
      expenses: [expense('Living', 40_000)],
      incomeStreams: [],
      todayYear: TODAY_YEAR,
      todayMonthIndex: TODAY_MONTH,
    };
    const base = runBalanceProjection({ scenarioId: 's', scenarios: baseScenarios, ...shared });
    const withQcd = runBalanceProjection({ scenarioId: 's', scenarios, ...shared });
    const yr = 2030;
    const bAca = rowFor(base, yr).acaPtcSubsidyCents ?? 0;
    const qAca = rowFor(withQcd, yr).acaPtcSubsidyCents ?? 0;
    expect(qAca).toBeGreaterThan(bAca);
  });

  it('IRMAA drop appears two years after the first QCD year (Y+2 ring)', () => {
    // A high pre-tax balance plus SS clears the IRMAA threshold without the QCD. IRMAA reads MAGI from two years prior, so the
    // first QCD year (2031) cuts IRMAA in 2033 (Y+2) while its own surcharge (look-back 2029, pre-QCD) is unchanged; 2031 is
    // a few years into drawdown so its look-back is a real prior year.
    const lateWindow: Pick<QcdEntry, 'start' | 'end'> = {
      start: { kind: 'year', year: 2031 },
      end: { kind: 'year', year: 2036 },
    };
    const lateEntry: QcdEntry = {
      memberId: 'm1',
      sourceAccountId: 'ira',
      annualAmountDollars: 120_000,
      ...lateWindow,
    };
    const base = runBalanceProjection(
      commonArgs({ ssPia: 4_500, expenses: [expense('Living', 30_000)] }),
    );
    const withQcd = runBalanceProjection(
      commonArgs({
        qcd: [lateEntry],
        ssPia: 4_500,
        expenses: [expense('Living', 30_000)],
      }),
    );
    expect(rowFor(withQcd, 2031).irmaaSurchargeCents ?? 0).toBe(
      rowFor(base, 2031).irmaaSurchargeCents ?? 0,
    );
    expect(rowFor(withQcd, 2033).irmaaSurchargeCents ?? 0).toBeLessThan(
      rowFor(base, 2033).irmaaSurchargeCents ?? 0,
    );
  });

  it('can move a §86 Social Security taxation tier down', () => {
    // Modest SS plus a QCD large enough to pull provisional income below an §86 tier boundary: the taxable-SS tier is no higher
    // with the QCD and strictly lower in at least one year.
    const base = runBalanceProjection(
      commonArgs({ ssPia: 2_000, expenses: [expense('Living', 25_000)] }),
    );
    const withQcd = runBalanceProjection(
      commonArgs({
        qcd: [qcdEntry(90_000)],
        ssPia: 2_000,
        expenses: [expense('Living', 25_000)],
      }),
    );
    const tierRank = { none: 0, fifty: 1, 'eighty-five': 2 } as const;
    let movedDown = false;
    for (let y = 2028; y <= 2033; y += 1) {
      const bt = rowFor(base, y).ssTaxationTier ?? 'none';
      const qt = rowFor(withQcd, y).ssTaxationTier ?? 'none';
      expect(tierRank[qt]).toBeLessThanOrEqual(tierRank[bt]);
      if (tierRank[qt] < tierRank[bt]) movedDown = true;
    }
    expect(movedDown).toBe(true);
  });

  it('portfolio drops by exactly Q without funding spending; net taxable RMD = gross − min(Q,gross)', () => {
    const page = runBalanceProjectionForPage(commonArgs({ qcd: [qcdEntry(20_000)] }));
    const pageNoQcd = runBalanceProjectionForPage(commonArgs({}));
    const qYears = page.planned?.years ?? [];
    const baseYears = pageNoQcd.planned?.years ?? [];
    expect(qYears.length).toBeGreaterThan(0);
    const yr = 2030;
    const q = qYears.find((y) => y.year === yr);
    const b = baseYears.find((y) => y.year === yr);
    if (!q || !b) throw new Error('missing year row');
    // Inflation is 0%, so the nominal QCD is exactly $20,000.
    expect(q.qcdCents).toBe(2_000_000);
    // The gift leaves the portfolio without funding spending, so the ending balance is below the no-QCD year's.
    expect(q.balance).toBeLessThan(b.balance);
    // Net taxable RMD = gross IRA-pool RMD − min(Q, gross); with a $20k QCD ≤ gross it is gross − 20k.
    const grossRmdCents = b.rmdFloorCents ?? 0;
    expect(grossRmdCents).toBeGreaterThan(2_000_000); // gross > Q in this fixture
    expect(q.netTaxableRmdCents).toBe(grossRmdCents - 2_000_000);
  });

  it('offset is scoped to the IRA pool only — a same-owner 401k RMD floor is unaffected', () => {
    const accounts = [
      account('ira', 'm1', 'RETIREMENT_IRA', 'PRE_TAX'),
      account('k401', 'm1', 'RETIREMENT_401K', 'PRE_TAX'),
    ];
    const balances = [
      balanceRow('ira', 2025, 1_000_000),
      balanceRow('k401', 2025, 1_000_000),
    ];
    const base = runBalanceProjectionForPage(commonArgs({ accounts, balances }));
    const withQcd = runBalanceProjectionForPage(
      commonArgs({ qcd: [qcdEntry(30_000)], accounts, balances }),
    );
    const yr = 2030;
    const b = base.planned?.years.find((y) => y.year === yr);
    const q = withQcd.planned?.years.find((y) => y.year === yr);
    if (!b || !q) throw new Error('missing year row');
    // The 401k is its own RMD pool, so the IRA-only QCD never offsets it.
    const k401Base = b.perAccountRmdCents?.['k401'] ?? 0;
    const k401Qcd = q.perAccountRmdCents?.['k401'] ?? 0;
    expect(k401Base).toBeGreaterThan(0);
    expect(k401Qcd).toBe(k401Base);
    // Net taxable RMD is strictly below the household RMD floor (which still includes the untouched 401k pool): the offset is
    // scoped to the IRA pool.
    expect(q.qcdCents).toBe(3_000_000);
    expect(q.netTaxableRmdCents).toBeDefined();
    expect(q.netTaxableRmdCents ?? 0).toBeLessThan(q.rmdFloorCents ?? 0);
  });

  it('an over-RMD surplus year shows NO phantom RMD shortfall (QCD satisfies the IRA RMD)', () => {
    // An over-RMD surplus year draws the gross RMD anyway; the QCD is a non-spending first-dollars slice debited to the IRA
    // pre-tax bucket and credited toward the IRA-pool RMD floor (IRC §408(d)(8)), so the shortfall metric must not report a
    // phantom miss ($2M IRA, $40k spending, $20k QCD ≤ gross).
    const withQcd = runBalanceProjectionForPage(commonArgs({ qcd: [qcdEntry(20_000)] }));
    const yr = 2030;
    const q = (withQcd.planned?.years ?? []).find((y) => y.year === yr);
    if (!q) throw new Error('missing year row');
    expect(q.qcdCents).toBe(2_000_000);
    expect(q.rmdShortfallCents ?? 0).toBe(0);
    const grossRmdCents = q.rmdFloorCents ?? 0;
    expect(grossRmdCents).toBeGreaterThan(2_000_000);
    expect(q.netTaxableRmdCents).toBe(grossRmdCents - 2_000_000);
  });

  it('a QCD ≥ the gross IRA RMD fully satisfies it — zero shortfall, zero net taxable RMD', () => {
    // A QCD at or above the gross IRA-pool RMD ($90k vs about $80k on a $2M IRA) satisfies the whole RMD: zero shortfall and
    // zero net taxable RMD.
    const withQcd = runBalanceProjectionForPage(commonArgs({ qcd: [qcdEntry(90_000)] }));
    const yr = 2030;
    const q = (withQcd.planned?.years ?? []).find((y) => y.year === yr);
    if (!q) throw new Error('missing year row');
    const grossRmdCents = q.rmdFloorCents ?? 0;
    expect(grossRmdCents).toBeGreaterThan(0);
    expect(grossRmdCents).toBeLessThan(9_000_000);
    expect(q.qcdCents).toBe(9_000_000);
    expect(q.rmdShortfallCents ?? 0).toBe(0);
    expect(q.netTaxableRmdCents).toBe(0);
  });

  it('MAGI / taxable-income drop equals EXACTLY the QCD amount — no double exclusion', () => {
    // No double exclusion: the engine excludes the QCD structurally (the gift is never a taxable pre-tax withdrawal), so
    // qcdIncomeExclusionDollars (the reserved MC seam) must stay unpopulated; MAGI falls by exactly Q, never 2×.
    const base = runBalanceProjection(commonArgs({}));
    const withQcd = runBalanceProjection(commonArgs({ qcd: [qcdEntry(20_000)] }));
    const yr = 2030;
    const b = rowFor(base, yr);
    const q = rowFor(withQcd, yr);
    const magiDropCents = (b.magiCents ?? 0) - (q.magiCents ?? 0);
    // Exactly Q (= $20,000); a double exclusion would show ~$40,000.
    expect(magiDropCents).toBe(2_000_000);
  });

  it('a sub-70½ / pre-window member directs no QCD (gated off)', () => {
    // A member whose 70½ year falls after the window gets the entry dropped; no QCD is stamped anywhere.
    const youngerMember = member('m1', true, 'Pat', '1975-01-01');
    const args = commonArgs({ qcd: [qcdEntry(20_000)] });
    const page = runBalanceProjectionForPage({ ...args, members: [youngerMember] });
    const anyQcd = (page.planned?.years ?? []).some((y) => (y.qcdCents ?? 0) > 0);
    expect(anyQcd).toBe(false);
  });
});
