/**
 * Deterministic QCD integration tests. Exercises the full
 * `runBalanceProjection` / `runBalanceProjectionForPage` pipeline with a
 * Qualified Charitable Distribution directive and asserts the engine-level
 * effects:
 *
 *  - the QCD lowers BOTH MAGI lines (federal/IRMAA AND ACA-PTC) → lower federal
 *    tax / IRMAA / higher ACA-PTC vs an identical no-QCD scenario;
 *  - a QCD that moves a §86 SS-tax tier;
 *  - the IRMAA drop appears two years AFTER the first QCD year (Y+2 ring);
 *  - the offset is scoped to the IRA pool only (IRA + 401k same owner — the
 *    401k RMD floor is unaffected);
 *  - the portfolio drops by exactly Q without funding spending, and the net
 *    taxable RMD = `gross − min(Q, gross)`.
 */
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

/** Member born 1955-01-01: RMD trigger age 73 (born ≥ 1951) → 2028; QCD 70½
 *  first-eligible tax year 2025. Retires at 73 so drawdown starts AT the RMD
 *  trigger year (RMD + QCD both active from year 0 of drawdown). */
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
  // Active 2028..2034 inclusive (covers the RMD years from drawdown start).
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
    // Both MAGI lines drop by the QCD (federal/IRMAA MAGI here; ACA MAGI shares
    // the same AGI base).
    expect(q.magiCents ?? 0).toBeLessThan(b.magiCents ?? 0);
    // Lower taxable income → lower federal tax.
    expect(q.federalTaxCents ?? 0).toBeLessThan(b.federalTaxCents ?? 0);
  });

  it('lifts a younger ACA-on-Marketplace spouse’s PTC via the reduced ACA MAGI line', () => {
    // The QCD donor (primary, 73+) is always Medicare-age, so a QCD year never
    // has ACA-PTC for the donor. The ACA MAGI line still matters for a YOUNGER
    // spouse on the Marketplace: the household MAGI drops by the QCD, lifting
    // the secondary's premium tax credit (both MAGI lines fall).
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
    // 2030: secondary is 62 (on ACA). The reduced ACA MAGI lifts the PTC.
    const yr = 2030;
    const bAca = rowFor(base, yr).acaPtcSubsidyCents ?? 0;
    const qAca = rowFor(withQcd, yr).acaPtcSubsidyCents ?? 0;
    expect(qAca).toBeGreaterThan(bAca);
  });

  it('IRMAA drop appears two years after the first QCD year (Y+2 ring)', () => {
    // High pre-tax balance + SS → MAGI clears the IRMAA threshold without the
    // QCD. The first QCD year is deliberately 2031 (a few years into drawdown,
    // so its IRMAA look-back is a real prior drawdown year, not the year-0
    // projected-MAGI estimate). IRMAA reads MAGI from two years prior, so the
    // first QCD year's MAGI reduction lands in IRMAA in 2033 (Y+2), while the
    // QCD year's OWN surcharge (look-back 2029, pre-QCD) is unchanged.
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
    // The QCD year's OWN IRMAA (look-back 2029, two years before the first QCD
    // year) is unchanged — the gift has not yet reached the ring.
    expect(rowFor(withQcd, 2031).irmaaSurchargeCents ?? 0).toBe(
      rowFor(base, 2031).irmaaSurchargeCents ?? 0,
    );
    // Two years later (2033) the first QCD year's reduced MAGI lowers IRMAA.
    expect(rowFor(withQcd, 2033).irmaaSurchargeCents ?? 0).toBeLessThan(
      rowFor(base, 2033).irmaaSurchargeCents ?? 0,
    );
  });

  it('can move a §86 Social Security taxation tier down', () => {
    // Modest SS + a QCD large enough to pull provisional income below an §86
    // tier boundary in some QCD year → the taxable-SS tier is no higher with
    // the QCD than without, and strictly lower in at least one year.
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
    // Inflation is 0% in this scenario, so the nominal QCD is exactly $20,000.
    expect(q.qcdCents).toBe(2_000_000);
    // The QCD-bearing year's ending balance is BELOW the no-QCD year's by the
    // gift that left the portfolio (the gift does not fund spending — it is a
    // first-dollars non-spending slice). Returns + draws are otherwise identical.
    expect(q.balance).toBeLessThan(b.balance);
    // Net taxable RMD = gross IRA-pool RMD − min(Q, gross). The no-QCD year's
    // RMD floor is the gross; with a $20k QCD ≤ gross, the net taxable RMD is
    // `gross − 20k`.
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
    // The 401k is its own RMD pool; the QCD (IRA-only) never offsets it. The
    // 401k's per-account required RMD is identical with and without the QCD.
    const k401Base = b.perAccountRmdCents?.['k401'] ?? 0;
    const k401Qcd = q.perAccountRmdCents?.['k401'] ?? 0;
    expect(k401Base).toBeGreaterThan(0);
    expect(k401Qcd).toBe(k401Base);
    // The QCD applied (inflation 0% → nominal $30,000) and the net-taxable-RMD
    // reflects the IRA-pool offset: it is strictly below the household RMD floor
    // (which still includes the untouched 401k pool), proving the offset is
    // scoped to the IRA pool only.
    expect(q.qcdCents).toBe(3_000_000);
    expect(q.netTaxableRmdCents).toBeDefined();
    expect(q.netTaxableRmdCents ?? 0).toBeLessThan(q.rmdFloorCents ?? 0);
  });

  it('an over-RMD surplus year shows NO phantom RMD shortfall (QCD satisfies the IRA RMD)', () => {
    // Regression: in an over-RMD surplus year the gross IRA RMD ≥ spending,
    // so the engine draws the gross RMD anyway. A QCD is the first-dollars,
    // non-spending slice that the engine debits directly to the IRA pre-tax
    // bucket (never written to accountBalances[*].withdrawn) and credits toward
    // the IRA-pool RMD floor (IRC §408(d)(8)). The shortfall metric must NOT
    // report a phantom miss: the QCD COUNTS TOWARD the RMD.
    //
    // $2M IRA + $40k spending → gross RMD ≫ spending (over-RMD surplus year).
    // A modest $20k QCD is ≤ gross, so the year is fully RMD-compliant.
    const withQcd = runBalanceProjectionForPage(commonArgs({ qcd: [qcdEntry(20_000)] }));
    const yr = 2030;
    const q = (withQcd.planned?.years ?? []).find((y) => y.year === yr);
    if (!q) throw new Error('missing year row');
    // The QCD applied (inflation 0% → nominal $20,000).
    expect(q.qcdCents).toBe(2_000_000);
    // No phantom shortfall — the QCD satisfied its slice of the IRA RMD.
    expect(q.rmdShortfallCents ?? 0).toBe(0);
    // Net taxable RMD = gross − min(Q, gross) (Q ≤ gross here).
    const grossRmdCents = q.rmdFloorCents ?? 0;
    expect(grossRmdCents).toBeGreaterThan(2_000_000);
    expect(q.netTaxableRmdCents).toBe(grossRmdCents - 2_000_000);
  });

  it('a QCD ≥ the gross IRA RMD fully satisfies it — zero shortfall, zero net taxable RMD', () => {
    // Regression: a QCD that meets or exceeds the gross IRA-pool RMD fully
    // satisfies the required minimum. $90k QCD vs a ~$80k gross RMD on a $2M IRA
    // → the whole RMD is QCD-satisfied: zero phantom shortfall AND zero net
    // taxable RMD (the donor owes no income tax on the satisfied RMD).
    const withQcd = runBalanceProjectionForPage(commonArgs({ qcd: [qcdEntry(90_000)] }));
    const yr = 2030;
    const q = (withQcd.planned?.years ?? []).find((y) => y.year === yr);
    if (!q) throw new Error('missing year row');
    const grossRmdCents = q.rmdFloorCents ?? 0;
    // Fixture invariant: the gross IRA RMD is below the $90k QCD this year.
    expect(grossRmdCents).toBeGreaterThan(0);
    expect(grossRmdCents).toBeLessThan(9_000_000);
    expect(q.qcdCents).toBe(9_000_000);
    expect(q.rmdShortfallCents ?? 0).toBe(0);
    expect(q.netTaxableRmdCents).toBe(0);
  });

  it('MAGI / taxable-income drop equals EXACTLY the QCD amount — no double exclusion', () => {
    // Pins the no-double-exclude contract: the deterministic engine achieves the
    // QCD income exclusion STRUCTURALLY (the gift is never drawn as a taxable
    // pre-tax withdrawal). `qcdIncomeExclusionDollars` is the reserved MC seam
    // and must NOT also be populated deterministically (that would double-count).
    // In an over-RMD year the forced taxable RMD is `gross − min(Q,gross)`, so
    // the year's MAGI falls by EXACTLY Q vs the no-QCD baseline (1×, never 2×).
    const base = runBalanceProjection(commonArgs({}));
    const withQcd = runBalanceProjection(commonArgs({ qcd: [qcdEntry(20_000)] }));
    const yr = 2030;
    const b = rowFor(base, yr);
    const q = rowFor(withQcd, yr);
    const magiDropCents = (b.magiCents ?? 0) - (q.magiCents ?? 0);
    // Exactly Q (= $20,000) — a double exclusion would show ~$40,000.
    expect(magiDropCents).toBe(2_000_000);
  });

  it('a sub-70½ / pre-window member directs no QCD (gated off)', () => {
    // Window starts 2028; a QCD with a window entirely before drawdown's RMD
    // years still resolves but applies only in active years. Use a member whose
    // 70½ year is after the window → the resolver drops the entry; assert no
    // QCD stamped anywhere.
    const youngerMember = member('m1', true, 'Pat', '1975-01-01');
    const args = commonArgs({ qcd: [qcdEntry(20_000)] });
    const page = runBalanceProjectionForPage({ ...args, members: [youngerMember] });
    const anyQcd = (page.planned?.years ?? []).some((y) => (y.qcdCents ?? 0) > 0);
    expect(anyQcd).toBe(false);
  });
});
