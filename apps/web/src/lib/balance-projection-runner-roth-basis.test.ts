/** Unit tests for `balance-projection-runner-roth-basis.ts`, the Roth §408A basis carrier and ordering helpers. */
import { describe, it, expect } from 'vitest';
import {
  applyRothBasisOrdering,
  creditRothConversionToBasisCarrier,
  seedRothBasisCarrier,
  seedFactBasedRothBasisCarrier,
  seedDesignatedRothCarrier,
  applyFactBasedRothIraOrdering,
  applyFactBasedDesignatedRothDistribution,
  mergeFactBasedRothIraSeeds,
  flattenRothIraPoolsByOwner,
  mergeDesignatedRothSeeds,
} from './balance-projection-runner-roth-basis';
import {
  ROTH_FIVE_TAX_YEAR_PERIOD,
  isRothFiveYearClockMet,
  isRothIraDistributionQualified,
  isDesignatedRothDistributionQualified,
  orderRothIraDistribution,
  splitDesignatedRothNonqualified,
  computeDesignatedRothDistribution,
} from './roth-distribution-tax';
import { buildRothDistributionFacts } from './balance-projection-runner-tax-helpers';
import { computeEarlyWithdrawalPenalty } from './early-withdrawal-penalty';
import { runBalanceProjection } from './balance-projection-runner';
import type { DrawdownYear, DrawdownAccountYear } from './drawdown-engine-types';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';
import {
  makeCtx,
  makeDrawdownYear,
  makeAccountBalance,
  type MakeCtxAccountProjections,
} from './balance-projection-runner-tax-test-fixtures';

function rothAccountPayload(extra: Partial<AccountPayload>): AccountPayload {
  return {
    name: 'Roth',
    type: 'RETIREMENT_ROTH_IRA',
    ownershipType: 'INDIVIDUAL',
    taxTreatment: 'ROTH',
    ownerId: 'member-primary',
    institution: '',
    notes: '',
    planningReturnPct: 6,
    active: true,
    plannedContributionPreTax: 0,
    plannedContributionPostTax: 3000,
    assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    ...extra,
  };
}

function conversionRow(
  accountId: string,
  year: number,
  taxable: number,
  nontaxable = 0,
  extra: Partial<AccountBalancePayload> = {},
): { payload: AccountBalancePayload } {
  return {
    payload: {
      accountId,
      year,
      lastUpdated: `${String(year)}-12-31`,
      rothConversionTaxableAmount: taxable,
      rothConversionNontaxableAmount: nontaxable,
      ...extra,
    } as AccountBalancePayload,
  };
}

// The MIXED split keys are explicit nulls: undefined would read as MIXED and credit nothing.
function contributionRow(
  accountId: string,
  year: number,
  contributions: number,
  extra: Partial<AccountBalancePayload> = {},
): { payload: AccountBalancePayload } {
  return {
    payload: {
      accountId,
      year,
      lastUpdated: `${String(year)}-12-31`,
      totalContributions: contributions,
      contributionsPreTax: null,
      contributionsPostTax: null,
      ...extra,
    } as AccountBalancePayload,
  };
}

function rolloverRow(
  accountId: string,
  year: number,
  taxable: number,
  nontaxable = 0,
): { payload: AccountBalancePayload } {
  return {
    payload: {
      accountId,
      year,
      lastUpdated: `${String(year)}-12-31`,
      rothInPlanRolloverTaxableAmount: taxable,
      rothInPlanRolloverNontaxableAmount: nontaxable,
    } as AccountBalancePayload,
  };
}

