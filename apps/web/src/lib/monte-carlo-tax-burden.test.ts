/**
 * Tests for the Monte Carlo tax post-pass (`monte-carlo-tax-burden.ts`).
 *
 * The post-pass stamps `federalTaxCents` / `irmaaSurchargeCents` /
 * `acaPtcSubsidyCents` onto a NAMED-strategy representative run's drawdown-phase
 * rows from the REAL per-account withdrawal splits, reusing the kernel MC tax
 * glue. Covers: methodology parity vs `applyPerYearTaxForPath`, the per-owner
 * RMD-floor override, penalty fold-in, the IRMAA lookback with no
 * bootstrap MAGI, genuine-zero, the no-op / detect-and-skip contract, and the
 * display-only invariant (only the three tax-cent fields change).
 */
import { describe, expect, it } from 'vitest';
import { applyMcTaxToRepresentativeYears } from './monte-carlo-tax-burden';
import {
  applyPerYearTaxForPath,
  classifyMcWithdrawal,
  seedMcAggregateRothBasisCarrier,
  type McAccountYearWithdrawal,
  type McTaxContext,
  type McWithdrawalClassification,
} from './monte-carlo-tax';
import { DEFAULT_TAX_CALIBRATION_BUNDLE, dollarsToCents } from './tax-integration';
import type { DrawdownYear, DrawdownAccountYear } from './drawdown-engine-types';
import type { McTaxPostPassArgs, MonteCarloAccountLedger } from './monte-carlo-types';

const FIRST_YEAR = 2030;
const RETIREMENT_YEAR = 2030;

function mfjContext(overrides: Partial<McTaxContext> = {}): McTaxContext {
  return {
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'MFJ',
    members: [
      { memberId: 'primary', isoBirthdate: '1955-01-01', onMedicare: false, hasAcaCoverage: false },
      { memberId: 'secondary', isoBirthdate: '1957-01-01', onMedicare: false, hasAcaCoverage: false },
    ],
    householdSize: 2,
    inflationRatePct: 3,
    ...overrides,
  };
}

/** A pre-tax IRA ledger account (drives ordinary-income classification). */
function preTaxLedger(id = 'ira'): MonteCarloAccountLedger {
  return {
    id,
    initialPre: 1_000_000,
    initialPost: 0,
    contribPre: new Float64Array(),
    contribPost: new Float64Array(),
    deposit: new Float64Array(),
    assetMix: null,
    assetMixSeries: null,
    cbpPlanningReturnPct: null,
    taxTreatment: 'PRE_TAX',
    accountType: 'RETIREMENT_IRA',
    ownerId: 'primary',
  };
}

/** A MIXED-treatment ledger account (both pre- and post-tax sub-buckets). */
function mixedLedger(id = 'mixed-ira'): MonteCarloAccountLedger {
  return {
    ...preTaxLedger(id),
    taxTreatment: 'MIXED',
  };
}

/** A drawdown-phase row whose single pre-tax account withdraws `preDollars`. */
function drawdownPhaseYear(
  year: number,
  preDollars: number,
  accountId = 'ira',
  extra: Partial<DrawdownYear> = {},
): DrawdownYear {
  const acct: DrawdownAccountYear = {
    balance: 1_000_000,
    preEnd: 1_000_000 - preDollars,
    postEnd: 0,
    withdrawn: preDollars,
    deposit: 0,
    preWithdrawnCents: dollarsToCents(preDollars),
    postWithdrawnCents: 0,
  };
  return {
    year,
    balance: 1_000_000,
    withdrawn: preDollars,
    netNeed: preDollars,
    growth: 40_000,
    deposit: 0,
    depleted: false,
    accountBalances: new Map([[accountId, acct]]),
    ...extra,
  };
}

function postPassArgs(
  years: DrawdownYear[],
  ledger: MonteCarloAccountLedger[],
  taxCtx: McTaxContext,
  overrides: Partial<McTaxPostPassArgs> = {},
): McTaxPostPassArgs {
  const horizon = years.length;
  return {
    years,
    ledger,
    taxCtx,
    firstYear: FIRST_YEAR,
    retirementYear: RETIREMENT_YEAR,
    ssByYear: new Array(horizon).fill(30_000),
    incomeByYear: new Array(horizon).fill(0),
    ...overrides,
  };
}

describe('applyMcTaxToRepresentativeYears', () => {
  it('stamps federal tax / IRMAA / ACA cents matching applyPerYearTaxForPath (methodology parity)', () => {
    const ctx = mfjContext();
    const ledger = [preTaxLedger()];
    const preDollars = 90_000;
    const years = [drawdownPhaseYear(FIRST_YEAR, preDollars)];
    applyMcTaxToRepresentativeYears(postPassArgs(years, ledger, ctx));

    // Equivalent kernel-glue call: same classification (all pre-tax), same SS,
    // floor overridden to 0 (no rmdFloorCents stamped on the row here).
    const classification: McWithdrawalClassification = {
      preTaxDollars: preDollars,
      postTaxNonRothDollars: 0,
      postTaxCashLikeDollars: 0,
      rothBasisOrderedDollars: 0,
      rothWholesaleTaxFreeDollars: 0,
    };
    const expected = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: FIRST_YEAR,
      retirementYear: RETIREMENT_YEAR,
      grossSsDollars: 30_000,
      nominalExpense: 0,
      otherIncome: 0,
      priorBalance: 0,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification,
      rothBasisCarrier: seedMcAggregateRothBasisCarrier(new Map()),
    })!;

    expect(years[0].federalTaxCents).toBe(dollarsToCents(expected.fedTax));
    expect(years[0].irmaaSurchargeCents).toBe(dollarsToCents(expected.irmaa));
    expect(years[0].acaPtcSubsidyCents).toBe(dollarsToCents(expected.ptc));
    // A real pre-tax draw owes federal tax.
    expect(years[0].federalTaxCents!).toBeGreaterThan(0);
  });

  it('uses the per-owner rmdFloorCents override, not a larger pre-tax-pool floor', () => {
    // The row's actual pre-tax draw is tiny but it carries a modest per-owner
    // rmdFloorCents ($20k). A LARGER pre-tax pool ($1M as a single owner's pre-tax
    // bucket) would gross up far more through the per-owner floor. Assert the
    // stamped tax stays low (consistent with the row's $20k floor), far below what
    // the large per-owner floor would produce — i.e. the override wins.
    const ctx = mfjContext();
    const ledger = [preTaxLedger()];
    const smallDraw = 5_000;
    const perOwnerFloorCents = dollarsToCents(20_000);
    const years = [
      drawdownPhaseYear(FIRST_YEAR, smallDraw, 'ira', {
        rmdFloorCents: perOwnerFloorCents,
        balance: 1_000_000,
      }),
    ];
    applyMcTaxToRepresentativeYears(postPassArgs(years, ledger, ctx));
    const withOverride = years[0].federalTaxCents!;

    // A $1M pre-tax pool (owned by the RMD-age primary) grosses a much larger RMD
    // floor than the row's $20k override — the larger-floor output for the same
    // draw + grossSS, no override.
    const largeFloor = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: FIRST_YEAR,
      retirementYear: RETIREMENT_YEAR,
      grossSsDollars: 30_000,
      nominalExpense: 0,
      otherIncome: 0,
      priorBalance: 1_000_000,
      priorPreTaxByOwner: new Map<string, number>([['primary', 1_000_000_00]]),
      magiMinus2: undefined,
      classification: {
        preTaxDollars: smallDraw,
        postTaxNonRothDollars: 0,
        postTaxCashLikeDollars: 0,
        rothBasisOrderedDollars: 0,
        rothWholesaleTaxFreeDollars: 0,
      },
      rothBasisCarrier: seedMcAggregateRothBasisCarrier(new Map()),
    })!;
    expect(withOverride).toBeLessThan(dollarsToCents(largeFloor.fedTax));
  });

  it('folds the §72(t) early-withdrawal penalty into federalTaxCents', () => {
    // Primary born 1985 → age 45 in 2030 (pre-59½). A pre-tax draw triggers the
    // 10% §72(t) penalty, which must be INCLUDED in the stamped federalTaxCents
    // (matching the deterministic chart).
    const ctx = mfjContext({
      members: [
        { memberId: 'primary', isoBirthdate: '1985-01-01', onMedicare: false, hasAcaCoverage: false },
        { memberId: 'secondary', isoBirthdate: '1985-01-01', onMedicare: false, hasAcaCoverage: false },
      ],
      householdSize: 2,
    });
    const ledger = [preTaxLedger()];
    const preDollars = 60_000;
    const years = [drawdownPhaseYear(FIRST_YEAR, preDollars)];
    applyMcTaxToRepresentativeYears(postPassArgs(years, ledger, ctx));
    const withPenalty = years[0].federalTaxCents!;

    // The kernel glue's federalTaxCents EXCLUDES the penalty (it lives in the
    // cashflow). So the stamped value must exceed the glue's fed-tax alone by
    // the §72(t) 10% on the $60k pre-tax draw ($6,000 = 600,000 cents).
    const glueOnly = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: FIRST_YEAR,
      retirementYear: RETIREMENT_YEAR,
      grossSsDollars: 30_000,
      nominalExpense: 0,
      otherIncome: 0,
      priorBalance: 0,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification: {
        preTaxDollars: preDollars,
        postTaxNonRothDollars: 0,
        postTaxCashLikeDollars: 0,
        rothBasisOrderedDollars: 0,
        rothWholesaleTaxFreeDollars: 0,
      },
      rothBasisCarrier: seedMcAggregateRothBasisCarrier(new Map()),
    })!;
    expect(withPenalty).toBe(dollarsToCents(glueOnly.fedTax) + dollarsToCents(6_000));
  });

  it('charges $0 IRMAA for the first two taxed years with no MAGI bootstrap', () => {
    // Members on Medicare every year (born 1950 → age 80 in 2030). With NO
    // magiBootstrap, the kernel-parity rule charges $0 IRMAA for projection
    // years 0–1, then the rolling ring picks up from year 2.
    const ctx = mfjContext({
      members: [
        { memberId: 'primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false },
        { memberId: 'secondary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false },
      ],
    });
    const ledger = [preTaxLedger()];
    const years = [
      drawdownPhaseYear(FIRST_YEAR, 600_000),
      drawdownPhaseYear(FIRST_YEAR + 1, 600_000),
      drawdownPhaseYear(FIRST_YEAR + 2, 600_000),
    ];
    applyMcTaxToRepresentativeYears(postPassArgs(years, ledger, ctx));
    // Years 0–1: no bootstrap → $0 IRMAA.
    expect(years[0].irmaaSurchargeCents).toBe(0);
    expect(years[1].irmaaSurchargeCents).toBe(0);
    // Year 2 reads MAGI from 2 taxed years prior (year 0's high draw) → IRMAA.
    expect(years[2].irmaaSurchargeCents!).toBeGreaterThan(0);
  });

  it('stamps $0 federal tax for a genuine zero / Roth-only low-income year', () => {
    // Income covers expenses, tiny pre-tax draw, standard deduction wipes it.
    const ctx = mfjContext();
    const ledger = [preTaxLedger()];
    const years = [drawdownPhaseYear(FIRST_YEAR, 100)];
    applyMcTaxToRepresentativeYears(
      postPassArgs(years, ledger, ctx, {
        ssByYear: [0],
        incomeByYear: [0],
      }),
    );
    expect(years[0].federalTaxCents).toBe(0);
  });

  it('taxes the DEPLETION year even though the depletion clamp zeroed its balance to $0', () => {
    // The absorbing-depletion clamp zeroes the depletion year's `balance`, but
    // that year still had a REAL $90k pre-tax withdrawal — so federal tax / IRMAA / PTC
    // must still be stamped. `depletionYear === FIRST_YEAR` makes this the
    // depletion year (NOT strictly-post-depletion), so the guard must NOT skip it.
    const ctx = mfjContext();
    const ledger = [preTaxLedger()];
    const years = [drawdownPhaseYear(FIRST_YEAR, 90_000, 'ira', { balance: 0 })];
    applyMcTaxToRepresentativeYears(
      postPassArgs(years, ledger, ctx, { depletionYear: FIRST_YEAR }),
    );
    // The depletion year's real withdrawal owes tax.
    expect(years[0].federalTaxCents!).toBeGreaterThan(0);
    expect(years[0].irmaaSurchargeCents).toBeDefined();
    expect(years[0].acaPtcSubsidyCents).toBeDefined();
  });

  it('skips a STRICTLY-post-depletion zero-balance year (control)', () => {
    // The depletion year (FIRST_YEAR) had real activity and is taxed; the NEXT
    // year (FIRST_YEAR + 1) is strictly post-depletion — balance clamped to $0,
    // no real withdrawals — so it must be skipped (no phantom tax).
    const ctx = mfjContext();
    const ledger = [preTaxLedger()];
    const depletionRow = drawdownPhaseYear(FIRST_YEAR, 90_000, 'ira', { balance: 0 });
    const postRow = drawdownPhaseYear(FIRST_YEAR + 1, 0, 'ira', {
      balance: 0,
      withdrawn: 0,
      netNeed: 0,
    });
    const years = [depletionRow, postRow];
    applyMcTaxToRepresentativeYears(
      postPassArgs(years, ledger, ctx, { depletionYear: FIRST_YEAR }),
    );
    // Depletion year taxed; strictly-post-depletion year untouched.
    expect(years[0].federalTaxCents!).toBeGreaterThan(0);
    expect(years[1].federalTaxCents).toBeUndefined();
    expect(years[1].irmaaSurchargeCents).toBeUndefined();
    expect(years[1].acaPtcSubsidyCents).toBeUndefined();
  });

  it('no-ops when members is empty', () => {
    const ctx = mfjContext({ members: [], householdSize: 0 });
    const ledger = [preTaxLedger()];
    const years = [drawdownPhaseYear(FIRST_YEAR, 90_000)];
    applyMcTaxToRepresentativeYears(postPassArgs(years, ledger, ctx));
    expect(years[0].federalTaxCents).toBeUndefined();
  });

  it('detect-and-skips a run whose rows lack the per-account split, leaving kernel values intact', () => {
    const ctx = mfjContext();
    const ledger = [preTaxLedger()];
    // Kernel-fallback row: an accountBalances map WITHOUT preWithdrawnCents, and
    // a pre-existing kernel-funded federalTaxCents that must NOT be clobbered.
    const kernelAcct: DrawdownAccountYear = {
      balance: 1_000_000,
      preEnd: 910_000,
      postEnd: 0,
      withdrawn: 90_000,
      deposit: 0,
    };
    const years: DrawdownYear[] = [
      {
        year: FIRST_YEAR,
        balance: 1_000_000,
        withdrawn: 90_000,
        netNeed: 90_000,
        growth: 40_000,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([['ira', kernelAcct]]),
        federalTaxCents: 777_777,
        irmaaSurchargeCents: 11_111,
        acaPtcSubsidyCents: 22_222,
      },
    ];
    applyMcTaxToRepresentativeYears(postPassArgs(years, ledger, ctx));
    expect(years[0].federalTaxCents).toBe(777_777);
    expect(years[0].irmaaSurchargeCents).toBe(11_111);
    expect(years[0].acaPtcSubsidyCents).toBe(22_222);
  });

  it('leaves pre-retirement accumulation rows (no accountBalances) untouched', () => {
    const ctx = mfjContext();
    const ledger = [preTaxLedger()];
    const accumulationRow: DrawdownYear = {
      year: FIRST_YEAR - 1,
      balance: 800_000,
      withdrawn: 0,
      netNeed: 0,
      growth: 50_000,
      deposit: 10_000,
      depleted: false,
    };
    const years = [accumulationRow, drawdownPhaseYear(FIRST_YEAR, 90_000)];
    applyMcTaxToRepresentativeYears(
      postPassArgs(years, ledger, ctx, {
        ssByYear: [30_000, 30_000],
        incomeByYear: [0, 0],
      }),
    );
    expect(years[0].federalTaxCents).toBeUndefined();
    expect(years[1].federalTaxCents!).toBeGreaterThan(0);
  });

  it('display-only: mutates only the three tax-cent fields, leaving balance/withdrawn/growth untouched', () => {
    const ctx = mfjContext();
    const ledger = [preTaxLedger()];
    const row = drawdownPhaseYear(FIRST_YEAR, 90_000);
    const before = {
      balance: row.balance,
      withdrawn: row.withdrawn,
      growth: row.growth,
      netNeed: row.netNeed,
      accountBalances: row.accountBalances,
    };
    applyMcTaxToRepresentativeYears(postPassArgs([row], ledger, ctx));
    expect(row.balance).toBe(before.balance);
    expect(row.withdrawn).toBe(before.withdrawn);
    expect(row.growth).toBe(before.growth);
    expect(row.netNeed).toBe(before.netNeed);
    expect(row.accountBalances).toBe(before.accountBalances);
  });

  it('classifies a MIXED-account year using the real pre/post split — parity with classifyMcWithdrawal (MIXED branch)', () => {
    const ctx = mfjContext();
    const ledger = [mixedLedger()];
    // Pre-tax tranche: $40k ordinary income. Post-tax tranche: $30k post-tax basis.
    const preWithdrawnCents = dollarsToCents(40_000);
    const postWithdrawnCents = dollarsToCents(30_000);
    const acct: DrawdownAccountYear = {
      balance: 900_000,
      preEnd: 560_000,
      postEnd: 270_000,
      withdrawn: 70_000,
      deposit: 0,
      preWithdrawnCents,
      postWithdrawnCents,
    };
    const year: DrawdownYear = {
      year: FIRST_YEAR,
      balance: 900_000,
      withdrawn: 70_000,
      netNeed: 70_000,
      growth: 40_000,
      deposit: 0,
      depleted: false,
      accountBalances: new Map([['mixed-ira', acct]]),
    };
    applyMcTaxToRepresentativeYears(postPassArgs([year], ledger, ctx));

    // Reconstruct the classification that classifyYear's MIXED branch produces and
    // verify methodology parity: stamped tax == applyPerYearTaxForPath with that same
    // classification. This confirms the MIXED split routes pre/post tranches separately.
    const mixedEntries: McAccountYearWithdrawal[] = [
      {
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_IRA',
        withdrawalDollars: 40_000,
        preBalanceStartDollars: 0,
        postBalanceStartDollars: 0,
      },
      // The post tranche rides a synthesized MIXED entry (post "balance"
      // = the tranche) so classifyMcWithdrawal's own post-bucket rule routes it
      // — for a non-Roth-designated RETIREMENT_IRA that lands in the same
      // postTaxNonRoth bucket a plain POST_TAX synthesis would produce.
      {
        taxTreatment: 'MIXED',
        accountType: 'RETIREMENT_IRA',
        withdrawalDollars: 30_000,
        preBalanceStartDollars: 0,
        postBalanceStartDollars: 30_000,
      },
    ];
    const expectedClassification = classifyMcWithdrawal(mixedEntries);
    const expected = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: FIRST_YEAR,
      retirementYear: RETIREMENT_YEAR,
      grossSsDollars: 30_000,
      nominalExpense: 0,
      otherIncome: 0,
      priorBalance: 0,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification: expectedClassification,
      rothBasisCarrier: seedMcAggregateRothBasisCarrier(new Map()),
    })!;

    expect(year.federalTaxCents).toBe(dollarsToCents(expected.fedTax));
    expect(year.irmaaSurchargeCents).toBe(dollarsToCents(expected.irmaa));
    expect(year.acaPtcSubsidyCents).toBe(dollarsToCents(expected.ptc));
    // The pre-tax tranche is only $40k — the post-tax tranche must not inflate
    // ordinary income to the full $70k.
    expect(expectedClassification.preTaxDollars).toBe(40_000);
  });

  it('preserves a MIXED 457(b) Roth-designated post tranche as Roth-ordered — not generic POST_TAX — with the 457(b) penalty exemption intact', () => {
    // Pre-59½ members (born 1985 → age 45 in 2030) so both penalty legs are
    // live. A MIXED governmental 457(b) pools with a penalized PRE_TAX IRA:
    //   - 457(b) pre tranche  $40k → ordinary income, §72(t)-EXEMPT (statutory).
    //   - 457(b) post tranche $30k → Roth-DESIGNATED money: must classify as
    //     `rothBasisOrderedDollars` (§408A ordering; earnings excess above basis
    //     is ordinary income) with the 457(b) Roth-leg exemption — NOT as a
    //     generic POST_TAX LTCG-proxy draw.
    //   - IRA $20k → ordinary income, penalized (the only 10% leg).
    const ctx = mfjContext({
      members: [
        { memberId: 'primary', isoBirthdate: '1985-01-01', onMedicare: false, hasAcaCoverage: false },
        { memberId: 'secondary', isoBirthdate: '1985-01-01', onMedicare: false, hasAcaCoverage: false },
      ],
    });
    const mixed457b: MonteCarloAccountLedger = {
      ...preTaxLedger('mixed-457b'),
      taxTreatment: 'MIXED',
      accountType: 'RETIREMENT_457B',
      initialPost: 300_000,
    };
    const ledger = [mixed457b, preTaxLedger('ira')];
    const mixedAcct: DrawdownAccountYear = {
      balance: 900_000,
      preEnd: 560_000,
      postEnd: 270_000,
      withdrawn: 70_000,
      deposit: 0,
      preWithdrawnCents: dollarsToCents(40_000),
      postWithdrawnCents: dollarsToCents(30_000),
    };
    const iraAcct: DrawdownAccountYear = {
      balance: 980_000,
      preEnd: 980_000,
      postEnd: 0,
      withdrawn: 20_000,
      deposit: 0,
      preWithdrawnCents: dollarsToCents(20_000),
      postWithdrawnCents: 0,
    };
    const year: DrawdownYear = {
      year: FIRST_YEAR,
      balance: 1_880_000,
      withdrawn: 90_000,
      netNeed: 90_000,
      growth: 40_000,
      deposit: 0,
      depleted: false,
      accountBalances: new Map([
        ['mixed-457b', mixedAcct],
        ['ira', iraAcct],
      ]),
    };
    applyMcTaxToRepresentativeYears(postPassArgs([year], ledger, ctx));

    // Reconstruct the classification the FIXED classifyYear produces (the post
    // tranche rides a synthesized MIXED entry so `classifyMcWithdrawal`'s own
    // Roth-designated post-bucket rule routes it) and assert its fidelity.
    const expectedClassification = classifyMcWithdrawal([
      {
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_457B',
        withdrawalDollars: 40_000,
        preBalanceStartDollars: 0,
        postBalanceStartDollars: 0,
        scenarioPenaltyExempt: false,
      },
      {
        taxTreatment: 'MIXED',
        accountType: 'RETIREMENT_457B',
        withdrawalDollars: 30_000,
        preBalanceStartDollars: 0,
        postBalanceStartDollars: 30_000,
        scenarioPenaltyExempt: false,
      },
      {
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_IRA',
        withdrawalDollars: 20_000,
        preBalanceStartDollars: 980_000,
        postBalanceStartDollars: 0,
        scenarioPenaltyExempt: false,
      },
    ]);
    // Classification fidelity: the Roth-designated tranche is Roth-ordered (with
    // the 457(b) exemption), never a generic post-tax bucket.
    expect(expectedClassification.preTaxDollars).toBe(60_000);
    expect(expectedClassification.preTaxPenaltyExemptDollars).toBe(40_000);
    expect(expectedClassification.rothBasisOrderedDollars).toBe(30_000);
    expect(expectedClassification.rothOrderedPenaltyExemptDollars).toBe(30_000);
    expect(expectedClassification.postTaxNonRothDollars).toBe(0);
    expect(expectedClassification.postTaxCashLikeDollars).toBe(0);

    // Methodology parity: stamped cents == the kernel glue fed that SAME
    // classification, plus the penalty fold-in. With no seeded §408A
    // basis the whole $30k Roth-ordered draw is earnings excess (ordinary
    // income); the §72(t) leg penalizes ONLY the IRA's $20k (10% = $2,000) —
    // the 457(b) pre tranche is statutorily exempt and the Roth-earnings leg's
    // non-exempt share is 0 (all-457(b) ordered draw), so no other penalty.
    const expected = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: FIRST_YEAR,
      retirementYear: RETIREMENT_YEAR,
      grossSsDollars: 30_000,
      nominalExpense: 0,
      otherIncome: 0,
      priorBalance: 0,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification: expectedClassification,
      rothBasisCarrier: seedMcAggregateRothBasisCarrier(new Map()),
    })!;
    expect(year.federalTaxCents).toBe(
      dollarsToCents(expected.fedTax) + dollarsToCents(2_000),
    );
    expect(year.irmaaSurchargeCents).toBe(dollarsToCents(expected.irmaa));
    expect(year.acaPtcSubsidyCents).toBe(dollarsToCents(expected.ptc));

    // Discriminator: the old lossy POST_TAX collapse taxed the tranche as an
    // LTCG proxy — strictly less tax than the Roth-ordered earnings excess
    // here, so the parity assertion above cannot pass under the old code.
    const collapsed = classifyMcWithdrawal([
      {
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_457B',
        withdrawalDollars: 40_000,
        preBalanceStartDollars: 0,
        postBalanceStartDollars: 0,
        scenarioPenaltyExempt: false,
      },
      {
        taxTreatment: 'POST_TAX',
        accountType: 'RETIREMENT_457B',
        withdrawalDollars: 30_000,
        preBalanceStartDollars: 0,
        postBalanceStartDollars: 0,
        scenarioPenaltyExempt: false,
      },
      {
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_IRA',
        withdrawalDollars: 20_000,
        preBalanceStartDollars: 980_000,
        postBalanceStartDollars: 0,
        scenarioPenaltyExempt: false,
      },
    ]);
    const collapsedTax = applyPerYearTaxForPath({
      taxCtx: ctx,
      taxYear: FIRST_YEAR,
      retirementYear: RETIREMENT_YEAR,
      grossSsDollars: 30_000,
      nominalExpense: 0,
      otherIncome: 0,
      priorBalance: 0,
      priorPreTaxByOwner: new Map<string, number>(),
      magiMinus2: undefined,
      classification: collapsed,
      rothBasisCarrier: seedMcAggregateRothBasisCarrier(new Map()),
    })!;
    expect(dollarsToCents(expected.fedTax)).toBeGreaterThan(
      dollarsToCents(collapsedTax.fedTax),
    );
  });
});