describe('applyRothBasisOrdering — per-account earnings allocation', () => {
  it('emitted per-account earnings cents sum EXACTLY to the owner earnings excess (multi-account drift case)', () => {
    // Three same-owner IRAs each draw 100¢ against 100¢ of basis: 200¢ excess. Independent rounding would emit 67¢ each
    // (201¢); residual absorption must sum to exactly 200.
    const accountProjections: MakeCtxAccountProjections = [
      { id: 'roth-a', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
      { id: 'roth-b', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
      { id: 'roth-c', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
    ];
    // Pre-59½: the ordering engine zeroes the additional-tax base once the owner is 59½ for the whole year.
    const ctx = makeCtx({ primaryBirthdate: '1969-01-01', accountProjections });

    const accountBalances = new Map<string, DrawdownAccountYear>([
      ['roth-a', makeAccountBalance(10_000, 1)],
      ['roth-b', makeAccountBalance(10_000, 1)],
      ['roth-c', makeAccountBalance(10_000, 1)],
    ]);
    const year: DrawdownYear = makeDrawdownYear(2024, 3, accountBalances);

    const carrier = seedRothBasisCarrier(new Map([['member-primary', 100]]));

    const split = applyRothBasisOrdering(ctx, year, carrier, new Map());

    expect(Math.round(split.earningsExcessDollars * 100)).toBe(200);

    const emittedCents = split.penaltyAccounts.reduce(
      (sum, acc) => sum + Math.round(acc.penaltyPreTaxWithdrawalDollars * 100),
      0,
    );
    expect(emittedCents).toBe(200);

    expect(emittedCents).not.toBe(201);

    for (const acc of split.penaltyAccounts) {
      expect(acc.type).toBe('RETIREMENT_ROTH_IRA');
      expect(acc.ownerId).toBe('member-primary');
    }
  });

  it('residual is absorbed within each owner, not across owners', () => {
    const accountProjections: MakeCtxAccountProjections = [
      { id: 'p-a', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA', ownerId: 'member-primary' },
      { id: 'p-b', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA', ownerId: 'member-primary' },
      { id: 'p-c', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA', ownerId: 'member-primary' },
      { id: 's-a', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA', ownerId: 'member-secondary' },
      { id: 's-b', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA', ownerId: 'member-secondary' },
      { id: 's-c', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA', ownerId: 'member-secondary' },
    ];
    const ctx = makeCtx({
      primaryBirthdate: '1969-01-01',
      secondaryBirthdate: '1970-01-01',
      accountProjections,
    });

    const accountBalances = new Map<string, DrawdownAccountYear>([
      ['p-a', makeAccountBalance(10_000, 1)],
      ['p-b', makeAccountBalance(10_000, 1)],
      ['p-c', makeAccountBalance(10_000, 1)],
      ['s-a', makeAccountBalance(10_000, 1)],
      ['s-b', makeAccountBalance(10_000, 1)],
      ['s-c', makeAccountBalance(10_000, 1)],
    ]);
    const year: DrawdownYear = makeDrawdownYear(2024, 6, accountBalances);

    const carrier = seedRothBasisCarrier(
      new Map([
        ['member-primary', 100],
        ['member-secondary', 100],
      ]),
    );

    const split = applyRothBasisOrdering(ctx, year, carrier, new Map());

    const sumForOwner = (ownerId: string): number =>
      split.penaltyAccounts
        .filter((acc) => acc.ownerId === ownerId)
        .reduce((sum, acc) => sum + Math.round(acc.penaltyPreTaxWithdrawalDollars * 100), 0);

    expect(sumForOwner('member-primary')).toBe(200);
    expect(sumForOwner('member-secondary')).toBe(200);
    expect(Math.round(split.earningsExcessDollars * 100)).toBe(400);
  });

  it('residual-correct per-account split flows the right penalty share to each account (one exempt)', () => {
    // rothA draws $53 and rothB $51 against $13 of basis: $91 excess (9,100¢). Independent rounding emits 4,638 + 4,463 =
    // 9,101¢; the residual goes to the largest draw (rothA 4,637¢, rothB 4,463¢).
    const accountProjections: MakeCtxAccountProjections = [
      { id: 'rothA', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
      { id: 'rothB', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
    ];
    const ctx = makeCtx({ primaryBirthdate: '1969-01-01', accountProjections });

    const accountBalances = new Map<string, DrawdownAccountYear>([
      ['rothA', makeAccountBalance(400_000, 53)],
      ['rothB', makeAccountBalance(400_000, 51)],
    ]);
    const year: DrawdownYear = makeDrawdownYear(2024, 104, accountBalances);

    const carrier = seedRothBasisCarrier(new Map([['member-primary', 1_300]]));

    const split = applyRothBasisOrdering(ctx, year, carrier, new Map());

    const byId = new Map(
      split.penaltyAccounts.map((acc) => [
        acc.id,
        Math.round(acc.penaltyPreTaxWithdrawalDollars * 100),
      ]),
    );
    expect(Math.round(split.earningsExcessDollars * 100)).toBe(9_100);
    expect(byId.get('rothA')).toBe(4_637); // largest-draw account absorbs the −1¢
    expect(byId.get('rothB')).toBe(4_463);
    const emittedCents = [...byId.values()].reduce((s, c) => s + c, 0);
    expect(emittedCents).toBe(9_100);
    expect(emittedCents).not.toBe(9_101); // independent rounding would have drifted

    // Exempting only rothA waives its residual-correct share ($46.37) while rothB's ($44.63 × 10%) still applies; pre-59½ the
    // fraction is 1.
    const penaltyInputs = split.penaltyAccounts.map((acc) => ({
      id: acc.id,
      type: acc.type,
      penaltyBasisDollars: acc.penaltyPreTaxWithdrawalDollars,
      ownerBirthdate: '1969-01-01',
    }));

    const neitherExempt = computeEarlyWithdrawalPenalty(penaltyInputs, 2024, []);
    const aExempt = computeEarlyWithdrawalPenalty(penaltyInputs, 2024, ['rothA']);

    // Neither exempt: 10% of $91.00 = $9.10.
    expect(Math.round(neitherExempt.penaltyDollars * 100)).toBe(910);
    // rothA exempt: only rothB's $44.63 share is penalized.
    expect(Math.round(aExempt.penaltyDollars * 100)).toBe(446);
    // The waived amount is rothA's 10% share ($4.637).
    expect(
      Math.round((neitherExempt.penaltyDollars - aExempt.penaltyDollars) * 100),
    ).toBe(464);
  });

  it('designated-Roth employer accounts use their OWN pro-rata carrier, never the owner Roth-IRA pool', () => {
    // A Roth 401(k) and a Roth IRA each draw 100¢. The IRA has 100¢ basis (0¢ earnings); the 401(k) has 50¢ designated basis
    // over a 100¢ balance (50¢ basis, 50¢ earnings). Pooling would let the 401(k) shelter itself with the IRA's basis.
    const accountProjections: MakeCtxAccountProjections = [
      { id: 'roth-ira', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
      { id: 'roth-401k', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_401K' },
    ];
    const ctx = makeCtx({ primaryBirthdate: '1969-01-01', accountProjections });

    // Balance 0 dollars with $1.00 withdrawn makes the pre-distribution balance 100¢.
    const accountBalances = new Map([
      ['roth-ira', makeAccountBalance(0, 1)],
      ['roth-401k', makeAccountBalance(0, 1)],
    ]);
    const year = makeDrawdownYear(2024, 2, accountBalances);
    const carrier = seedFactBasedRothBasisCarrier(
      new Map([['member-primary', { rothIra: { regularContributionBasisCents: 100, conversionLots: [] } }]]),
    );
    const designated = seedDesignatedRothCarrier(
      new Map([
        [
          'roth-401k',
          { accountId: 'roth-401k', ownerId: 'member-primary', basisCents: 50 },
        ],
      ]),
    );

    const split = applyRothBasisOrdering(ctx, year, carrier, designated);

    // Only the 401(k)'s pro-rata earnings half is ordinary income.
    expect(Math.round(split.earningsExcessDollars * 100)).toBe(50);
    const byId = new Map(
      split.penaltyAccounts.map((a) => [a.id, Math.round(a.penaltyPreTaxWithdrawalDollars * 100)]),
    );
    expect(byId.get('roth-ira')).toBeUndefined();
    expect(byId.get('roth-401k')).toBe(50);
    // The designated base is pre-resolved for source-level exemptions.
    expect(
      split.penaltyAccounts.find((a) => a.id === 'roth-401k')?.rothOrderedAdditionalTaxBase,
    ).toBe(true);
    expect(carrier.get('member-primary')?.rothBasisRemainingCents).toBe(0);
    expect(designated.get('roth-401k')?.designatedRothBasisRemainingCents).toBe(0);
  });

  it('a designated account with NO recorded basis treats the whole draw as earnings (conservative)', () => {
    // No designated facts: $0 basis and an unmet clock, so the whole split is earnings (treating the balance as basis would
    // shelter it all).
    const accountProjections: MakeCtxAccountProjections = [
      { id: 'roth-403b', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_403B' },
    ];
    const ctx = makeCtx({ primaryBirthdate: '1969-01-01', accountProjections });
    const accountBalances = new Map([['roth-403b', makeAccountBalance(1_000, 100)]]);
    const year = makeDrawdownYear(2024, 100, accountBalances);
    const designated = seedDesignatedRothCarrier(new Map());

    const split = applyRothBasisOrdering(ctx, year, new Map(), designated);

    expect(split.earningsExcessDollars).toBe(100);
    const byId = new Map(
      split.penaltyAccounts.map((a) => [a.id, a.penaltyPreTaxWithdrawalDollars]),
    );
    expect(byId.get('roth-403b')).toBe(100);
    // The on-demand entry keeps later years consuming the same zero-basis state.
    expect(designated.has('roth-403b')).toBe(true);
  });

  it('governmental 457(b) ordinary Roth earnings carry NO §72(t) base but ARE ordinary income', () => {
    // §72(t)(9) exempts ordinary Roth 457(b) earnings from the 10%, but they remain ordinary income.
    const accountProjections: MakeCtxAccountProjections = [
      { id: 'roth-457b', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_457B' },
    ];
    const ctx = makeCtx({ primaryBirthdate: '1969-01-01', accountProjections });
    const accountBalances = new Map([['roth-457b', makeAccountBalance(0, 1)]]);
    const year = makeDrawdownYear(2024, 1, accountBalances);

    const split = applyRothBasisOrdering(ctx, year, new Map(), seedDesignatedRothCarrier(new Map()));

    expect(Math.round(split.earningsExcessDollars * 100)).toBe(100);
    expect(split.penaltyAccounts).toHaveLength(0);
  });

  it('MIXED Roth-designated post sub-bucket splits pro rata against its own recorded basis', () => {
    // MIXED 401(k) draws $3 pre and $2 post (Roth-designated); only the post tranche enters the §402A pro-rata rule. Basis
    // 100¢ over a 200¢ post balance: half basis, half earnings.
    const accountProjections: MakeCtxAccountProjections = [
      { id: 'mixed-401k', taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' },
    ];
    const ctx = makeCtx({ primaryBirthdate: '1969-01-01', accountProjections });

    // makeAccountBalance sets postEnd = balance, so a $0 balance leaves the pre-distribution post pocket at the 200¢ draw.
    const accountBalances = new Map([
      ['mixed-401k', makeAccountBalance(0, 5, { preWithdrawnCents: 300, postWithdrawnCents: 200 })],
    ]);
    const year = makeDrawdownYear(2024, 5, accountBalances);
    const designated = seedDesignatedRothCarrier(
      new Map([
        ['mixed-401k', { accountId: 'mixed-401k', ownerId: 'member-primary', basisCents: 100 }],
      ]),
    );

    const split = applyRothBasisOrdering(ctx, year, new Map(), designated);

    expect(Math.round(split.earningsExcessDollars * 100)).toBe(100);
    const byId = new Map(
      split.penaltyAccounts.map((a) => [a.id, Math.round(a.penaltyPreTaxWithdrawalDollars * 100)]),
    );
    expect(byId.get('mixed-401k')).toBe(100);
  });

  it('MIXED Roth-designated with no postWithdrawnCents field uses 0 (legacy fallback)', () => {
    const accountProjections: MakeCtxAccountProjections = [
      { id: 'mixed-401k-legacy', taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' },
    ];
    const ctx = makeCtx({ accountProjections });

    const accountBalances = new Map([
      ['mixed-401k-legacy', makeAccountBalance(50_000, 5)],
    ]);
    const year = makeDrawdownYear(2024, 5, accountBalances);

    const split = applyRothBasisOrdering(ctx, year, new Map(), new Map());

    expect(split.earningsExcessDollars).toBe(0);
    expect(split.penaltyAccounts).toHaveLength(0);
  });
});

describe('creditRothConversionToBasisCarrier — multi-window target routing', () => {
  // Windows: 2030-2034 → roth-primary (member-primary), 2035-2039 → roth-secondary (member-secondary), each crediting
  // §408A basis to its active window's target owner.
  const accountProjections: MakeCtxAccountProjections = [
    { id: 'roth-primary', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA', ownerId: 'member-primary' },
    { id: 'roth-secondary', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA', ownerId: 'member-secondary' },
  ];
  const twoWindowCap = {
    windows: [
      {
        start: { kind: 'year' as const, year: 2030 },
        end: { kind: 'year' as const, year: 2034 }, // inclusive end-year → exclusive 2035
        magiCeilingAnnualDollars: 0,
        capMode: 'fill' as const,
        capMagiLine: 'irmaa' as const,
        targetRothAccountId: 'roth-primary',
      },
      {
        start: { kind: 'year' as const, year: 2035 },
        end: { kind: 'year' as const, year: 2039 }, // inclusive end-year → exclusive 2040
        magiCeilingAnnualDollars: 0,
        capMode: 'fill' as const,
        capMagiLine: 'irmaa' as const,
        targetRothAccountId: 'roth-secondary',
      },
    ],
  };

  function ctxForTwoWindows() {
    return makeCtx({
      secondaryBirthdate: '1962-01-01',
      accountProjections,
      magiCap: twoWindowCap,
    });
  }

  function yearWithConversion(year: number, convertedCents: number): DrawdownYear {
    return { ...makeDrawdownYear(year, 0), rothConvertedCents: convertedCents };
  }

  it('credits each window-year conversion to that window target Roth owner', () => {
    const ctx = ctxForTwoWindows();
    const carrier = seedRothBasisCarrier(new Map());

    creditRothConversionToBasisCarrier(ctx, yearWithConversion(2031, 10_000), carrier);
    creditRothConversionToBasisCarrier(ctx, yearWithConversion(2033, 20_000), carrier);
    creditRothConversionToBasisCarrier(ctx, yearWithConversion(2036, 30_000), carrier);
    creditRothConversionToBasisCarrier(ctx, yearWithConversion(2038, 40_000), carrier);

    // A conversion is credited as a dated conversion lot, not undated regular basis, so a pre-59½ draw inside the five-tax-year
    // window carries the 10% recapture.
    const lotTotal = (ownerId: string): number =>
      (carrier.get(ownerId)?.conversionLots ?? []).reduce(
        (sum, lot) => sum + lot.taxableRemainingCents + lot.nontaxableRemainingCents,
        0,
      );
    expect(carrier.get('member-primary')?.rothBasisRemainingCents).toBe(0);
    expect(lotTotal('member-primary')).toBe(30_000);
    expect(carrier.get('member-primary')?.conversionLots?.map((l) => l.taxYear)).toEqual([
      2031, 2033,
    ]);
    expect(lotTotal('member-secondary')).toBe(70_000);
    expect(carrier.get('member-secondary')?.conversionLots?.map((l) => l.taxYear)).toEqual([
      2036, 2038,
    ]);
  });

  it('a gap year (no active window) credits no basis', () => {
    // Window 0 covers [2030, 2035), so 2040 (past the last window) is the true gap.
    const ctx = ctxForTwoWindows();
    const carrier = seedRothBasisCarrier(new Map());
    creditRothConversionToBasisCarrier(ctx, yearWithConversion(2040, 50_000), carrier);
    expect(carrier.get('member-primary')).toBeUndefined();
    expect(carrier.get('member-secondary')).toBeUndefined();
  });

  it('an INHERITED target Roth IRA credits no basis to the beneficiary', () => {
    // findTargetRothIndex and isWorkingYearsRothConversionTarget both refuse an inherited target; if cents reached it anyway
    // they would buy tax-free basis on the beneficiary's own Roth IRAs.
    const ctx = makeCtx({
      secondaryBirthdate: '1962-01-01',
      accountProjections,
      magiCap: twoWindowCap,
      rmdProfileFactsByAccountId: new Map([['roth-primary', { inheritedAccount: true }]]),
    });
    const carrier = seedRothBasisCarrier(new Map());
    creditRothConversionToBasisCarrier(ctx, yearWithConversion(2031, 10_000), carrier);
    expect(carrier.get('member-primary')).toBeUndefined();
    creditRothConversionToBasisCarrier(ctx, yearWithConversion(2036, 30_000), carrier);
    expect(
      (carrier.get('member-secondary')?.conversionLots ?? []).reduce(
        (sum, lot) => sum + lot.taxableRemainingCents + lot.nontaxableRemainingCents,
        0,
      ),
    ).toBe(30_000);
  });
});

describe('roth-distribution-tax — five-year clock + qualification', () => {
  it('five-year clock met only at exactly five taxable years', () => {
    expect(isRothFiveYearClockMet(2015, 2019)).toBe(false); // 4 years
    expect(isRothFiveYearClockMet(2015, 2020)).toBe(true); // 5 years
    expect(isRothFiveYearClockMet(2015, 2024)).toBe(true);
  });

  it('missing first-contribution year → clock NOT met (conservative)', () => {
    expect(isRothFiveYearClockMet(undefined, 2024)).toBe(false);
  });

  it('qualified needs BOTH 59½ and the five-year clock', () => {
    const facts = { firstContributionTaxYear: 2015 };
    expect(isRothIraDistributionQualified(facts, 2024, true)).toBe(true);
    expect(isRothIraDistributionQualified(facts, 2024, false)).toBe(false); // not 59½
    expect(isRothIraDistributionQualified({ firstContributionTaxYear: 2022 }, 2024, true)).toBe(
      false,
    ); // clock not met
  });

  it('designated-Roth qualification runs its own participation clock', () => {
    expect(
      isDesignatedRothDistributionQualified({ firstParticipationTaxYear: 2015 }, 2024, true),
    ).toBe(true);
    expect(
      isDesignatedRothDistributionQualified({ firstParticipationTaxYear: 2022 }, 2024, true),
    ).toBe(false); // clock not met
    expect(
      isDesignatedRothDistributionQualified({ firstParticipationTaxYear: undefined }, 2024, true),
    ).toBe(false); // missing → conservative
  });

  it('exposes a five-tax-year period constant of 5', () => {
    expect(ROTH_FIVE_TAX_YEAR_PERIOD).toBe(5);
  });
});

describe('orderRothIraDistribution — §408A ordering (contributions → conversions FIFO → earnings)', () => {
  const facts = {
    regularContributionBasisCents: 10_000, // $100
    firstContributionTaxYear: 2015,
    conversionLots: [
      { taxYear: 2020, taxableConvertedPrincipalCents: 5_000, nontaxableConvertedPrincipalCents: 2_000 },
    ],
  };

  it('nonqualified pre-59½: contributions free, conversion taxable recaptured in-window, earnings taxed + penalized', () => {
    const r = orderRothIraDistribution({
      facts,
      withdrawalCents: 20_000, // $200
      distributionTaxYear: 2024, // 2024 − 2020 = 4 < 5 → recapture applies
      ownerReached59Half: false,
    });
    expect(r.qualified).toBe(false);
    expect(r.regularContributionCents).toBe(10_000);
    expect(r.conversionTaxablePrincipalCents).toBe(5_000);
    expect(r.conversionNontaxablePrincipalCents).toBe(2_000);
    expect(r.earningsCents).toBe(3_000);
    // Income tax on earnings only ($30); conversion principal is never re-taxed.
    expect(r.incomeTaxableCents).toBe(3_000);
    // 10% base = recaptured taxable principal (5_000) + earnings (3_000).
    expect(r.additionalTaxBaseCents).toBe(8_000);
  });

  it('taxable-converted principal OUTSIDE its five-year window carries no recapture', () => {
    const r = orderRothIraDistribution({
      facts,
      withdrawalCents: 20_000,
      distributionTaxYear: 2026, // 2026 − 2020 = 6 ≥ 5 → window closed
      ownerReached59Half: false,
    });
    expect(r.additionalTaxBaseCents).toBe(3_000);
    expect(r.incomeTaxableCents).toBe(3_000);
  });

  it('qualified distribution is entirely tax- and penalty-free', () => {
    const r = orderRothIraDistribution({
      facts,
      withdrawalCents: 20_000,
      distributionTaxYear: 2024,
      ownerReached59Half: true, // + five-year clock met → qualified
    });
    expect(r.qualified).toBe(true);
    expect(r.incomeTaxableCents).toBe(0);
    expect(r.additionalTaxBaseCents).toBe(0);
  });

  it('59½ but clock not met: earnings taxed, but NO 10% penalty and NO recapture', () => {
    const r = orderRothIraDistribution({
      facts: { ...facts, firstContributionTaxYear: 2022 }, // clock not met in 2024
      withdrawalCents: 20_000,
      distributionTaxYear: 2024,
      ownerReached59Half: true,
    });
    expect(r.qualified).toBe(false);
    expect(r.incomeTaxableCents).toBe(3_000);
    expect(r.additionalTaxBaseCents).toBe(0); // 59½ → no §72(t)
  });

  it('missing basis (conservative $0) → the whole withdrawal is earnings', () => {
    const r = orderRothIraDistribution({
      facts: { regularContributionBasisCents: 0, conversionLots: [] },
      withdrawalCents: 4_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false,
    });
    expect(r.regularContributionCents).toBe(0);
    expect(r.earningsCents).toBe(4_000);
    expect(r.incomeTaxableCents).toBe(4_000);
    expect(r.additionalTaxBaseCents).toBe(4_000);
  });

  it('same-year multi-lot — the full AGGREGATED taxable recapture is consumed before ANY same-year nontaxable', () => {
    // Same-year lots aggregate (§408A(d)(4)(B)): taxable 3_000 + 4_000 = 7_000 is fully recaptured before any of the 3_000
    // nontaxable.
    const r = orderRothIraDistribution({
      facts: {
        regularContributionBasisCents: 0,
        conversionLots: [
          { taxYear: 2020, taxableConvertedPrincipalCents: 3_000, nontaxableConvertedPrincipalCents: 1_000 },
          { taxYear: 2020, taxableConvertedPrincipalCents: 4_000, nontaxableConvertedPrincipalCents: 2_000 },
        ],
      },
      withdrawalCents: 7_000,
      distributionTaxYear: 2024, // 2024 − 2020 = 4 < 5 → recapture in window
      ownerReached59Half: false,
    });
    expect(r.conversionTaxablePrincipalCents).toBe(7_000);
    expect(r.conversionNontaxablePrincipalCents).toBe(0);
    expect(r.earningsCents).toBe(0);
    expect(r.additionalTaxBaseCents).toBe(7_000);
  });

  it('a conversion lot dated AFTER the distribution year is not consumed (cannot exist yet)', () => {
    const r = orderRothIraDistribution({
      facts: {
        regularContributionBasisCents: 0,
        conversionLots: [
          { taxYear: 2030, taxableConvertedPrincipalCents: 5_000, nontaxableConvertedPrincipalCents: 0 },
        ],
      },
      withdrawalCents: 4_000,
      distributionTaxYear: 2024, // lot is future-dated
      ownerReached59Half: false,
    });
    expect(r.conversionTaxablePrincipalCents).toBe(0);
    expect(r.earningsCents).toBe(4_000);
  });

  it('a NaN / Infinity Roth-IRA input is REJECTED (throws), never propagated', () => {
    expect(() =>
      orderRothIraDistribution({
        facts: { regularContributionBasisCents: 0, conversionLots: [] },
        withdrawalCents: Number.NaN,
        distributionTaxYear: 2024,
        ownerReached59Half: false,
      }),
    ).toThrow(RangeError);
    expect(() =>
      orderRothIraDistribution({
        facts: { regularContributionBasisCents: Number.POSITIVE_INFINITY, conversionLots: [] },
        withdrawalCents: 1_000,
        distributionTaxYear: 2024,
        ownerReached59Half: false,
      }),
    ).toThrow(RangeError);
    expect(() =>
      orderRothIraDistribution({
        facts: {
          regularContributionBasisCents: 0,
          conversionLots: [
            { taxYear: 2020, taxableConvertedPrincipalCents: Number.NaN, nontaxableConvertedPrincipalCents: 0 },
          ],
        },
        withdrawalCents: 1_000,
        distributionTaxYear: 2024,
        ownerReached59Half: false,
      }),
    ).toThrow(RangeError);
  });

  it('a same-year multi-lot aggregate that overflows safe-integer precision is REJECTED (never understates tax)', () => {
    // 200 same-year lots near the money bound aggregate past MAX_SAFE_INTEGER; plain-number accumulation would lose precision,
    // so the BigInt re-validation must throw.
    const bigLotCents = 90_000_000_000_000; // 9e13, individually a safe integer
    const conversionLots = Array.from({ length: 200 }, () => ({
      taxYear: 2020,
      taxableConvertedPrincipalCents: bigLotCents,
      nontaxableConvertedPrincipalCents: 0,
    }));
    expect(() =>
      orderRothIraDistribution({
        facts: { regularContributionBasisCents: 0, conversionLots },
        withdrawalCents: 1_000, // reaches layer 2 (remaining > 0)
        distributionTaxYear: 2024,
        ownerReached59Half: false,
      }),
    ).toThrow(RangeError);
  });
});

describe('designated-Roth pro rata (§402A nonqualified)', () => {
  it('splits pro rata by basis / balance', () => {
    const s = splitDesignatedRothNonqualified({
      basisCents: 4_000,
      accountBalanceCents: 10_000,
      withdrawalCents: 1_000,
    });
    expect(s.basisCents).toBe(400); // 40% basis fraction
    expect(s.earningsCents).toBe(600);
  });

  it('zero balance → all earnings (conservative)', () => {
    const s = splitDesignatedRothNonqualified({
      basisCents: 4_000,
      accountBalanceCents: 0,
      withdrawalCents: 1_000,
    });
    expect(s.basisCents).toBe(0);
    expect(s.earningsCents).toBe(1_000);
  });

  it('exact integer half-cent boundary (11/15/22 → 8, not 7 from float drift)', () => {
    // 11 * 15 / 22 = 7.5 rounds half-up to 8; float division gives 7.499999999999999 → 7.
    const s = splitDesignatedRothNonqualified({
      basisCents: 15,
      accountBalanceCents: 22,
      withdrawalCents: 11,
    });
    expect(s.basisCents).toBe(8);
    expect(s.earningsCents).toBe(3);
  });

  it('a NaN / non-finite input is REJECTED (throws), never silently propagated', () => {
    expect(() =>
      splitDesignatedRothNonqualified({
        basisCents: Number.NaN,
        accountBalanceCents: 22,
        withdrawalCents: 11,
      }),
    ).toThrow(RangeError);
    expect(() =>
      splitDesignatedRothNonqualified({
        basisCents: 15,
        accountBalanceCents: Number.POSITIVE_INFINITY,
        withdrawalCents: 11,
      }),
    ).toThrow(RangeError);
  });

  it('a negative-balance input is REJECTED (throws), and basis > balance caps at the withdrawal', () => {
    expect(() =>
      splitDesignatedRothNonqualified({
        basisCents: 15,
        accountBalanceCents: -1,
        withdrawalCents: 11,
      }),
    ).toThrow(RangeError);
    // Basis (5_000) above balance (1_000): the fraction caps at 1, so all of the withdrawal is basis.
    const s = splitDesignatedRothNonqualified({
      basisCents: 5_000,
      accountBalanceCents: 1_000,
      withdrawalCents: 400,
    });
    expect(s.basisCents).toBe(400);
    expect(s.earningsCents).toBe(0);
  });

  it('a large safe-integer input keeps precision (no float rounding)', () => {
    const big = 90_000_000_000_000; // < Number.MAX_SAFE_INTEGER
    const s = splitDesignatedRothNonqualified({
      basisCents: big,
      accountBalanceCents: big,
      withdrawalCents: big,
    });
    expect(s.basisCents).toBe(big);
    expect(s.earningsCents).toBe(0);
  });

  it('qualified → tax-free, but the basis bookkeeping is STILL pro-rata (not a full basis charge)', () => {
    const r = computeDesignatedRothDistribution({
      facts: { basisCents: 4_000, firstParticipationTaxYear: 2015 },
      accountBalanceCents: 10_000,
      withdrawalCents: 1_000,
      distributionTaxYear: 2024,
      ownerReached59Half: true,
    });
    expect(r.qualified).toBe(true);
    // Pro-rata basis consumed (40% of 1_000), not the whole withdrawal.
    expect(r.basisCents).toBe(400);
    expect(r.earningsCents).toBe(600);
    expect(r.incomeTaxableCents).toBe(0);
    expect(r.additionalTaxBaseCents).toBe(0);
  });

  it('ordinary governmental-457(b) earnings are penalty-free; rollover-attributable earnings still count', () => {
    const base = {
      facts: {
        basisCents: 4_000,
        firstParticipationTaxYear: 2015,
        isGovernmental457b: true,
      },
      accountBalanceCents: 10_000,
      withdrawalCents: 1_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false, // pre-59½
    };
    const ordinary = computeDesignatedRothDistribution(base);
    expect(ordinary.earningsCents).toBe(600);
    expect(ordinary.incomeTaxableCents).toBe(600); // still ordinary income
    expect(ordinary.additionalTaxBaseCents).toBe(0); // but NOT penalized

    const rolled = computeDesignatedRothDistribution({
      ...base,
      rolloverAttributableEarningsCents: 600,
    });
    expect(rolled.additionalTaxBaseCents).toBe(600);
  });

  it('rolloverAttributableEarningsCents is validated — NaN/Infinity throw, a negative clamps to 0', () => {
    const base = {
      facts: {
        basisCents: 4_000,
        firstParticipationTaxYear: 2015,
        isGovernmental457b: true,
      },
      accountBalanceCents: 10_000,
      withdrawalCents: 1_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false, // pre-59½ → the 10% base branch runs
    };
    expect(() =>
      computeDesignatedRothDistribution({ ...base, rolloverAttributableEarningsCents: NaN }),
    ).toThrow(RangeError);
    expect(() =>
      computeDesignatedRothDistribution({ ...base, rolloverAttributableEarningsCents: Infinity }),
    ).toThrow(RangeError);
    const negative = computeDesignatedRothDistribution({
      ...base,
      rolloverAttributableEarningsCents: -500,
    });
    expect(negative.additionalTaxBaseCents).toBe(0);
  });

  it('in-window taxable in-plan rollover principal enters the 10% base; out-of-window does not', () => {
    const facts = {
      basisCents: 10_000, // all basis is in-plan rollover principal
      firstParticipationTaxYear: 2015,
      inPlanRolloverLots: [
        { taxYear: 2020, taxableRolloverPrincipalCents: 10_000, nontaxableRolloverPrincipalCents: 0 },
      ],
    };
    const inWindow = computeDesignatedRothDistribution({
      facts,
      accountBalanceCents: 10_000,
      withdrawalCents: 10_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false,
    });
    expect(inWindow.basisCents).toBe(10_000);
    expect(inWindow.earningsCents).toBe(0);
    expect(inWindow.additionalTaxBaseCents).toBe(10_000);

    const outWindow = computeDesignatedRothDistribution({
      facts,
      accountBalanceCents: 10_000,
      withdrawalCents: 10_000,
      distributionTaxYear: 2026,
      ownerReached59Half: false,
    });
    expect(outWindow.additionalTaxBaseCents).toBe(0);
  });

  it('a NaN / Infinity in-plan rollover lot principal is REJECTED (throws), never propagated', () => {
    const base = {
      facts: {
        basisCents: 10_000,
        firstParticipationTaxYear: 2015,
      },
      accountBalanceCents: 10_000,
      withdrawalCents: 10_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false, // pre-59½ → the ordered allocation / recapture runs
    };
    expect(() =>
      computeDesignatedRothDistribution({
        ...base,
        facts: {
          ...base.facts,
          inPlanRolloverLots: [
            { taxYear: 2022, taxableRolloverPrincipalCents: Number.NaN, nontaxableRolloverPrincipalCents: 0 },
          ],
        },
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeDesignatedRothDistribution({
        ...base,
        facts: {
          ...base.facts,
          inPlanRolloverLots: [
            {
              taxYear: 2022,
              taxableRolloverPrincipalCents: 4_000,
              nontaxableRolloverPrincipalCents: Number.POSITIVE_INFINITY,
            },
          ],
        },
      }),
    ).toThrow(RangeError);
  });

  it('a withdrawal fully absorbed by ordinary basis leaves the rollover lot untouched (no premature recapture)', () => {
    // 10_000 basis = 6_000 ordinary + a 4_000 taxable rollover lot: a 5_000 draw is absorbed by ordinary basis (Notice 2010-84
    // Q&A-13 ordinary-first), so nothing is recaptured.
    const r = computeDesignatedRothDistribution({
      facts: {
        basisCents: 10_000,
        firstParticipationTaxYear: 2015,
        inPlanRolloverLots: [
          { taxYear: 2022, taxableRolloverPrincipalCents: 4_000, nontaxableRolloverPrincipalCents: 0 },
        ],
      },
      accountBalanceCents: 10_000,
      withdrawalCents: 5_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false,
    });
    expect(r.basisCents).toBe(5_000);
    expect(r.earningsCents).toBe(0);
    expect(r.additionalTaxBaseCents).toBe(0); // rollover lot untouched
    expect(r.basisAllocation.ordinaryBasisConsumedCents).toBe(5_000);
    expect(r.basisAllocation.lotConsumptions[0].taxableConsumedCents).toBe(0);
  });

  it('a withdrawal that exhausts ordinary basis then draws a rollover lot recaptures only the lot portion', () => {
    // Drawing all 10_000: the 4_000 in-window lot principal is recaptured, the 6_000 ordinary basis is not.
    const r = computeDesignatedRothDistribution({
      facts: {
        basisCents: 10_000,
        firstParticipationTaxYear: 2015,
        inPlanRolloverLots: [
          { taxYear: 2022, taxableRolloverPrincipalCents: 4_000, nontaxableRolloverPrincipalCents: 0 },
        ],
      },
      accountBalanceCents: 10_000,
      withdrawalCents: 10_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false,
    });
    expect(r.basisCents).toBe(10_000);
    expect(r.additionalTaxBaseCents).toBe(4_000);
    expect(r.basisAllocation.ordinaryBasisConsumedCents).toBe(6_000);
    expect(r.basisAllocation.lotConsumptions[0].taxableConsumedCents).toBe(4_000);
  });

  it('rollover lots are drawn FIFO oldest-tax-year first; only in-window taxable principal is recaptured', () => {
    // Lots are supplied newest-first to prove the allocator sorts oldest-first: 7_000 takes the 2016 lot (5_000, window closed
    // 2024 - 2016 = 8) then 2_000 of the 2021 lot (in window, recaptured).
    const r = computeDesignatedRothDistribution({
      facts: {
        basisCents: 10_000,
        firstParticipationTaxYear: 2010,
        inPlanRolloverLots: [
          { taxYear: 2021, taxableRolloverPrincipalCents: 5_000, nontaxableRolloverPrincipalCents: 0 },
          { taxYear: 2016, taxableRolloverPrincipalCents: 5_000, nontaxableRolloverPrincipalCents: 0 },
        ],
      },
      accountBalanceCents: 10_000,
      withdrawalCents: 7_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false,
    });
    expect(r.basisCents).toBe(7_000);
    expect(r.additionalTaxBaseCents).toBe(2_000); // only the in-window 2021 portion
    expect(r.basisAllocation.lotConsumptions[1].taxableConsumedCents).toBe(5_000);
    expect(r.basisAllocation.lotConsumptions[0].taxableConsumedCents).toBe(2_000);
  });

  it('within a rollover lot the taxable principal is attributed before the nontaxable', () => {
    // 4_000 taxable is drawn first (recaptured), then 1_000 of the nontaxable.
    const r = computeDesignatedRothDistribution({
      facts: {
        basisCents: 6_000,
        firstParticipationTaxYear: 2015,
        inPlanRolloverLots: [
          { taxYear: 2022, taxableRolloverPrincipalCents: 4_000, nontaxableRolloverPrincipalCents: 2_000 },
        ],
      },
      accountBalanceCents: 6_000,
      withdrawalCents: 5_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false,
    });
    expect(r.basisCents).toBe(5_000);
    expect(r.additionalTaxBaseCents).toBe(4_000); // full taxable, none of nontaxable
    expect(r.basisAllocation.lotConsumptions[0].taxableConsumedCents).toBe(4_000);
    expect(r.basisAllocation.lotConsumptions[0].nontaxableConsumedCents).toBe(1_000);
  });

  it('computeDesignatedRothDistribution: nonqualified pre-59½ → earnings taxed + penalized', () => {
    const r = computeDesignatedRothDistribution({
      facts: { basisCents: 4_000, firstParticipationTaxYear: 2015 },
      accountBalanceCents: 10_000,
      withdrawalCents: 1_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false,
    });
    expect(r.qualified).toBe(false);
    expect(r.basisCents).toBe(400);
    expect(r.earningsCents).toBe(600);
    expect(r.incomeTaxableCents).toBe(600);
    expect(r.additionalTaxBaseCents).toBe(600);
  });
});

describe('seedFactBasedRothBasisCarrier + applyFactBasedRothIraOrdering', () => {
  it('seeds sorted conversion lots and consumes basis/lots cumulatively across withdrawals', () => {
    const carrier = seedFactBasedRothBasisCarrier(
      new Map([
        [
          'member-primary',
          {
            rothIra: {
              regularContributionBasisCents: 10_000,
              firstContributionTaxYear: 2015,
              // Supplied out of order: must sort FIFO by tax year.
              conversionLots: [
                { taxYear: 2021, taxableConvertedPrincipalCents: 3_000, nontaxableConvertedPrincipalCents: 0 },
                { taxYear: 2019, taxableConvertedPrincipalCents: 4_000, nontaxableConvertedPrincipalCents: 1_000 },
              ],
            },
          },
        ],
      ]),
    );
    const entry = carrier.get('member-primary')!;
    expect(entry.rothBasisRemainingCents).toBe(10_000);
    expect(entry.conversionLots?.map((l) => l.taxYear)).toEqual([2019, 2021]);

    // Withdrawal 1 ($120): all $100 regular basis plus $20 of the 2019 lot's taxable principal.
    const r1 = applyFactBasedRothIraOrdering(entry, {
      withdrawalCents: 12_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false,
      firstContributionTaxYear: 2015,
    });
    expect(r1.regularContributionCents).toBe(10_000);
    expect(r1.conversionTaxablePrincipalCents).toBe(2_000);
    expect(entry.rothBasisRemainingCents).toBe(0);
    expect(entry.conversionLots?.[0].taxableRemainingCents).toBe(2_000); // 4_000 − 2_000

    // Withdrawal 2 ($60): regular basis is gone, so it starts inside the 2019 lot.
    const r2 = applyFactBasedRothIraOrdering(entry, {
      withdrawalCents: 6_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false,
      firstContributionTaxYear: 2015,
    });
    expect(r2.regularContributionCents).toBe(0);
    // 2_000 taxable remaining in the 2019 lot + 1_000 nontaxable, then 3_000 into the 2021 lot.
    expect(r2.conversionTaxablePrincipalCents).toBe(2_000 + 3_000);
    expect(r2.conversionNontaxablePrincipalCents).toBe(1_000);
    // Fully depleted lots are pruned after each pass; they cannot contribute to a later year.
    expect(entry.conversionLots).toEqual([]);
  });

  it('applyFactBasedDesignatedRothDistribution consumes per-ACCOUNT designated basis pro rata', () => {
    const carrier = seedDesignatedRothCarrier(
      new Map([
        [
          'acc-roth-401k',
          {
            accountId: 'acc-roth-401k',
            ownerId: 'member-primary',
            basisCents: 4_000,
            firstParticipationTaxYear: 2015,
          },
        ],
      ]),
    );
    const entry = carrier.get('acc-roth-401k')!;
    const r = applyFactBasedDesignatedRothDistribution(entry, {
      accountBalanceCents: 10_000,
      withdrawalCents: 1_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false,
    });
    expect(r.basisCents).toBe(400);
    expect(entry.designatedRothBasisRemainingCents).toBe(3_600); // 4_000 − 400
  });

  it('two same-owner designated-Roth accounts qualify + split basis INDEPENDENTLY (no borrowed clock/basis)', () => {
    const carrier = seedDesignatedRothCarrier(
      new Map([
        [
          'acc-old',
          {
            accountId: 'acc-old',
            ownerId: 'member-primary',
            basisCents: 8_000, // 80% basis ratio vs 10_000 balance
            firstParticipationTaxYear: 2015, // clock met in 2024
          },
        ],
        [
          'acc-new',
          {
            accountId: 'acc-new',
            ownerId: 'member-primary',
            basisCents: 2_000, // 20% basis ratio
            firstParticipationTaxYear: 2022, // clock NOT met in 2024
          },
        ],
      ]),
    );

    // acc-old: 59½ + met clock → qualified, 80% basis.
    const old = applyFactBasedDesignatedRothDistribution(carrier.get('acc-old')!, {
      accountBalanceCents: 10_000,
      withdrawalCents: 1_000,
      distributionTaxYear: 2024,
      ownerReached59Half: true,
    });
    expect(old.qualified).toBe(true);
    expect(old.basisCents).toBe(800); // 80% — its OWN ratio, not acc-new's
    expect(old.incomeTaxableCents).toBe(0);

    // acc-new: unmet clock → nonqualified even at 59½, 20% basis.
    const fresh = applyFactBasedDesignatedRothDistribution(carrier.get('acc-new')!, {
      accountBalanceCents: 10_000,
      withdrawalCents: 1_000,
      distributionTaxYear: 2024,
      ownerReached59Half: true,
    });
    expect(fresh.qualified).toBe(false); // did NOT borrow acc-old's met clock
    expect(fresh.basisCents).toBe(200); // 20% — its OWN ratio
    expect(fresh.incomeTaxableCents).toBe(800); // earnings taxed

    expect(carrier.get('acc-old')!.designatedRothBasisRemainingCents).toBe(7_200);
    expect(carrier.get('acc-new')!.designatedRothBasisRemainingCents).toBe(1_800);
  });

  it('cumulative in-plan rollover recapture across partial-withdrawal years is capped at the lot original taxable principal (ordinary-first ordering)', () => {
    // 6_000 basis = 2_000 ordinary + a 4_000 in-window rollover lot, over two pre-59½ years. Ordinary basis goes first, so year 1
    // dips 1_000 into the lot and year 2 draws the remaining 3_000; without decrementing the lot, year 2 would recount 4_000.
    const carrier = seedDesignatedRothCarrier(
      new Map([
        [
          'acc-401k-rollover',
          {
            accountId: 'acc-401k-rollover',
            ownerId: 'member-primary',
            basisCents: 6_000, // 2_000 ordinary basis + 4_000 taxable rollover lot
            firstParticipationTaxYear: 2015,
            inPlanRolloverLots: [
              { taxYear: 2022, taxableRolloverPrincipalCents: 4_000, nontaxableRolloverPrincipalCents: 0 },
            ],
          },
        ],
      ]),
    );
    const entry = carrier.get('acc-401k-rollover')!;

    // Year 1 (in window 2024 - 2022 = 2 < 5): 5_000 of 10_000 balance → 3_000 basis = 2_000 ordinary + 1_000 lot.
    const y1 = applyFactBasedDesignatedRothDistribution(entry, {
      accountBalanceCents: 10_000,
      withdrawalCents: 5_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false,
    });
    // Year 2 (still in window): the remaining 3_000 basis is all lot principal.
    const y2 = applyFactBasedDesignatedRothDistribution(entry, {
      accountBalanceCents: 5_000,
      withdrawalCents: 5_000,
      distributionTaxYear: 2025,
      ownerReached59Half: false,
    });

    // additionalTaxBaseCents = earnings + recapture; subtract earnings to isolate the recapture.
    const y1Recapture = y1.additionalTaxBaseCents - y1.earningsCents;
    const y2Recapture = y2.additionalTaxBaseCents - y2.earningsCents;
    expect(y1Recapture).toBe(1_000); // ordinary-first → only 1_000 into the lot
    expect(y2Recapture).toBe(3_000); // lot's remaining taxable principal
    expect(y1Recapture + y2Recapture).toBeLessThanOrEqual(4_000);
    expect(entry.inPlanRolloverLots[0].taxableRolloverPrincipalRemainingCents).toBe(0);
  });

  it('a 1-cent ordinary/rollover tie never double-recaptures the same cent across years (cumulative cap)', () => {
    // 2-cent basis = 1 ordinary + 1 in-window rollover cent. Recapture and the lot decrement read the same ordered
    // allocation, so year 1 draws the ordinary cent and the rollover cent is recaptured exactly once in year 2.
    const carrier = seedDesignatedRothCarrier(
      new Map([
        [
          'acc-tie',
          {
            accountId: 'acc-tie',
            ownerId: 'member-primary',
            basisCents: 2, // 1 cent ordinary basis + 1 cent taxable rollover
            firstParticipationTaxYear: 2015,
            inPlanRolloverLots: [
              { taxYear: 2023, taxableRolloverPrincipalCents: 1, nontaxableRolloverPrincipalCents: 0 },
            ],
          },
        ],
      ]),
    );
    const entry = carrier.get('acc-tie')!;
    const y1 = applyFactBasedDesignatedRothDistribution(entry, {
      accountBalanceCents: 4,
      withdrawalCents: 2,
      distributionTaxYear: 2024,
      ownerReached59Half: false,
    });
    const y2 = applyFactBasedDesignatedRothDistribution(entry, {
      accountBalanceCents: 2,
      withdrawalCents: 2,
      distributionTaxYear: 2025,
      ownerReached59Half: false,
    });
    const y1Recapture = y1.additionalTaxBaseCents - y1.earningsCents;
    const y2Recapture = y2.additionalTaxBaseCents - y2.earningsCents;
    expect(y1Recapture).toBe(0); // ordinary cent drawn first — no recapture
    expect(y2Recapture).toBe(1); // rollover cent recaptured exactly once
    expect(y1Recapture + y2Recapture).toBeLessThanOrEqual(1);
    expect(entry.inPlanRolloverLots[0].taxableRolloverPrincipalRemainingCents).toBe(0);
  });

  it('multi-lot rounding boundary — combined lot decrement equals basis actually consumed (no phantom decrement)', () => {
    // Two 1-cent taxable lots, all of the basis: independent per-lot rounding would zero both lots though only 1 cent left the
    // account; the largest-remainder split decrements by a combined 1 cent.
    const carrier = seedDesignatedRothCarrier(
      new Map([
        [
          'acc-boundary',
          {
            accountId: 'acc-boundary',
            ownerId: 'member-primary',
            basisCents: 2, // both cents are in-plan rollover principal
            firstParticipationTaxYear: 2015,
            inPlanRolloverLots: [
              { taxYear: 2023, taxableRolloverPrincipalCents: 1, nontaxableRolloverPrincipalCents: 0 },
              { taxYear: 2023, taxableRolloverPrincipalCents: 1, nontaxableRolloverPrincipalCents: 0 },
            ],
          },
        ],
      ]),
    );
    const entry = carrier.get('acc-boundary')!;

    // Year 1 (in window): balance 4, withdraw 2 → pro-rata basis = 1 cent.
    applyFactBasedDesignatedRothDistribution(entry, {
      accountBalanceCents: 4,
      withdrawalCents: 2,
      distributionTaxYear: 2024,
      ownerReached59Half: false,
    });
    const remainingAfterY1 =
      entry.inPlanRolloverLots[0].taxableRolloverPrincipalRemainingCents +
      entry.inPlanRolloverLots[1].taxableRolloverPrincipalRemainingCents;
    // 2 - 1 consumed = 1, not 0 (phantom decrement).
    expect(remainingAfterY1).toBe(1);
    expect(entry.inPlanRolloverLots[0].taxableRolloverPrincipalRemainingCents).toBeGreaterThanOrEqual(0);
    expect(entry.inPlanRolloverLots[1].taxableRolloverPrincipalRemainingCents).toBeGreaterThanOrEqual(0);
    expect(entry.designatedRothBasisRemainingCents).toBe(1);

    applyFactBasedDesignatedRothDistribution(entry, {
      accountBalanceCents: 2,
      withdrawalCents: 2,
      distributionTaxYear: 2025,
      ownerReached59Half: false,
    });
    const remainingAfterY2 =
      entry.inPlanRolloverLots[0].taxableRolloverPrincipalRemainingCents +
      entry.inPlanRolloverLots[1].taxableRolloverPrincipalRemainingCents;
    expect(remainingAfterY2).toBe(0);
  });
});

describe('applyFactBasedRothIraOrdering — tax-bucket + boundary coverage', () => {
  function seedOne(facts: {
    regularContributionBasisCents: number;
    conversionLots: {
      taxYear: number;
      taxableConvertedPrincipalCents: number;
      nontaxableConvertedPrincipalCents: number;
    }[];
  }) {
    return seedFactBasedRothBasisCarrier(
      new Map([['member-primary', { rothIra: { ...facts } }]]),
    ).get('member-primary')!;
  }

  it('the EXACT five-year recapture boundary (== 5 years) does NOT recapture', () => {
    const entry = seedOne({
      regularContributionBasisCents: 0,
      conversionLots: [
        { taxYear: 2019, taxableConvertedPrincipalCents: 5_000, nontaxableConvertedPrincipalCents: 0 },
      ],
    });
    const r = applyFactBasedRothIraOrdering(entry, {
      withdrawalCents: 5_000,
      distributionTaxYear: 2024, // 2024 − 2019 = 5 → rule is strictly "< 5" recaptures
      ownerReached59Half: false,
      firstContributionTaxYear: undefined,
    });
    expect(r.conversionTaxablePrincipalCents).toBe(5_000);
    expect(r.additionalTaxBaseCents).toBe(0); // == 5 years → no recapture
  });

  it('pre-59½ in-window recapture case reports the full tax-output buckets', () => {
    const entry = seedOne({
      regularContributionBasisCents: 10_000,
      conversionLots: [
        { taxYear: 2021, taxableConvertedPrincipalCents: 5_000, nontaxableConvertedPrincipalCents: 2_000 },
      ],
    });
    const r = applyFactBasedRothIraOrdering(entry, {
      withdrawalCents: 20_000, // $100 regular + $50 taxable + $20 nontaxable + $30 earnings
      distributionTaxYear: 2024, // 2024 − 2021 = 3 < 5 → recapture
      ownerReached59Half: false,
      firstContributionTaxYear: 2015,
    });
    expect(r.qualified).toBe(false);
    expect(r.regularContributionCents).toBe(10_000);
    expect(r.earningsCents).toBe(3_000);
    expect(r.incomeTaxableCents).toBe(3_000); // earnings only
    expect(r.additionalTaxBaseCents).toBe(5_000 + 3_000); // recapture + earnings
  });

  it('a zero / negative withdrawal is a no-op (all buckets zero, basis untouched)', () => {
    const entry = seedOne({
      regularContributionBasisCents: 10_000,
      conversionLots: [],
    });
    for (const withdrawalCents of [0, -500]) {
      const r = applyFactBasedRothIraOrdering(entry, {
        withdrawalCents,
        distributionTaxYear: 2024,
        ownerReached59Half: false,
        firstContributionTaxYear: 2015,
      });
      expect(r.earningsCents).toBe(0);
      expect(r.incomeTaxableCents).toBe(0);
      expect(r.additionalTaxBaseCents).toBe(0);
    }
    expect(entry.rothBasisRemainingCents).toBe(10_000); // untouched
  });

  it('a withdrawal fully absorbed by regular contributions has zero earnings', () => {
    const entry = seedOne({
      regularContributionBasisCents: 10_000,
      conversionLots: [],
    });
    const r = applyFactBasedRothIraOrdering(entry, {
      withdrawalCents: 6_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false,
      firstContributionTaxYear: 2015,
    });
    expect(r.regularContributionCents).toBe(6_000);
    expect(r.earningsCents).toBe(0);
    expect(r.additionalTaxBaseCents).toBe(0);
  });

  it('the mutable carrier REJECTS a NaN / Infinity withdrawal (same strict check as the pure engine)', () => {
    const entry = seedOne({ regularContributionBasisCents: 10_000, conversionLots: [] });
    expect(() =>
      applyFactBasedRothIraOrdering(entry, {
        withdrawalCents: Number.NaN,
        distributionTaxYear: 2024,
        ownerReached59Half: false,
        firstContributionTaxYear: 2015,
      }),
    ).toThrow(RangeError);
    expect(() =>
      applyFactBasedRothIraOrdering(entry, {
        withdrawalCents: Number.POSITIVE_INFINITY,
        distributionTaxYear: 2024,
        ownerReached59Half: false,
        firstContributionTaxYear: 2015,
      }),
    ).toThrow(RangeError);
    // A rejected call never mutated the carrier's remaining basis.
    expect(entry.rothBasisRemainingCents).toBe(10_000);
  });
});

describe('roth-IRA ordering parity — pure engine vs mutable carrier', () => {
  const scenarios = [
    {
      label: 'straightforward withdrawal',
      conversionLots: [
        { taxYear: 2020, taxableConvertedPrincipalCents: 5_000, nontaxableConvertedPrincipalCents: 2_000 },
      ],
      withdrawalCents: 12_000,
      distributionTaxYear: 2028,
      ownerReached59Half: false,
    },
    {
      label: 'same-year multi-lot (exercises the aggregation)',
      conversionLots: [
        { taxYear: 2020, taxableConvertedPrincipalCents: 3_000, nontaxableConvertedPrincipalCents: 1_000 },
        { taxYear: 2020, taxableConvertedPrincipalCents: 4_000, nontaxableConvertedPrincipalCents: 2_000 },
      ],
      withdrawalCents: 9_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false,
    },
    {
      label: 'recapture-window case',
      conversionLots: [
        { taxYear: 2022, taxableConvertedPrincipalCents: 6_000, nontaxableConvertedPrincipalCents: 0 },
      ],
      withdrawalCents: 8_000,
      distributionTaxYear: 2024,
      ownerReached59Half: false,
    },
  ];
  const regularContributionBasisCents = 2_000;
  const firstContributionTaxYear = 2015;

  it.each(scenarios)('pure and carrier agree on all tax buckets: $label', (s) => {
    const pure = orderRothIraDistribution({
      facts: { regularContributionBasisCents, firstContributionTaxYear, conversionLots: s.conversionLots },
      withdrawalCents: s.withdrawalCents,
      distributionTaxYear: s.distributionTaxYear,
      ownerReached59Half: s.ownerReached59Half,
    });
    const entry = seedFactBasedRothBasisCarrier(
      new Map([
        ['member-primary', { rothIra: { regularContributionBasisCents, firstContributionTaxYear, conversionLots: s.conversionLots } }],
      ]),
    ).get('member-primary')!;
    const carrier = applyFactBasedRothIraOrdering(entry, {
      withdrawalCents: s.withdrawalCents,
      distributionTaxYear: s.distributionTaxYear,
      ownerReached59Half: s.ownerReached59Half,
      firstContributionTaxYear,
    });
    expect(carrier.qualified).toBe(pure.qualified);
    expect(carrier.regularContributionCents).toBe(pure.regularContributionCents);
    expect(carrier.conversionTaxablePrincipalCents).toBe(pure.conversionTaxablePrincipalCents);
    expect(carrier.conversionNontaxablePrincipalCents).toBe(pure.conversionNontaxablePrincipalCents);
    expect(carrier.earningsCents).toBe(pure.earningsCents);
    expect(carrier.incomeTaxableCents).toBe(pure.incomeTaxableCents);
    expect(carrier.additionalTaxBaseCents).toBe(pure.additionalTaxBaseCents);
  });
});

describe('buildRothDistributionFacts — the fact adapter both engines read', () => {
  it('aggregates an owner\'s OWN Roth IRAs into one pool: derived basis, earliest first year, concatenated FIFO lots', () => {
    const accounts = [
      {
        id: 'acc-ira-1',
        payload: rothAccountPayload({
          // Stored but deliberately disagreeing with the recorded history below; nothing reads it.
          rothIraRegularContributionBasis: 20_000,
          rothIraFirstContributionTaxYear: 2016,
        }),
      },
      {
        id: 'acc-ira-2',
        payload: rothAccountPayload({
          rothIraRegularContributionBasis: 10_000,
          rothIraFirstContributionTaxYear: 2014, // earlier → wins
        }),
      },
      {
        id: 'acc-roth-401k',
        payload: rothAccountPayload({
          type: 'RETIREMENT_ROTH_401K',
          designatedRothBasis: 99_000, // likewise stored and ignored
          designatedRothFirstParticipationTaxYear: 2012,
        }),
      },
    ];

    const balances = [
      contributionRow('acc-ira-1', 2016, 20_000),
      contributionRow('acc-ira-2', 2014, 25_000),
      conversionRow('acc-ira-1', 2021, 3_000),
      conversionRow('acc-ira-2', 2019, 5_000, 1_000),
      rolloverRow('acc-roth-401k', 2012, 8_000),
    ];

    const { rothIraByPool, designatedByAccount } = buildRothDistributionFacts(
      accounts,
      balances,
    );
    const facts = rothIraByPool.get('member-primary')!;
    // $20k + $25k of recorded contributions, not the $30k the stored fields claim.
    expect(facts.rothIra?.regularContributionBasisCents).toBe(4_500_000);
    expect(facts.rothIra?.firstContributionTaxYear).toBe(2014);
    expect(facts.rothIra?.conversionLots.map((l) => l.taxYear)).toEqual([2019, 2021]);
    expect(facts.rothIra?.conversionLots[0].taxableConvertedPrincipalCents).toBe(500_000);
    expect(facts.rothIra?.conversionLots[0].nontaxableConvertedPrincipalCents).toBe(100_000);
    const designated = designatedByAccount.get('acc-roth-401k')!;
    expect(designated.ownerId).toBe('member-primary');
    expect(designated.basisCents).toBe(800_000); // the $8k rollover, not the $99k field
    expect(designated.firstParticipationTaxYear).toBe(2012);
  });

  it('pooling is POOL-LEVEL — a sibling’s withdrawal consumes the pool’s basis', () => {
    // $50k contributed on one Roth IRA and $50k withdrawn from another (same owner): the §408A pool is one taxpayer-level
    // whole, so $0 remains; per-account-then-sum with a floor would leave $50k.
    const accounts = [
      { id: 'acc-a', payload: rothAccountPayload({}) },
      { id: 'acc-b', payload: rothAccountPayload({}) },
    ];
    const { rothIraByPool } = buildRothDistributionFacts(accounts, [
      contributionRow('acc-a', 2020, 50_000, { startingBalance: 0, endingBalance: 50_000 }),
      contributionRow('acc-b', 2020, 0, {
        startingBalance: 0,
        rollover: 50_000,
        endingBalance: 50_000,
      }),
      contributionRow('acc-b', 2021, 0, {
        startingBalance: 50_000,
        distributions: 50_000,
        endingBalance: 0,
      }),
    ]);
    expect(
      rothIraByPool.get('member-primary')!.rothIra?.regularContributionBasisCents,
    ).toBe(0);
  });

  it('consumption is CHRONOLOGICAL — an early withdrawal cannot eat later contributions', () => {
    // $10k a year 2000-2010 on one account and a $100k rollover-funded withdrawal in 2001 on a sibling: walking the years leaves
    // $90k (only $20k of basis existed in 2001); subtracting over the whole history would leave $10k.
    const rows = [];
    let balance = 0;
    for (let year = 2000; year <= 2010; year += 1) {
      rows.push(
        contributionRow('acc-c', year, 10_000, {
          startingBalance: balance,
          endingBalance: balance + 10_000,
        }),
      );
      balance += 10_000;
    }
    const { rothIraByPool } = buildRothDistributionFacts(
      [
        { id: 'acc-c', payload: rothAccountPayload({}) },
        { id: 'acc-r', payload: rothAccountPayload({}) },
      ],
      [
        ...rows,
        contributionRow('acc-r', 2000, 0, {
          startingBalance: 0,
          rollover: 500_000,
          endingBalance: 500_000,
        }),
        contributionRow('acc-r', 2001, 0, {
          startingBalance: 500_000,
          distributions: 100_000,
          endingBalance: 400_000,
        }),
      ],
    );
    expect(
      rothIraByPool.get('member-primary')!.rothIra?.regularContributionBasisCents,
    ).toBe(90_000_00);
  });

  it('the pool’s REMAINING conversion lot keeps its tax year and its taxable/nontaxable split', () => {
    // A $200k 2015 conversion then a $100k 2020 withdrawal: half the lot remains, still dated 2015, which keys the §72(t)
    // recapture clock.
    const { rothIraByPool } = buildRothDistributionFacts(
      [{ id: 'acc-ira', payload: rothAccountPayload({}) }],
      [
        contributionRow('acc-ira', 2015, 0, {
          startingBalance: 0,
          rollover: 200_000,
          endingBalance: 200_000,
          rothConversionTaxableAmount: 150_000,
          rothConversionNontaxableAmount: 50_000,
        }),
        contributionRow('acc-ira', 2020, 0, {
          startingBalance: 200_000,
          distributions: 100_000,
          endingBalance: 100_000,
        }),
      ],
    );
    const ira = rothIraByPool.get('member-primary')!.rothIra!;
    expect(ira.regularContributionBasisCents).toBe(0);
    // Taxable converted principal goes before nontaxable within a year (§408A(d)(4)(B)): $100k of draw leaves $50k of each.
    expect(ira.conversionLots).toEqual([
      {
        taxYear: 2015,
        taxableConvertedPrincipalCents: 50_000_00,
        nontaxableConvertedPrincipalCents: 50_000_00,
      },
    ]);
  });

  it('a stored rothIraRegularContributionBasis alone resolves NOTHING', () => {
    // With no recorded history behind the stored field, the pool has $0 basis.
    const accounts = [
      {
        id: 'acc-ira',
        payload: rothAccountPayload({ rothIraRegularContributionBasis: 47_500 }),
      },
    ];
    const { rothIraByPool } = buildRothDistributionFacts(accounts, []);
    expect(
      rothIraByPool.get('member-primary')!.rothIra?.regularContributionBasisCents,
    ).toBe(0);
  });

  it('an INACTIVE Roth IRA’s contribution history enters the pool with no status gate', () => {
    // Its money followed a consolidation rollover into the sibling, so its recorded contributions are still the taxpayer's basis.
    const accounts = [
      { id: 'acc-open', payload: rothAccountPayload({}) },
      { id: 'acc-closed', payload: rothAccountPayload({ active: false }) },
    ];
    const { rothIraByPool } = buildRothDistributionFacts(accounts, [
      contributionRow('acc-open', 2019, 6_000, { startingBalance: 0, endingBalance: 6_000 }),
      contributionRow('acc-closed', 2010, 30_000, { startingBalance: 0, endingBalance: 30_000 }),
      // A positive start zeroed out by an outbound rollover that fully explains the drop imputes no withdrawal.
      contributionRow('acc-closed', 2019, 0, {
        startingBalance: 30_000,
        rollover: -30_000,
        endingBalance: 0,
      }),
    ]);
    expect(
      rothIraByPool.get('member-primary')!.rothIra?.regularContributionBasisCents,
    ).toBe(36_000_00);
  });

  it('an INACTIVE Roth IRA’s year never enters the pool’s five-year anchor', () => {
    // Qualification is not part of the basis derivation, so the clock stays active-only: an owner whose only seasoned Roth IRA
    // is closed has an unmet pooled clock.
    const closedOnly = buildRothDistributionFacts(
      [
        {
          id: 'acc-closed',
          payload: rothAccountPayload({
            active: false,
            rothIraFirstContributionTaxYear: 2005,
          }),
        },
      ],
      [contributionRow('acc-closed', 2005, 30_000, { startingBalance: 0, endingBalance: 30_000 })],
    );
    const pool = closedOnly.rothIraByPool.get('member-primary')!.rothIra!;
    expect(pool.firstContributionTaxYear).toBeUndefined();
    expect(pool.regularContributionBasisCents).toBe(30_000_00);
  });

  it('a closed Roth IRA whose history resolves to NOTHING is an ABSENT pool, not a $0 one', () => {
    // A closed Roth IRA that resolves $0 basis, no lots and no clock must not emit a pool: buildMcRothOrderedProfile walks
    // every emitted pool, so it would blank the household's pooled five-year clock and drag its owner into the 59½ set
    // (§408A(d)(2)(B): a closed account can only make the clock earlier, never absent).
    const emptied = buildRothDistributionFacts(
      [
        {
          id: 'acc-emptied',
          payload: rothAccountPayload({
            active: false,
            rothIraFirstContributionTaxYear: 2005,
          }),
        },
      ],
      [
        contributionRow('acc-emptied', 2005, 30_000, {
          startingBalance: 0,
          endingBalance: 30_000,
        }),
        contributionRow('acc-emptied', 2019, 0, {
          startingBalance: 30_000,
          distributions: 30_000,
          endingBalance: 0,
        }),
      ],
    );
    expect(emptied.rothIraByPool.size).toBe(0);
  });

  it('degenerate inputs invent nothing and never throw', () => {
    expect(
      buildRothDistributionFacts(
        [{ id: 'acc-brk', payload: rothAccountPayload({ type: 'BROKERAGE', taxTreatment: 'POST_TAX' }) }],
        [contributionRow('acc-brk', 2020, 9_000)],
      ).rothIraByPool.size,
    ).toBe(0);
    // Rows with no positive-starting balance are never compared, so no withdrawal is imputed.
    const noPositiveStart = buildRothDistributionFacts(
      [{ id: 'acc-ira', payload: rothAccountPayload({}) }],
      [
        contributionRow('acc-ira', 2020, 5_000, { startingBalance: 0, endingBalance: 100_000 }),
        contributionRow('acc-ira', 2021, 0, { startingBalance: 0, endingBalance: 60_000 }),
        contributionRow('acc-ira', 2022, 0, { startingBalance: 0, endingBalance: 60_000 }),
      ],
    );
    expect(
      noPositiveStart.rothIraByPool.get('member-primary')!.rothIra?.regularContributionBasisCents,
    ).toBe(5_000_00);
  });

  it('a MIXED account\'s Roth-designated subaccount builds designated facts', () => {
    const accounts = [
      {
        id: 'acc-mixed-401k',
        payload: rothAccountPayload({
          type: 'RETIREMENT_401K',
          taxTreatment: 'MIXED',
          designatedRothBasis: 5_000,
          designatedRothFirstParticipationTaxYear: 2018,
        }),
      },
    ];
    const { designatedByAccount } = buildRothDistributionFacts(accounts, [
      rolloverRow('acc-mixed-401k', 2018, 5_000),
    ]);
    const designated = designatedByAccount.get('acc-mixed-401k')!;
    expect(designated.basisCents).toBe(500_000);
    expect(designated.firstParticipationTaxYear).toBe(2018);
  });

  it('two same-owner designated-Roth accounts + a MIXED account keep independent per-account state (never owner-pooled)', () => {
    // A same-owner MIXED account's designated basis must be included in the account-keyed designatedByAccount, not pooled.
    const accounts = [
      {
        id: 'acc-401k',
        payload: rothAccountPayload({
          type: 'RETIREMENT_ROTH_401K',
          designatedRothBasis: 8_000,
          designatedRothFirstParticipationTaxYear: 2012,
        }),
      },
      {
        id: 'acc-403b',
        payload: rothAccountPayload({
          type: 'RETIREMENT_ROTH_403B',
          designatedRothBasis: 3_000,
          designatedRothFirstParticipationTaxYear: 2020,
        }),
      },
      {
        id: 'acc-mixed-457b',
        payload: rothAccountPayload({
          type: 'RETIREMENT_457B',
          taxTreatment: 'MIXED',
          designatedRothBasis: 5_000,
          designatedRothFirstParticipationTaxYear: 2016,
        }),
      },
    ];
    const { designatedByAccount } = buildRothDistributionFacts(accounts, [
      rolloverRow('acc-401k', 2012, 8_000),
      rolloverRow('acc-403b', 2020, 3_000),
      rolloverRow('acc-mixed-457b', 2016, 5_000),
    ]);
    expect(designatedByAccount.size).toBe(3);
    expect(designatedByAccount.get('acc-401k')!.basisCents).toBe(800_000);
    expect(designatedByAccount.get('acc-401k')!.firstParticipationTaxYear).toBe(2012);
    expect(designatedByAccount.get('acc-403b')!.basisCents).toBe(300_000);
    expect(designatedByAccount.get('acc-403b')!.firstParticipationTaxYear).toBe(2020);
    expect(designatedByAccount.get('acc-mixed-457b')!.basisCents).toBe(500_000);
    expect(designatedByAccount.get('acc-mixed-457b')!.firstParticipationTaxYear).toBe(2016);
    for (const id of ['acc-401k', 'acc-403b', 'acc-mixed-457b']) {
      expect(designatedByAccount.get(id)!.ownerId).toBe('member-primary');
    }
  });

  it('a governmental Roth 457(b) account is flagged, a Roth 401(k) is not', () => {
    const accounts = [
      {
        id: 'acc-457b',
        payload: rothAccountPayload({ type: 'RETIREMENT_ROTH_457B', designatedRothBasis: 1_000 }),
      },
      {
        id: 'acc-401k',
        payload: rothAccountPayload({ type: 'RETIREMENT_ROTH_401K', designatedRothBasis: 1_000 }),
      },
    ];
    const { designatedByAccount } = buildRothDistributionFacts(accounts, []);
    expect(designatedByAccount.get('acc-457b')!.isGovernmental457b).toBe(true);
    expect(designatedByAccount.get('acc-401k')!.isGovernmental457b).toBe(false);
  });

  it('in-plan rollover lots map to per-account cents facts (bad tax year dropped)', () => {
    const accounts = [
      {
        id: 'acc-401k',
        payload: rothAccountPayload({
          type: 'RETIREMENT_ROTH_401K',
          designatedRothBasis: 10_000,
        }),
      },
    ];
    const { designatedByAccount } = buildRothDistributionFacts(accounts, [rolloverRow('acc-401k', 2020, 6_000, 1_000), rolloverRow('acc-401k', 1990, 5, 0)]);
    const lots = designatedByAccount.get('acc-401k')!.inPlanRolloverLots!;
    expect(lots).toEqual([
      { taxYear: 2020, taxableRolloverPrincipalCents: 600_000, nontaxableRolloverPrincipalCents: 100_000 },
    ]);
  });

  it('designated-Roth basis IS the recorded in-plan-rollover principal', () => {
    // Every in-plan rollover dollar (taxable or nontaxable) is basis: $6k + $1k = $7k.
    const accounts = [
      { id: 'acc-401k', payload: rothAccountPayload({ type: 'RETIREMENT_ROTH_401K' }) },
    ];
    const { designatedByAccount } = buildRothDistributionFacts(accounts, [rolloverRow('acc-401k', 2020, 6_000, 1_000)]);
    expect(designatedByAccount.get('acc-401k')!.basisCents).toBe(700_000);
  });

  it('a stored designatedRothBasis is ignored, whether it is smaller or larger', () => {
    // The stored aggregate is ignored: $2k and $12k both resolve to the same $7k of rollover principal.
    const withStoredBasis = (designatedRothBasis: number): number =>
      buildRothDistributionFacts(
        [
          {
            id: 'acc-401k',
            payload: rothAccountPayload({ type: 'RETIREMENT_ROTH_401K', designatedRothBasis }),
          },
        ],
        [rolloverRow('acc-401k', 2020, 6_000, 1_000)],
      ).designatedByAccount.get('acc-401k')!.basisCents;
    expect(withStoredBasis(2_000)).toBe(700_000);
    expect(withStoredBasis(12_000)).toBe(700_000);
  });

  it('an employer plan with no recorded in-plan rollover resolves $0 basis', () => {
    // With no rollover recorded the whole nonqualified distribution is earnings (the more-tax direction).
    const accounts = [
      {
        id: 'acc-401k',
        payload: rothAccountPayload({
          type: 'RETIREMENT_ROTH_401K',
          designatedRothBasis: 12_000,
        }),
      },
    ];
    const facts = buildRothDistributionFacts(accounts, []).designatedByAccount.get('acc-401k')!;
    expect(facts.basisCents).toBe(0);
    const result = computeDesignatedRothDistribution({
      facts,
      accountBalanceCents: 600_000,
      withdrawalCents: 600_000,
      distributionTaxYear: 2030,
      ownerReached59Half: true,
    });
    expect(result.basisCents).toBe(0);
    expect(result.earningsCents).toBe(600_000);
  });

  it('a CLOSED employer Roth plan resolves nothing at all', () => {
    // The designated branch stays active-only: an inactive plan has no balance behind its recorded facts.
    const accounts = [
      {
        id: 'acc-401k',
        payload: rothAccountPayload({
          type: 'RETIREMENT_ROTH_401K',
          designatedRothBasis: 12_000,
          active: false,
        }),
      },
    ];
    const { designatedByAccount } = buildRothDistributionFacts(accounts, [
      rolloverRow('acc-401k', 2020, 6_000, 1_000),
    ]);
    expect(designatedByAccount.has('acc-401k')).toBe(false);
  });

  it('ordinary (non-lot) designated basis is always 0, so an in-window pre-59½ draw is recaptured', () => {
    // Basis equals lot principal by construction, so every basis dollar drawn is lot principal with its own recapture clock; a
    // stored $50k figure must not create ordinary basis that is consumed first.
    const accounts = [
      {
        id: 'acc-401k',
        payload: rothAccountPayload({
          type: 'RETIREMENT_ROTH_401K',
          designatedRothBasis: 50_000,
        }),
      },
    ];
    const facts = buildRothDistributionFacts(accounts, [
      rolloverRow('acc-401k', 2024, 6_000, 0),
    ]).designatedByAccount.get('acc-401k')!;
    const result = computeDesignatedRothDistribution({
      facts,
      accountBalanceCents: 600_000,
      withdrawalCents: 600_000,
      distributionTaxYear: 2025,
      ownerReached59Half: false,
    });
    expect(result.basisAllocation.ordinaryBasisConsumedCents).toBe(0);
    expect(result.additionalTaxBaseCents).toBe(600_000);
  });

  it('pre-59½ 457(b) rollover recapture is recognized even with an absent designatedRothBasis', () => {
    // End-to-end: facts from lots only (no aggregate basis), then a pre-59½ governmental-457(b) draw; the rollover principal
    // must land in the 10% base, not be dropped as all-earnings.
    const accounts = [
      {
        id: 'acc-457b',
        payload: rothAccountPayload({
          type: 'RETIREMENT_ROTH_457B',
        }),
      },
    ];
    const facts = buildRothDistributionFacts(accounts, [rolloverRow('acc-457b', 2024, 6_000, 0)]).designatedByAccount.get('acc-457b')!;
    const result = computeDesignatedRothDistribution({
      facts,
      accountBalanceCents: 600_000,
      withdrawalCents: 600_000,
      distributionTaxYear: 2025,
      ownerReached59Half: false,
    });
    expect(facts.basisCents).toBe(600_000);
    expect(result.basisCents).toBe(600_000);
    expect(result.earningsCents).toBe(0);
    expect(result.additionalTaxBaseCents).toBe(600_000);
  });

  it('a designated-Roth basis FLOOR that would overflow saturates high (not 0), so known 457(b) rollover recapture is not dropped', () => {
    // Two maximum-magnitude taxable rollover lots with no aggregate designatedRothBasis overflow safe-integer cents; the basis
    // floor must saturate high, not collapse to 0 and drop the recapture base.
    const maxMoney = Math.floor(Number.MAX_SAFE_INTEGER / 100);
    const accounts = [
      {
        id: 'acc-457b',
        payload: rothAccountPayload({
          type: 'RETIREMENT_ROTH_457B',
        }),
      },
    ];
    // Distinct years, both in the 2025 window: rows sharing a year resolve to one row and would never saturate the floor.
    const facts = buildRothDistributionFacts(accounts, [
      rolloverRow('acc-457b', 2023, maxMoney, 0),
      rolloverRow('acc-457b', 2024, maxMoney, 0),
    ]).designatedByAccount.get('acc-457b')!;
    expect(facts.basisCents).toBe(Number.MAX_SAFE_INTEGER);
    const result = computeDesignatedRothDistribution({
      facts,
      accountBalanceCents: 600_000,
      withdrawalCents: 600_000,
      distributionTaxYear: 2025,
      ownerReached59Half: false,
    });
    expect(result.basisCents).toBe(600_000); // treated as basis, not earnings
    expect(result.earningsCents).toBe(0);
    expect(result.additionalTaxBaseCents).toBe(600_000); // recaptured, not dropped
  });

  it('missing facts are conservative: absent basis → 0 cents, absent year → undefined', () => {
    const accounts = [{ id: 'acc-ira', payload: rothAccountPayload({}) }];
    const { rothIraByPool } = buildRothDistributionFacts(accounts, []);
    const facts = rothIraByPool.get('member-primary')!;
    expect(facts.rothIra?.regularContributionBasisCents).toBe(0);
    expect(facts.rothIra?.firstContributionTaxYear).toBeUndefined();
    expect(facts.rothIra?.conversionLots).toEqual([]);
  });

  it('infers an absent Roth IRA clock from the earliest positive balance row', () => {
    const accounts = [{ id: 'acc-ira', payload: rothAccountPayload({}) }];
    const balances = [
      { payload: { accountId: 'acc-ira', year: 2017, endingBalance: 1 } as AccountBalancePayload },
      { payload: { accountId: 'acc-ira', year: 2014, endingBalance: 1 } as AccountBalancePayload },
    ];
    const facts = buildRothDistributionFacts(accounts, balances).rothIraByPool.get(
      'member-primary',
    )!;
    expect(facts.rothIra?.firstContributionTaxYear).toBe(2014);
  });

  it('infers a MIXED plan clock only from its Roth/post-tax slice', () => {
    const accounts = [{
      id: 'acc-mixed',
      payload: rothAccountPayload({ type: 'RETIREMENT_401K', taxTreatment: 'MIXED' }),
    }];
    const balances = [
      { payload: { accountId: 'acc-mixed', year: 2013, endingBalance: 10, endingBalancePreTax: 10 } as AccountBalancePayload },
      { payload: { accountId: 'acc-mixed', year: 2018, endingBalancePostTax: 1 } as AccountBalancePayload },
    ];
    expect(
      buildRothDistributionFacts(accounts, balances).designatedByAccount.get('acc-mixed')
        ?.firstParticipationTaxYear,
    ).toBe(2018);
  });

  it('a balance row with neither conversion amount contributes NO lot', () => {
    // Absent is a weaker claim than a stored $0: filling in balances for a year must not start a §408A five-year clock.
    const accounts = [{ id: 'acc-ira', payload: rothAccountPayload({}) }];
    const balances = [
      { payload: { accountId: 'acc-ira', year: 2020, lastUpdated: '2020-12-31' } as AccountBalancePayload },
    ];
    const { rothIraByPool } = buildRothDistributionFacts(accounts, balances);
    expect(rothIraByPool.get('member-primary')!.rothIra?.conversionLots).toEqual([]);
  });

  it('a $0 conversion recorded on ONE side still produces a lot (recorded ≠ absent)', () => {
    const accounts = [{ id: 'acc-ira', payload: rothAccountPayload({}) }];
    const { rothIraByPool } = buildRothDistributionFacts(accounts, [
      conversionRow('acc-ira', 2020, 0, 4_000),
    ]);
    const lots = rothIraByPool.get('member-primary')!.rothIra!.conversionLots;
    expect(lots).toHaveLength(1);
    expect(lots[0].taxableConvertedPrincipalCents).toBe(0);
    expect(lots[0].nontaxableConvertedPrincipalCents).toBe(400_000);
  });

  it('balance rows for OTHER accounts never leak into this account’s pool', () => {
    const accounts = [{ id: 'acc-ira', payload: rothAccountPayload({}) }];
    const { rothIraByPool } = buildRothDistributionFacts(accounts, [
      conversionRow('acc-ira', 2020, 1_000),
      // A row for an account the adapter was not handed (inactive, or another owner's) must not reach this pool.
      conversionRow('acc-other', 2021, 9_999),
    ]);
    const lots = rothIraByPool.get('member-primary')!.rothIra!.conversionLots;
    expect(lots.map((l) => l.taxYear)).toEqual([2020]);
  });

  it('an out-of-range year drops the row wholesale (the year IS the clock key)', () => {
    const accounts = [{ id: 'acc-ira', payload: rothAccountPayload({}) }];
    const { rothIraByPool } = buildRothDistributionFacts(accounts, [
      conversionRow('acc-ira', 1990, 5_000), // before the supported [1998, 2200]
      conversionRow('acc-ira', 2020, 1_000),
    ]);
    const lots = rothIraByPool.get('member-primary')!.rothIra!.conversionLots;
    expect(lots.map((l) => l.taxYear)).toEqual([2020]);
  });

  it('an invalid amount reads as $0 rather than throwing or inventing money', () => {
    const accounts = [{ id: 'acc-ira', payload: rothAccountPayload({}) }];
    const { rothIraByPool } = buildRothDistributionFacts(accounts, [
      conversionRow('acc-ira', 2020, Number.NaN, 2_000),
      conversionRow('acc-ira', 2021, -500, Number.POSITIVE_INFINITY),
    ]);
    const lots = rothIraByPool.get('member-primary')!.rothIra!.conversionLots;
    // 2020 survives on its valid nontaxable side; 2021 has nothing valid, so it is no lot.
    expect(lots.map((l) => l.taxYear)).toEqual([2020]);
    expect(lots[0].taxableConvertedPrincipalCents).toBe(0);
    expect(lots[0].nontaxableConvertedPrincipalCents).toBe(200_000);
  });

  it('duplicate rows for one account-year resolve to the FIRST row, never summed', () => {
    // The balances page cannot produce this pair (id is bal-<accountId>-<year>) but a tampered import can. Annual totals
    // restate a year rather than add, so summing would credit two rows of basis against the one row the seed reducers keep;
    // first-in-order matches their strict-> tie-break.
    const accounts = [{ id: 'acc-ira', payload: rothAccountPayload({}) }];
    const { rothIraByPool } = buildRothDistributionFacts(accounts, [
      conversionRow('acc-ira', 2020, 1_000, 500),
      conversionRow('acc-ira', 2020, 2_000, 250),
    ]);
    const lots = rothIraByPool.get('member-primary')!.rothIra!.conversionLots;
    expect(lots).toHaveLength(1);
    expect(lots[0].taxableConvertedPrincipalCents).toBe(100_000);
    expect(lots[0].nontaxableConvertedPrincipalCents).toBe(50_000);
  });

  it('a duplicate year whose FIRST row records no movement contributes no lot', () => {
    // The has-a-movement test runs after the (account, year) slot is claimed. Row a holds a $10,000 balance and no conversion;
    // row z restates the year with a $10,000 nontaxable conversion. Crediting z against a's balance would manufacture $10,000
    // of basis and make a taxable pre-59½ draw tax-free.
    const accounts = [{ id: 'acc-ira', payload: rothAccountPayload({}) }];
    const { rothIraByPool } = buildRothDistributionFacts(accounts, [
      { payload: { accountId: 'acc-ira', year: 2024, lastUpdated: '2024-12-31', endingBalance: 10_000 } as AccountBalancePayload },
      conversionRow('acc-ira', 2024, 0, 10_000),
    ]);
    expect(rothIraByPool.get('member-primary')?.rothIra?.conversionLots ?? []).toHaveLength(0);
  });

  it('derives designated-Roth in-plan rollover lots from the balance rows', () => {
    const accounts = [
      {
        id: 'acc-401k',
        payload: rothAccountPayload({
          type: 'RETIREMENT_ROTH_401K',
          designatedRothBasis: 3_000,
        }),
      },
    ];
    const { designatedByAccount } = buildRothDistributionFacts(accounts, [
      rolloverRow('acc-401k', 2019, 6_000, 1_000),
      rolloverRow('acc-401k', 2021, 4_000),
    ]);
    const facts = designatedByAccount.get('acc-401k')!;
    const lots = facts.inPlanRolloverLots!;
    expect(lots.map((l) => l.taxYear)).toEqual([2019, 2021]);
    expect(lots[0].taxableRolloverPrincipalCents).toBe(600_000);
    expect(lots[0].nontaxableRolloverPrincipalCents).toBe(100_000);
    // Every rollover dollar is basis, so the lots floor the recorded aggregate: $11k of lots beats the $3k stored figure.
    expect(facts.basisCents).toBe(1_100_000);
  });

  it('a duplicated rollover year cannot bury its taxable principal under ordinary basis', () => {
    // Resolving a duplicated (account, year) to one row keeps the lot at its real value: summing two valid amounts can pass
    // MAX_SAFE_INTEGER, and degrading the lot to 0 beside a stored designatedRothBasis would make the whole draw ordinary
    // basis, consumed before every lot, so tax- and penalty-free.
    const maxMoney = Math.floor(Number.MAX_SAFE_INTEGER / 100);
    const accounts = [
      {
        id: 'acc-457b',
        payload: rothAccountPayload({
          type: 'RETIREMENT_ROTH_457B',
          designatedRothBasis: 6_000,
        }),
      },
    ];
    const facts = buildRothDistributionFacts(accounts, [
      rolloverRow('acc-457b', 2024, maxMoney, 0),
      rolloverRow('acc-457b', 2024, 1, 99), // duplicate year -> first wins, never summed
    ]).designatedByAccount.get('acc-457b')!;
    expect(facts.inPlanRolloverLots).toHaveLength(1);
    expect(facts.inPlanRolloverLots![0].taxableRolloverPrincipalCents).toBe(maxMoney * 100);

    const result = computeDesignatedRothDistribution({
      facts,
      accountBalanceCents: 600_000,
      withdrawalCents: 600_000,
      distributionTaxYear: 2025,
      ownerReached59Half: false,
    });
    expect(result.earningsCents).toBe(0);
    expect(result.incomeTaxableCents).toBe(0);
    // All in-window taxable principal, so the 10% base is the full draw.
    expect(result.additionalTaxBaseCents).toBe(600_000);
    expect(result.basisAllocation.ordinaryBasisConsumedCents).toBe(0);
  });

  it('consumes ALL of a tax year’s taxable rollover principal before any nontaxable', () => {
    // The §402A(c)(4)(D) clock attaches to the tax year, so a year's transfers are one lot and its taxable principal is
    // consumed before any nontaxable ({$1, $99} then {$99, $1} must not differ).
    const accounts = [
      {
        id: 'acc-457b',
        payload: rothAccountPayload({ type: 'RETIREMENT_ROTH_457B' }),
      },
    ];
    const facts = buildRothDistributionFacts(accounts, [
      rolloverRow('acc-457b', 2024, 100, 100),
    ]).designatedByAccount.get('acc-457b')!;
    const lots = facts.inPlanRolloverLots!;
    expect(lots).toHaveLength(1);
    expect(lots[0].taxableRolloverPrincipalCents).toBe(10_000);
    expect(lots[0].nontaxableRolloverPrincipalCents).toBe(10_000);

    // A $100 in-window pre-59½ draw recaptures the full $100 of taxable principal, never the nontaxable half.
    const result = computeDesignatedRothDistribution({
      facts,
      accountBalanceCents: 20_000,
      withdrawalCents: 10_000,
      distributionTaxYear: 2025,
      ownerReached59Half: false,
    });
    expect(result.additionalTaxBaseCents).toBe(10_000);
  });

  it('a Roth IRA ignores in-plan rollover rows (wrong Code section for the type)', () => {
    const accounts = [{ id: 'acc-ira', payload: rothAccountPayload({}) }];
    const { rothIraByPool } = buildRothDistributionFacts(accounts, [
      rolloverRow('acc-ira', 2020, 50_000),
    ]);
    expect(rothIraByPool.get('member-primary')!.rothIra?.conversionLots).toEqual([]);
  });

  it('keeps EVERY valid year — no cap below the tax-year range can drop a late lot', () => {
    // The year is the key, so output is bounded by the 203 valid years; a 200-lot cap would drop the latest years, the ones
    // still in a five-year window.
    const YEARS = 203; // isValidRothTaxYear: [1998, 2200] inclusive
    const accounts = [{ id: 'acc-ira', payload: rothAccountPayload({}) }];
    const balances = Array.from({ length: YEARS }, (_, i) =>
      conversionRow('acc-ira', 1998 + i, 1_000),
    );
    const lots = buildRothDistributionFacts(accounts, balances)
      .rothIraByPool.get('member-primary')!
      .rothIra!.conversionLots;
    expect(lots).toHaveLength(YEARS);
    expect(lots[0].taxYear).toBe(1998);
    expect(lots[lots.length - 1].taxYear).toBe(2200); // the LAST year survives
  });

  it('a late designated-Roth rollover year is never dropped in favour of earlier ones', () => {
    // Many early $1 years plus one late large in-window taxable rollover: the late lot must survive or its recapture vanishes
    // into penalty-exempt 457(b) earnings.
    const accounts = [
      {
        id: 'acc-457b',
        payload: rothAccountPayload({ type: 'RETIREMENT_ROTH_457B' }),
      },
    ];
    // 200 early years, skipping 2024 so the late lot is its own year.
    const earlyYears = Array.from({ length: 201 }, (_, i) => 1998 + i)
      .filter((y) => y !== 2024)
      .slice(0, 200);
    const balances = [
      ...earlyYears.map((y) => rolloverRow('acc-457b', y, 1)),
      rolloverRow('acc-457b', 2024, 6_000),
    ];
    const facts = buildRothDistributionFacts(accounts, balances).designatedByAccount.get(
      'acc-457b',
    )!;
    const late = facts.inPlanRolloverLots!.find((l) => l.taxYear === 2024);
    expect(late?.taxableRolloverPrincipalCents).toBe(600_000);

    const result = computeDesignatedRothDistribution({
      facts,
      accountBalanceCents: 620_000,
      withdrawalCents: 620_000,
      distributionTaxYear: 2025,
      ownerReached59Half: false,
    });
    expect(result.additionalTaxBaseCents).toBeGreaterThanOrEqual(600_000);
  });

  it('a designated-Roth employer account ignores conversion rows entirely', () => {
    // Only Roth IRAs take conversion lots from balance rows; an employer plan's rollover lots are a different fact.
    const accounts = [
      {
        id: 'acc-401k',
        payload: rothAccountPayload({
          type: 'RETIREMENT_ROTH_401K',
          designatedRothBasis: 3_000,
        }),
      },
    ];
    const { designatedByAccount } = buildRothDistributionFacts(accounts, [
      conversionRow('acc-401k', 2020, 50_000),
      rolloverRow('acc-401k', 2019, 3_000),
    ]);
    expect(designatedByAccount.get('acc-401k')!.basisCents).toBe(300_000);
    expect(designatedByAccount.get('acc-401k')!.inPlanRolloverLots).toEqual([
      { taxYear: 2019, taxableRolloverPrincipalCents: 300_000, nontaxableRolloverPrincipalCents: 0 },
    ]);
  });

  it('a malformed current-schema BALANCE ROW degrades safely (no throw, no lots)', () => {
    // A hand-constructed current-schema row bypasses the balance migrations and reaches the adapter unsanitised.
    const accounts = [
      { id: 'acc-ira', payload: rothAccountPayload({ rothIraRegularContributionBasis: 5_000 }) },
    ];
    const balances = [
      // Year is a string: not a valid tax year, row dropped.
      { payload: { accountId: 'acc-ira', year: '2020', rothConversionTaxableAmount: 9_000 } },
      // Amounts are objects: read as $0.
      {
        payload: {
          accountId: 'acc-ira',
          year: 2021,
          rothConversionTaxableAmount: {},
          rothConversionNontaxableAmount: [],
        },
      },
    ] as unknown as ReadonlyArray<{ payload: AccountBalancePayload }>;

    let facts: ReturnType<typeof buildRothDistributionFacts> | undefined;
    expect(() => {
      facts = buildRothDistributionFacts(accounts, balances);
    }).not.toThrow();
    const ira = facts!.rothIraByPool.get('member-primary')!;
    expect(ira.rothIra?.regularContributionBasisCents).toBe(0);
    expect(ira.rothIra?.conversionLots).toEqual([]);
  });

  it('an aggregate that would overflow safe-integer precision degrades to a conservative 0 (never throws)', () => {
    // Two same-owner IRAs each recording the maximum contribution overflow IEEE-754 precision when summed; the BigInt
    // accumulation must degrade to $0 basis (max-tax direction), never a lossy value or a throw.
    const maxMoney = Math.floor(Number.MAX_SAFE_INTEGER / 100);
    const accounts = [
      { id: 'acc-ira-1', payload: rothAccountPayload({}) },
      { id: 'acc-ira-2', payload: rothAccountPayload({}) },
    ];
    const run = (): ReturnType<typeof buildRothDistributionFacts> =>
      buildRothDistributionFacts(accounts, [
        contributionRow('acc-ira-1', 2020, maxMoney),
        contributionRow('acc-ira-2', 2020, maxMoney),
      ]);
    expect(run).not.toThrow();
    expect(
      run().rothIraByPool.get('member-primary')!.rothIra?.regularContributionBasisCents,
    ).toBe(0);
  });

  // An inherited Roth IRA must be an absence, not a $0 pool: the carrier seeding and the ordering pass both materialise $0
  // state on demand for any pool key.
  it('emits NO pool at all for an INHERITED Roth IRA, and leaves the owner’s own pool intact', () => {
    const accounts = [
      {
        id: 'acc-own',
        payload: rothAccountPayload({
          rothIraRegularContributionBasis: 20_000,
          rothIraFirstContributionTaxYear: 2010,
        }),
      },
      {
        id: 'acc-inherited',
        payload: rothAccountPayload({
          rothIraRegularContributionBasis: 1_000,
          rothIraFirstContributionTaxYear: 2024,
          rmdInheritedAccount: true,
        }),
      },
    ];
    const { rothIraByPool } = buildRothDistributionFacts(accounts, [
      contributionRow('acc-own', 2010, 20_000),
      contributionRow('acc-inherited', 2011, 55_000),
    ]);
    expect(rothIraByPool.size).toBe(1);
    expect([...rothIraByPool.keys()]).toEqual(['member-primary']);
    expect(rothIraByPool.has('member-primary::inherited-acct:acc-inherited')).toBe(false);
    const own = rothIraByPool.get('member-primary')!;
    expect(own.rothIra?.firstContributionTaxYear).toBe(2010);
    expect(own.rothIra?.regularContributionBasisCents).toBe(2_000_000); // $20k own only
    expect(own.rothIra?.inheritedFromDeceasedOwner).toBeUndefined();
  });

  it('seedFactBasedRothBasisCarrier skips an inherited pool handed to it directly', () => {
    const carrier = seedFactBasedRothBasisCarrier(
      new Map([
        [
          'member-primary',
          { rothIra: { regularContributionBasisCents: 500_000, conversionLots: [] } },
        ],
        [
          'member-primary::inherited-acct:acc-inherited',
          {
            rothIra: {
              regularContributionBasisCents: 100_000,
              conversionLots: [],
              inheritedFromDeceasedOwner: true,
            },
          },
        ],
      ]),
    );
    expect([...carrier.keys()]).toEqual(['member-primary']);
  });
});

describe('an inherited Roth IRA passes through the deterministic ordering pass untaxed', () => {
  const setUp = (opts: {
    readonly ownFirstYear: number;
    readonly ownBasisDollars: number;
    readonly inheritedFirstYear: number;
    readonly inheritedBasisDollars: number;
    // Default 1965 is 62 in 2027 (59½ met all year); a later year runs the under-59½ shape.
    readonly primaryBirthdate?: string;
  }) => {
    const accounts = [
      {
        id: 'roth-own',
        payload: rothAccountPayload({
          rothIraRegularContributionBasis: opts.ownBasisDollars,
          rothIraFirstContributionTaxYear: opts.ownFirstYear,
        }),
      },
      {
        id: 'roth-inherited',
        payload: rothAccountPayload({
          rothIraRegularContributionBasis: opts.inheritedBasisDollars,
          rothIraFirstContributionTaxYear: opts.inheritedFirstYear,
          rmdInheritedAccount: true,
        }),
      },
    ];
    const rothDistributionFacts = buildRothDistributionFacts(accounts, [
      contributionRow('roth-own', opts.ownFirstYear, opts.ownBasisDollars),
      contributionRow('roth-inherited', opts.inheritedFirstYear, opts.inheritedBasisDollars),
    ]);
    const ctx = makeCtx({
      primaryBirthdate: opts.primaryBirthdate ?? '1965-01-01',
      accountProjections: [
        { id: 'roth-own', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
        { id: 'roth-inherited', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
      ],
      rothDistributionFacts,
      rmdProfileFactsByAccountId: new Map([['roth-inherited', { inheritedAccount: true }]]),
    });
    const carrier = seedFactBasedRothBasisCarrier(
      mergeFactBasedRothIraSeeds(rothDistributionFacts.rothIraByPool, undefined),
    );
    return { ctx, carrier };
  };

  // A zero-tax assertion alone would pass if the pass silently created and drew down a $0 inherited entry.
  it('leaves NO carrier entry after a year containing an inherited draw', () => {
    const { ctx, carrier } = setUp({
      ownFirstYear: 2010,
      ownBasisDollars: 20_000,
      inheritedFirstYear: 2024,
      inheritedBasisDollars: 0,
    });
    expect([...carrier.keys()]).toEqual(['member-primary']);
    const accountBalances = new Map([
      ['roth-own', makeAccountBalance(50_000, 0)],
      ['roth-inherited', makeAccountBalance(40_000, 10_000)],
    ]);
    const split = applyRothBasisOrdering(
      ctx,
      makeDrawdownYear(2027, 10_000, accountBalances),
      carrier,
      new Map(),
    );
    expect(split.earningsExcessDollars).toBe(0);
    expect(split.penaltyAccounts).toEqual([]);
    expect([...carrier.keys()]).toEqual(['member-primary']);
    expect(carrier.get('member-primary')?.rothBasisRemainingCents).toBe(2_000_000);
    expect(carrier.get('member-primary')?.rothCumulativeWithdrawnCents).toBe(0);
  });

  // The deterministic engine must not tax the draw as ordinary income while Monte Carlo routes it tax-free.
  it('is tax- AND penalty-free with an unmet clock and a beneficiary under 59½', () => {
    const { ctx, carrier } = setUp({
      ownFirstYear: 2010,
      ownBasisDollars: 0,
      inheritedFirstYear: 2025,
      inheritedBasisDollars: 0,
      primaryBirthdate: '1985-01-01', // age 42 in 2027
    });
    const accountBalances = new Map([
      ['roth-own', makeAccountBalance(50_000, 0)],
      ['roth-inherited', makeAccountBalance(40_000, 10_000)],
    ]);
    const split = applyRothBasisOrdering(
      ctx,
      makeDrawdownYear(2027, 10_000, accountBalances),
      carrier,
      new Map(),
    );
    expect(split.earningsExcessDollars).toBe(0);
    expect(split.penaltyAccounts).toEqual([]);
  });

  it('contributes nothing to the flattened per-owner FUNDING basis or clock', () => {
    // An inherited account supplies no pool, so it can neither add basis to the owner's funding entry nor pull its latest clock
    // forward.
    const accounts = [
      {
        id: 'roth-own',
        payload: rothAccountPayload({
          rothIraRegularContributionBasis: 20_000,
          rothIraFirstContributionTaxYear: 2010,
        }),
      },
      {
        id: 'roth-inherited',
        payload: rothAccountPayload({
          rothIraRegularContributionBasis: 5_000,
          rothIraFirstContributionTaxYear: 2024,
          rmdInheritedAccount: true,
        }),
      },
    ];
    const { rothIraByPool } = buildRothDistributionFacts(accounts, [
      contributionRow('roth-own', 2010, 20_000),
      contributionRow('roth-inherited', 2024, 5_000),
    ]);
    const flat = flattenRothIraPoolsByOwner(rothIraByPool);
    expect(flat.size).toBe(1);
    const owner = flat.get('member-primary')!;
    expect(owner.ownerId).toBe('member-primary');
    expect(owner.rothIra?.regularContributionBasisCents).toBe(2_000_000); // $20k own only
    expect(owner.rothIra?.firstContributionTaxYear).toBe(2010);
    expect(owner.rothIra?.inheritedFromDeceasedOwner).toBeUndefined();
  });

  it('still aggregates the owner’s OWN Roth IRAs with each other (Pub 590-B)', () => {
    // One person's own Roth IRAs count as a single account, so the earliest clock (2010) governs and the 2027 draw from the new
    // account is qualified.
    const accounts = [
      {
        id: 'roth-old',
        payload: rothAccountPayload({ rothIraFirstContributionTaxYear: 2010 }),
      },
      {
        id: 'roth-new',
        payload: rothAccountPayload({ rothIraFirstContributionTaxYear: 2026 }),
      },
    ];
    const rothDistributionFacts = buildRothDistributionFacts(accounts, []);
    expect(rothDistributionFacts.rothIraByPool.size).toBe(1);
    const ctx = makeCtx({
      primaryBirthdate: '1965-01-01',
      accountProjections: [
        { id: 'roth-old', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
        { id: 'roth-new', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
      ],
      rothDistributionFacts,
    });
    const carrier = seedFactBasedRothBasisCarrier(rothDistributionFacts.rothIraByPool);
    const accountBalances = new Map([
      ['roth-old', makeAccountBalance(50_000, 0)],
      ['roth-new', makeAccountBalance(40_000, 10_000)],
    ]);
    const split = applyRothBasisOrdering(
      ctx,
      makeDrawdownYear(2027, 10_000, accountBalances),
      carrier,
      new Map(),
    );
    expect(split.earningsExcessDollars).toBe(0);
  });
});

describe('inherited Roth accounts — death is the qualifying event', () => {
  it('qualifies an inherited Roth-IRA distribution on the FIVE-YEAR test alone', () => {
    // The beneficiary is 40, but the owner's death is the qualifying event (§408A(d)(2)(A)(ii)), so a five-year-seasoned
    // account qualifies.
    const facts = { firstContributionTaxYear: 2010, inheritedFromDeceasedOwner: true };
    expect(isRothIraDistributionQualified(facts, 2030, false)).toBe(true);
    expect(
      isRothIraDistributionQualified(
        { firstContributionTaxYear: 2028, inheritedFromDeceasedOwner: true },
        2030,
        false,
      ),
    ).toBe(false);
    // An owner account still needs the owner's own 59½.
    expect(isRothIraDistributionQualified({ firstContributionTaxYear: 2010 }, 2030, false)).toBe(
      false,
    );
  });

  it('charges NO additional tax on an inherited Roth-IRA draw, even inside a conversion window', () => {
    const carrier = seedFactBasedRothBasisCarrier(
      new Map([
        [
          'owner',
          {
            rothIra: {
              regularContributionBasisCents: 0,
              firstContributionTaxYear: 2029,
              conversionLots: [
                {
                  taxYear: 2028,
                  taxableConvertedPrincipalCents: 10_000_00,
                  nontaxableConvertedPrincipalCents: 0,
                },
              ],
            },
          },
        ],
      ]),
    );
    const result = applyFactBasedRothIraOrdering(carrier.get('owner')!, {
      withdrawalCents: 15_000_00,
      distributionTaxYear: 2030,
      ownerReached59Half: false,
      firstContributionTaxYear: 2029,
      inheritedFromDeceasedOwner: true,
    });
    // $10,000 converted principal + $5,000 earnings.
    expect(result.earningsCents).toBe(5_000_00);
    expect(result.incomeTaxableCents).toBe(5_000_00);
    // §72(t)(2)(A)(ii): the death exception waives the 10% base, including the in-window conversion recapture.
    expect(result.additionalTaxBaseCents).toBe(0);
  });

  it('charges NO additional tax on an inherited designated-Roth draw', () => {
    const owned = computeDesignatedRothDistribution({
      facts: { basisCents: 0, firstParticipationTaxYear: 2029 },
      accountBalanceCents: 100_000_00,
      withdrawalCents: 10_000_00,
      distributionTaxYear: 2030,
      ownerReached59Half: false,
    });
    expect(owned.additionalTaxBaseCents).toBe(10_000_00);
    const inherited = computeDesignatedRothDistribution({
      facts: {
        basisCents: 0,
        firstParticipationTaxYear: 2029,
        inheritedFromDeceasedOwner: true,
      },
      accountBalanceCents: 100_000_00,
      withdrawalCents: 10_000_00,
      distributionTaxYear: 2030,
      ownerReached59Half: false,
    });
    expect(inherited.incomeTaxableCents).toBe(10_000_00);
    expect(inherited.additionalTaxBaseCents).toBe(0);
  });
});

describe('engine-generated conversions carry a DATED lot', () => {
  it('seeds a working-years conversion as a dated conversion lot, so in-window recapture applies', () => {
    const seeds = mergeFactBasedRothIraSeeds(
      new Map(),
      new Map([['owner', 10_000_00]]),
      new Map([['owner', new Map([[2028, 10_000_00]])]]),
    );
    const lots = seeds.get('owner')?.rothIra?.conversionLots ?? [];
    expect(lots).toEqual([
      {
        taxYear: 2028,
        taxableConvertedPrincipalCents: 10_000_00,
        nontaxableConvertedPrincipalCents: 0,
      },
    ]);
    expect(seeds.get('owner')?.rothIra?.regularContributionBasisCents).toBe(0);

    const carrier = seedFactBasedRothBasisCarrier(seeds);
    const result = applyFactBasedRothIraOrdering(carrier.get('owner')!, {
      withdrawalCents: 10_000_00,
      distributionTaxYear: 2030,
      ownerReached59Half: false,
    });
    expect(result.additionalTaxBaseCents).toBe(10_000_00);
    expect(result.incomeTaxableCents).toBe(0); // converted principal is never re-taxed
  });

  it('falls back to undated regular basis when no dated map is supplied', () => {
    const seeds = mergeFactBasedRothIraSeeds(new Map(), new Map([['owner', 10_000_00]]));
    expect(seeds.get('owner')?.rothIra?.regularContributionBasisCents).toBe(10_000_00);
    expect(seeds.get('owner')?.rothIra?.conversionLots).toEqual([]);
  });

  it('seeds a same-account MIXED in-plan conversion as a dated in-plan rollover lot', () => {
    const seeds = mergeDesignatedRothSeeds(
      new Map([
        [
          'plan-1',
          {
            accountId: 'plan-1',
            ownerId: 'owner',
            basisCents: 0,
            inPlanRolloverLots: [],
            isGovernmental457b: false,
          },
        ],
      ]),
      new Map([['plan-1', 5_000_00]]),
      new Map([['plan-1', new Map([[2029, 5_000_00]])]]),
    );
    const entry = seeds.get('plan-1')!;
    expect(entry.basisCents).toBe(5_000_00);
    expect(entry.inPlanRolloverLots).toEqual([
      { taxYear: 2029, taxableRolloverPrincipalCents: 5_000_00, nontaxableRolloverPrincipalCents: 0 },
    ]);
  });
});

describe('recorded conversion recapture — public projection funding', () => {
  const aggregate = <T extends Record<string, unknown>>(
    id: string,
    aggregateType: Aggregate<T>['aggregateType'],
    payload: T,
  ): Aggregate<T> => ({
    id,
    householdId: 'household',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2021-01-01T00:00:00Z',
    deviceId: 'device',
    aggregateType,
    payload,
  });

  const projectAt = (retirementYear: 2024 | 2025) => {
    const retirementAge = retirementYear - 1985;
    const member = aggregate<HouseholdMemberPayload>('member-primary', 'householdMember', {
      isPrimary: true,
      firstName: 'Primary',
      lastName: 'Member',
      email: 'primary@example.test',
      birthdate: '1985-01-01',
    } as HouseholdMemberPayload);
    const account = aggregate<AccountPayload>(
      'roth-own',
      'account',
      rothAccountPayload({
        ownerId: member.id,
        planningReturnPct: 0,
        plannedContributionPostTax: 0,
      }),
    );
    const savings = aggregate<AccountPayload>('savings', 'account', {
      ...rothAccountPayload({ ownerId: member.id, planningReturnPct: 0 }),
      name: 'Savings',
      type: 'SAVINGS',
      taxTreatment: 'POST_TAX',
      plannedContributionPostTax: 0,
    });
    const balance = aggregate<AccountBalancePayload>('balance-roth-2020', 'accountBalance', {
      accountId: account.id,
      year: 2020,
      lastUpdated: '2020-12-31',
      startingBalance: 0,
      startingBalancePreTax: null,
      startingBalancePostTax: null,
      contributionsPreTax: null,
      contributionsPostTax: null,
      companyContributions: 0,
      companyContributionsPreTax: null,
      companyContributionsPostTax: null,
      rollover: 10_000,
      distributions: 0,
      endingBalance: 10_000,
      endingBalancePreTax: null,
      endingBalancePostTax: null,
      totalContributions: 0,
      comment: null,
      rothConversionTaxableAmount: 10_000,
    });
    const savingsBalance = aggregate<AccountBalancePayload>(
      'balance-savings-2020',
      'accountBalance',
      {
        ...balance.payload,
        accountId: savings.id,
        rollover: 0,
        endingBalance: 10_000,
        rothConversionTaxableAmount: undefined,
      },
    );
    const scenario = aggregate<ScenarioPayload>('scenario', 'scenario', {
      name: 'Recorded conversion',
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {
        retirementAge: {
          primary: { ageYears: retirementAge, ageMonths: 0 },
          secondary: { ageYears: retirementAge, ageMonths: 0 },
        },
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
        inflation: { ratePct: 0 },
        lifeExpectancy: { primary: retirementAge + 1, secondary: retirementAge + 1 },
        withdrawalStrategy: { kind: 'rothFirst' },
        acaMarketplaceOptOutMemberIds: [member.id],
      },
    }) as ScenarioAggregate;
    const expense = aggregate<ExpensePayload>('expense', 'expense', {
      name: 'Living',
      categoryId: 'cat-housing',
      amount: 10_000,
      frequency: 'yearly',
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'last' },
    });
    return runBalanceProjection({
      scenarioId: scenario.id,
      scenarios: [scenario],
      accounts: [account, savings],
      balances: [balance, savingsBalance],
      members: [member],
      ssBenefits: [],
      expenses: [expense],
      incomeStreams: [],
      todayYear: 2021,
      todayMonthIndex: 0,
    }).drawdownYears.find((row) => row.year === retirementYear)!;
  };

  it('funds the annotation recapture in-window and drops it at the five-year boundary', () => {
    const inWindow = projectAt(2024);
    expect(inWindow.federalTaxCents).toBe(100_000);
    // Roth-first exhausts the $10k conversion principal on living costs, then savings supply the $1k recapture tax.
    expect(Math.round((inWindow.withdrawal - 10_000) * 100)).toBe(
      inWindow.federalTaxCents,
    );

    const boundary = projectAt(2025);
    expect(boundary.federalTaxCents).toBe(0);
    expect(boundary.withdrawal).toBeCloseTo(10_000, 2);
  });
});

describe('an inherited DESIGNATED-Roth plan is unchanged (scope)', () => {
  // One inherited-or-not Roth 401(k): $10,000 drawn from a $100,000 pocket by a beneficiary aged 45; $40,000 basis of rollover
  // principal, clock 2005 unless overridden.
  const run = (inherited: boolean, firstParticipationTaxYear = 2005) => {
    const accounts = [
      {
        id: 'roth-401k',
        payload: rothAccountPayload({
          type: 'RETIREMENT_ROTH_401K',
          designatedRothFirstParticipationTaxYear: firstParticipationTaxYear,
          ...(inherited ? { rmdInheritedAccount: true } : {}),
        }),
      },
    ];
    const rothDistributionFacts = buildRothDistributionFacts(accounts, [
      rolloverRow('roth-401k', 2005, 40_000),
    ]);
    const ctx = makeCtx({
      primaryBirthdate: '1982-01-01', // age 45 in 2027
      accountProjections: [
        { id: 'roth-401k', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_401K' },
      ],
      rothDistributionFacts,
      ...(inherited
        ? { rmdProfileFactsByAccountId: new Map([['roth-401k', { inheritedAccount: true }]]) }
        : {}),
    });
    return applyRothBasisOrdering(
      ctx,
      makeDrawdownYear(
        2027,
        10_000,
        new Map([['roth-401k', makeAccountBalance(90_000, 10_000)]]),
      ),
      new Map(),
      seedDesignatedRothCarrier(rothDistributionFacts.designatedByAccount),
    );
  };

  it('still records the inherited fact on the per-ACCOUNT designated facts', () => {
    const { designatedByAccount } = buildRothDistributionFacts(
      [
        {
          id: 'roth-401k',
          payload: rothAccountPayload({
            type: 'RETIREMENT_ROTH_401K',
            designatedRothBasis: 40_000,
            rmdInheritedAccount: true,
          }),
        },
      ],
      [],
    );
    expect(designatedByAccount.get('roth-401k')?.inheritedFromDeceasedOwner).toBe(true);
  });

  it('qualifies an inherited plan on the five-year test alone (death is the event)', () => {
    const split = run(true);
    expect(split.earningsExcessDollars).toBe(0);
    expect(split.penaltyAccounts).toEqual([]);
  });

  it('still applies §402A pro rata to an INHERITED plan whose own clock is UNMET (guard-scope pin)', () => {
    // Clock 2025 + 5 > 2027: nonqualified even though death qualifies, so the $10k draw splits pro rata against the $40k basis
    // ($6,000 earnings as ordinary income) while §72(t)(2)(A)(ii) waives the 10%. Discriminates the inherited-skip guard's
    // scope: if collectRothDraws dropped every inherited draw, earningsExcessDollars would be 0.
    const split = run(true, 2025);
    expect(split.earningsExcessDollars).toBeCloseTo(6_000, 6);
    expect(split.penaltyAccounts).toEqual([]);
  });

  it('still applies §402A pro rata to the SAME plan when it is NOT inherited', () => {
    // Nonqualified (owner is 45): $40k basis of a $100k pocket → 60% earnings = $6,000 income and the whole $6,000 is the 10% base.
    const split = run(false);
    expect(split.earningsExcessDollars).toBeCloseTo(6_000, 6);
    expect(split.penaltyAccounts).toHaveLength(1);
    expect(split.penaltyAccounts[0].penaltyPreTaxWithdrawalDollars).toBeCloseTo(6_000, 6);
  });
});
