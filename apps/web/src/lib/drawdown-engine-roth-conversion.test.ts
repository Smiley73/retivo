/**
 * Engine-level tests for the Fill-mode Roth-conversion fill step:
 * the post-monthly-loop conversion that moves leftover MAGI headroom from
 * pre-tax / MIXED-pre buckets into the user-designated target Roth.
 *
 * These drive `simulateDrawdown` with a STUB `solveFillConversionForYear` so the
 * commit mechanics (principal move, MIXED-pre only, integer cents, balance
 * conservation, §72(t) exclusion, cap-bound gating, no/dangling-Roth degrade)
 * are deterministic and isolated from the bisection math (covered in
 * `tax-cashflow-fill-conversion.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import { simulateDrawdown } from './drawdown-engine';
import type {
  DrawdownAccountInput,
  DrawdownInput,
  TaxCashflowHook,
  TaxCashflowYearClassification,
} from './drawdown-engine-types';
import type { MonthlyCashflowSeries } from './monthly-cashflow';
import type { RmdContextInput } from './drawdown-engine-types';
import type { MagiCapWindow } from '../db/types';
import { singleMagiCapWindow } from './drawdown-engine-per-account-magi-cap';
import { RMD_DIVISORS } from './rmd-divisors';

function makeRmdContext(accountIds: ReadonlyArray<string>): RmdContextInput {
  const ownerByAccountId = new Map<string, string>();
  for (const id of accountIds) ownerByAccountId.set(id, 'owner-1');
  const ownerMeta = new Map<string, { isoBirthdate: string; deathYear: number }>();
  // Age 90 in 2040 (born 1950) → a large RMD divisor-driven forced draw.
  ownerMeta.set('owner-1', { isoBirthdate: '1950-01-01', deathYear: 9999 });
  return { ownerMeta, ownerByAccountId, rmdSnapshot: RMD_DIVISORS };
}

function zeros(startYear: number, horizonYear: number): MonthlyCashflowSeries {
  const months = (horizonYear - startYear + 1) * 12;
  return { startYear, startMonthIndex: 0, values: new Float64Array(months) };
}
function uniform(startYear: number, horizonYear: number, monthly: number): MonthlyCashflowSeries {
  const months = (horizonYear - startYear + 1) * 12;
  return { startYear, startMonthIndex: 0, values: new Float64Array(months).fill(monthly) };
}

function account(
  o: Partial<DrawdownAccountInput> & { id: string },
  startYear: number,
  horizonYear: number,
): DrawdownAccountInput {
  return {
    initialPre: 0,
    initialPost: 0,
    annualRatePct: 0,
    taxTreatment: 'PRE_TAX',
    accountType: 'RETIREMENT_IRA',
    depositsByMonth: zeros(startYear, horizonYear),
    ...o,
  };
}

/** A hook funding $0 ordinary tax, but converting a FIXED `convPerYear` dollars
 *  whenever the engine offers headroom (room ≥ convPerYear). Records the room +
 *  ceiling it was offered each year. `convTaxRate` (default 0) models the
 *  conversion's same-year incremental tax as a flat fraction of the converted
 *  amount, returned from `fundConversionTaxForYear` so the engine funds it from
 *  cap-safe balances. */
function fixedConversionHook(convPerYear: number, convTaxRate = 0): {
  hook: TaxCashflowHook;
  offers: Array<{ room: number; ceiling: number; cls: TaxCashflowYearClassification }>;
} {
  const offers: Array<{ room: number; ceiling: number; cls: TaxCashflowYearClassification }> = [];
  const hook: TaxCashflowHook = {
    solveForYear: (_y, ordinaryNetNeed, classify) => {
      classify(ordinaryNetNeed);
      return {
        addedNeedDollars: 0,
        federalTaxCashNeedCents: 0,
        irmaaWithheldFromSsCents: 0,
        irmaaCashNeedCents: 0,
        acaPtcCashflowOffsetCents: 0,
        totalTaxCashflowNeedCents: 0,
        taxCashflowIterations: 1,
        taxCashflowConverged: true,
        taxCashflowShortfallCents: 0,
      };
    },
    solveFillConversionForYear: (_y, cls, room, _line, ceiling) => {
      offers.push({ room, ceiling, cls });
      return Math.min(convPerYear, Math.max(0, room));
    },
    fundConversionTaxForYear: (_y, _cls, convertedDollars) =>
      convertedDollars * convTaxRate,
  };
  return { hook, offers };
}

function baseInput(
  accounts: DrawdownAccountInput[],
  startYear: number,
  horizonYear: number,
  monthlyExpense: number,
  hook: TaxCashflowHook | undefined,
  magiCap: MagiCapWindow | undefined,
  capOffYear: number,
): DrawdownInput {
  return {
    portfolioAtRetirement: 0,
    ratePct: 0,
    expensesByMonth: uniform(startYear, horizonYear, monthlyExpense),
    incomeByMonth: zeros(startYear, horizonYear),
    depositsByMonth: zeros(startYear, horizonYear),
    retirementYear: startYear,
    horizonYear,
    withdrawalStrategy: { kind: 'proportional' },
    accounts,
    taxCashflow: hook,
    magiCapWindows: magiCap ? singleMagiCapWindow(magiCap, capOffYear) : undefined,
  };
}

const FILL_CAP = (targetRothAccountId: string): MagiCapWindow => ({
  start: { kind: 'retirementStart' },
  end: { kind: 'age', memberId: 'primary', years: 75, months: 0 },
  magiCeilingAnnualDollars: 80_000,
  capMode: 'fill',
  capMagiLine: 'irmaa',
  targetRothAccountId,
});

const MINIMIZE_CAP: MagiCapWindow = {
  start: { kind: 'retirementStart' },
  end: { kind: 'age', memberId: 'primary', years: 75, months: 0 },
  magiCeilingAnnualDollars: 80_000,
  capMode: 'minimize',
  capMagiLine: 'irmaa',
};

describe('Fill-mode Roth conversion fill (engine)', () => {
  it('should_move_pre_tax_principal_into_the_target_roth_and_stamp_converted_cents', () => {
    const accts = [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      account({ id: 'roth', initialPost: 10_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    const { hook } = fixedConversionHook(20_000);
    // $0 spending isolates the conversion: pre-tax is debited only by the $20k
    // conversion, the target Roth credited only by it.
    const out = simulateDrawdown(baseInput(accts, 2040, 2040, 0, hook, FILL_CAP('roth'), 2050));
    const y = out.years[0];
    // $20k converted: stamped on the row in integer cents.
    expect(y.rothConvertedCents).toBe(2_000_000);
    const ira = y.accountBalances!.get('ira')!;
    const roth = y.accountBalances!.get('roth')!;
    expect(ira.preEnd).toBeCloseTo(500_000 - 20_000, 0);
    expect(roth.postEnd).toBeCloseTo(10_000 + 20_000, 0);
  });

  it('should_conserve_total_balance_minus_the_funded_conversion_tax', () => {
    // The conversion principal move is an internal transfer (conserves
    // total), but its same-year incremental tax is FUNDED from cap-safe
    // balances — so the ending total balance drops by exactly that funded tax
    // (balance conserved minus funded tax), NOT byte-identical.
    const mk = (): DrawdownAccountInput[] => [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      // A MAGI-NEUTRAL cash-like bucket so the conversion tax can be funded
      // without itself raising MAGI (a brokerage post would NOT qualify).
      account({ id: 'cash', initialPost: 200_000, taxTreatment: 'POST_TAX', accountType: 'SAVINGS' }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    const noConv = simulateDrawdown(baseInput(mk(), 2040, 2040, 1_000, fixedConversionHook(0, 0.2).hook, FILL_CAP('roth'), 2050));
    const withConv = simulateDrawdown(baseInput(mk(), 2040, 2040, 1_000, fixedConversionHook(30_000, 0.2).hook, FILL_CAP('roth'), 2050));
    // $30k converted at a 20% incremental rate → $6k of conversion tax funded
    // from the cash-like bucket. Ending balance = no-conversion balance − $6k.
    expect(withConv.years[0].rothConvertedCents).toBe(3_000_000);
    expect(noConv.years[0].balance - withConv.years[0].balance).toBeCloseTo(6_000, 0);
  });

  it('should_make_fill_end_lower_than_minimize_by_the_funded_conversion_tax', () => {
    // Fill is not a free lunch. In a conversion year, Fill's ending
    // balance is LOWER than Minimize's by exactly the funded conversion tax —
    // the conversion principal transfer conserves total, but the conversion's
    // incremental tax is drawn from the portfolio.
    const mk = (): DrawdownAccountInput[] => [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      // MAGI-neutral cash-like funding source (a brokerage post would not qualify).
      account({ id: 'cash', initialPost: 200_000, taxTreatment: 'POST_TAX', accountType: 'SAVINGS' }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    const fill = simulateDrawdown(baseInput(mk(), 2040, 2040, 1_000, fixedConversionHook(25_000, 0.25).hook, FILL_CAP('roth'), 2050));
    const minimize = simulateDrawdown(baseInput(mk(), 2040, 2040, 1_000, fixedConversionHook(25_000, 0.25).hook, MINIMIZE_CAP, 2050));
    // Minimize converts nothing → no conversion tax. Fill converts $25k at 25%
    // → $6,250 funded tax. Fill ends $6,250 lower.
    expect(minimize.years[0].rothConvertedCents).toBeUndefined();
    expect(fill.years[0].rothConvertedCents).toBe(2_500_000);
    expect(minimize.years[0].balance - fill.years[0].balance).toBeCloseTo(6_250, 0);
  });

  it('should_exclude_the_conversion_from_the_year_withdrawal_total_so_§72t_basis_excludes_it', () => {
    const accts = [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    const noConv = simulateDrawdown(baseInput([...accts.map((a) => ({ ...a }))], 2040, 2040, 1_000, fixedConversionHook(0).hook, FILL_CAP('roth'), 2050));
    const accts2 = [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    const withConv = simulateDrawdown(baseInput(accts2, 2040, 2040, 1_000, fixedConversionHook(25_000).hook, FILL_CAP('roth'), 2050));
    // The conversion does NOT increase `withdrawn` (a transfer is not a
    // distribution) — so the §72(t) penalty basis (which keys off withdrawn
    // pre-tax) excludes it.
    expect(withConv.years[0].withdrawn).toBeCloseTo(noConv.years[0].withdrawn, 0);
  });

  it('should_never_convert_a_MIXED_post_tranche_only_the_pre_tranche', () => {
    // A MIXED account: pre $40k + post $60k. Convert $50k → all $40k pre is
    // taken, then the next $10k comes from another pre-tax account, NEVER from
    // the MIXED post tranche.
    const accts = [
      account({ id: 'mixed', initialPre: 40_000, initialPost: 60_000, taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' }, 2040, 2040),
      account({ id: 'ira', initialPre: 200_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    // No spending (so the mixed pre stays at $40k entering the conversion).
    const { hook } = fixedConversionHook(50_000);
    const out = simulateDrawdown(baseInput(accts, 2040, 2040, 0, hook, FILL_CAP('roth'), 2050));
    const mixed = out.years[0].accountBalances!.get('mixed')!;
    // MIXED pre fully converted to 0; its post tranche untouched (negative assert).
    expect(mixed.preEnd).toBeCloseTo(0, 1);
    expect(mixed.postEnd).toBeCloseTo(60_000, 1);
    expect(out.years[0].rothConvertedCents).toBe(5_000_000);
  });

  it('should_convert_nothing_under_Minimize_mode', () => {
    const accts = [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    const out = simulateDrawdown(baseInput(accts, 2040, 2040, 1_000, fixedConversionHook(20_000).hook, MINIMIZE_CAP, 2050));
    expect(out.years[0].rothConvertedCents).toBeUndefined();
  });

  it('should_keep_a_capped_Minimize_run_byte_identical_whether_or_not_the_fill_hook_exists', () => {
    // Minimize regression lock: a capped Minimize scenario must produce
    // IDENTICAL deterministic output whether the hook offers a conversion solve
    // or not — Fill is the only path that converts.
    const mk = (): DrawdownAccountInput[] => [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2042),
      account({ id: 'brok', initialPost: 200_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, 2040, 2042),
      account({ id: 'roth', initialPost: 50_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2042),
    ];
    // Hook WITHOUT a fill method (legacy stub) vs WITH one offering $20k.
    const noFillHook: TaxCashflowHook = { solveForYear: fixedConversionHook(0).hook.solveForYear };
    const withFill = fixedConversionHook(20_000).hook;
    const a = simulateDrawdown(baseInput(mk(), 2040, 2042, 2_000, noFillHook, MINIMIZE_CAP, 2050));
    const b = simulateDrawdown(baseInput(mk(), 2040, 2042, 2_000, withFill, MINIMIZE_CAP, 2050));
    expect(b.years.map((y) => y.balance)).toEqual(a.years.map((y) => y.balance));
    expect(b.years.every((y) => y.rothConvertedCents === undefined)).toBe(true);
  });

  it('should_convert_nothing_with_no_cap_configured', () => {
    const accts = [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    const out = simulateDrawdown(baseInput(accts, 2040, 2040, 1_000, fixedConversionHook(20_000).hook, undefined, 2050));
    expect(out.years[0].rothConvertedCents).toBeUndefined();
  });

  it('should_convert_nothing_after_capOffYear', () => {
    const accts = [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    // capOffYear 2040 == the projection year → cap is OFF (calendarYear < capOff is false).
    const out = simulateDrawdown(baseInput(accts, 2040, 2040, 1_000, fixedConversionHook(20_000).hook, FILL_CAP('roth'), 2040));
    expect(out.years[0].rothConvertedCents).toBeUndefined();
  });

  it('should_degrade_to_withdrawal_only_when_the_target_roth_is_dangling', () => {
    const accts = [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    // Target points at a non-existent account id → no conversion + notice flag.
    const out = simulateDrawdown(baseInput(accts, 2040, 2040, 1_000, fixedConversionHook(20_000).hook, FILL_CAP('does-not-exist'), 2050));
    expect(out.years[0].rothConvertedCents).toBeUndefined();
    expect(out.years[0].rothConversionDegradedNoTarget).toBe(true);
  });

  it('should_convert_zero_in_an_RMD_breach_year_when_RMD_alone_fills_the_cap', () => {
    // A huge pre-tax IRA at advanced age forces an RMD well above the cap, so the
    // mandatory forced draw alone breaches the ceiling → no residual room → the
    // Fill conversion is $0 even though the hook would convert if offered room.
    const accts = [
      account({ id: 'ira', initialPre: 5_000_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    const { hook, offers } = fixedConversionHook(20_000);
    const out = simulateDrawdown({
      portfolioAtRetirement: 0,
      ratePct: 0,
      expensesByMonth: uniform(2040, 2040, 1_000),
      incomeByMonth: zeros(2040, 2040),
      depositsByMonth: zeros(2040, 2040),
      retirementYear: 2040,
      horizonYear: 2040,
      withdrawalStrategy: { kind: 'proportional' },
      accounts: accts,
      taxCashflow: hook,
      magiCapWindows: singleMagiCapWindow(FILL_CAP('roth'), 2050),
      rmdContext: makeRmdContext(['ira', 'roth']),
    });
    // RMD (5M / ~12 divisor ≈ $400k) ≫ the $80k cap → the year is a breach, no
    // headroom → the conversion fill is never offered any room (room ≤ 0).
    expect(out.years[0].rothConvertedCents).toBeUndefined();
    if (offers.length > 0) expect(offers.every((o) => o.room <= 0)).toBe(true);
    // The breach is recorded (RMD forced pre-tax above the cap).
    expect(out.years[0].magiCapBreachDollars ?? 0).toBeGreaterThan(0);
  });

  it('should_not_fund_conversion_tax_from_a_brokerage_post_bucket_so_MAGI_never_overshoots', () => {
    // The only cap-safe asset (besides the empty target Roth) is a
    // BROKERAGE. A brokerage `post` draw realizes LTCG → MAGI, so funding the
    // conversion tax from it would push realized MAGI back above the ceiling the
    // bisection just filled. The engine must leave the brokerage untouched and
    // let the unfunded conversion tax surface as the year's depletion.
    const accts = [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      account({ id: 'brok', initialPost: 200_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    // $40k conversion at a 25% incremental rate → $10k conversion tax NEED.
    const out = simulateDrawdown(baseInput(accts, 2040, 2040, 0, fixedConversionHook(40_000, 0.25).hook, FILL_CAP('roth'), 2050));
    const y = out.years[0];
    expect(y.rothConvertedCents).toBe(4_000_000);
    // The brokerage's post is NOT drawn for the conversion tax — it grows only by
    // its (zero) rate, so it stays at its starting balance.
    const brok = y.accountBalances!.get('brok')!;
    expect(brok.postEnd).toBeCloseTo(200_000, 0);
    // The unfundable conversion tax (no MAGI-neutral source) is a depletion.
    expect(y.depleted).toBe(true);
  });

  it('should_fund_conversion_tax_from_a_cash_like_post_bucket_which_is_MAGI_neutral', () => {
    // Control: a cash-like (SAVINGS) post bucket IS MAGI-neutral
    // (return-of-principal, $0 MAGI), so the conversion tax IS funded from it and
    // the year is not a depletion — proving the brokerage exclusion is a
    // tax-treatment distinction, not a blanket "never fund" regression.
    const accts = [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      account({ id: 'cash', initialPost: 200_000, taxTreatment: 'POST_TAX', accountType: 'SAVINGS' }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    const out = simulateDrawdown(baseInput(accts, 2040, 2040, 0, fixedConversionHook(40_000, 0.25).hook, FILL_CAP('roth'), 2050));
    const y = out.years[0];
    expect(y.rothConvertedCents).toBe(4_000_000);
    // $10k conversion tax funded out of the cash-like bucket.
    const cash = y.accountBalances!.get('cash')!;
    expect(cash.postEnd).toBeCloseTo(200_000 - 10_000, 0);
    expect(y.depleted).toBe(false);
  });

  it('should_not_draw_the_same_year_converted_principal_to_fund_the_conversion_tax', () => {
    // The target Roth is empty before the conversion, and there is no other
    // MAGI-neutral source. The funding draw must NOT touch the just-converted
    // principal (it would be misclassified as Roth earnings → §72(t) under-59½).
    // The Roth ends holding exactly the converted principal; the unfunded tax is
    // a depletion.
    const accts = [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    const out = simulateDrawdown(baseInput(accts, 2040, 2040, 0, fixedConversionHook(30_000, 0.25).hook, FILL_CAP('roth'), 2050));
    const y = out.years[0];
    expect(y.rothConvertedCents).toBe(3_000_000);
    // Roth holds the converted $30k EXACTLY — the funding draw did not eat into it.
    const roth = y.accountBalances!.get('roth')!;
    expect(roth.postEnd).toBeCloseTo(30_000, 0);
    // The $7,500 conversion tax could not be funded → depletion.
    expect(y.depleted).toBe(true);
  });

  it('should_never_touch_an_excluded_HSA_during_the_conversion_or_its_tax_funding', () => {
    // A default-excluded HSA carries a qualified (MAGI-neutral) balance in
    // its post bucket and some pre. Neither the conversion debit loop nor the
    // conversion-tax funding draw may touch the excluded account — its pre AND
    // post are untouched (apart from its zero growth rate).
    const accts = [
      account({ id: 'ira', initialPre: 500_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, 2040, 2040),
      account({ id: 'hsa', initialPre: 50_000, initialPost: 80_000, taxTreatment: 'HSA', accountType: 'HSA' }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    const out = simulateDrawdown({
      portfolioAtRetirement: 0,
      ratePct: 0,
      expensesByMonth: uniform(2040, 2040, 0),
      incomeByMonth: zeros(2040, 2040),
      depositsByMonth: zeros(2040, 2040),
      retirementYear: 2040,
      horizonYear: 2040,
      withdrawalStrategy: { kind: 'customOrder' },
      customDrawdownOrder: { tiers: [['ira'], ['roth']], excludedAccountIds: ['hsa'] },
      accounts: accts,
      taxCashflow: fixedConversionHook(40_000, 0.25).hook,
      magiCapWindows: singleMagiCapWindow(FILL_CAP('roth'), 2050),
    });
    const y = out.years[0];
    expect(y.rothConvertedCents).toBe(4_000_000);
    // The excluded HSA's pre AND post are both untouched.
    const hsa = y.accountBalances!.get('hsa')!;
    expect(hsa.preEnd).toBeCloseTo(50_000, 0);
    expect(hsa.postEnd).toBeCloseTo(80_000, 0);
    // No MAGI-neutral (non-excluded) source exists → conversion tax unfunded → depletion.
    expect(y.depleted).toBe(true);
  });

  it.each(['emergencyOnly', 'strict'] as const)(
    'should_not_fund_conversion_tax_below_a_floored_HSA_floor_in_%s_mode',
    (floorHsaMode) => {
      // A floored HSA is a MAGI-neutral funding
      // candidate, but the conversion-tax draw must stop at its floor — in BOTH
      // hsaModes identically (floorEligibleDollars is mode-invariant). Above
      // the floor there is only $10k; the $15k tax need can pull only that $10k,
      // leaving the HSA sitting exactly at its floor and a $5k unfundable residual.
      const accts = [
        account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
        account(
          { id: 'hsa', initialPost: 100_000, floorDollars: 90_000, floorHsaMode, taxTreatment: 'HSA', accountType: 'HSA' },
          2040,
          2040,
        ),
        account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
      ];
      const out = simulateDrawdown(baseInput(accts, 2040, 2040, 0, fixedConversionHook(60_000, 0.25).hook, FILL_CAP('roth'), 2050));
      const y = out.years[0];
      expect(y.rothConvertedCents).toBe(6_000_000);
      const hsa = y.accountBalances!.get('hsa')!;
      // Drawn down to — never below — the $90k floor.
      expect(hsa.postEnd).toBeCloseTo(90_000, 0);
      // The $5k that could not be pulled without breaching the floor is unfunded.
      expect(y.depleted).toBe(true);
    },
  );

  it('should_not_fund_conversion_tax_below_a_floored_cash_like_post_floor', () => {
    // The identical protection for a floor-eligible
    // POST_TAX cash-like (SAVINGS) account — its $10k above-floor slice funds the
    // tax, the floor holds, the remainder is unfundable.
    const accts = [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      account({ id: 'cash', initialPost: 100_000, floorDollars: 90_000, taxTreatment: 'POST_TAX', accountType: 'SAVINGS' }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    const out = simulateDrawdown(baseInput(accts, 2040, 2040, 0, fixedConversionHook(60_000, 0.25).hook, FILL_CAP('roth'), 2050));
    const y = out.years[0];
    expect(y.rothConvertedCents).toBe(6_000_000);
    const cash = y.accountBalances!.get('cash')!;
    expect(cash.postEnd).toBeCloseTo(90_000, 0);
    expect(y.depleted).toBe(true);
  });

  it('should_floor_a_pre_bearing_HSA_on_post_alone_independent_of_its_pre_balance', () => {
    // Post-only floor basis: a pre-bearing HSA
    // (`pre` $50k, `post` $80k, floor $70k). The floor caps the tax draw at
    // `post − floor` = $10k, INDEPENDENT of the $50k `pre`. A combined-basis
    // (`pre + post − floor` = $60k) cap would wrongly let the draw reach $25k and
    // drain `post` to $55k — this pins that regression. The conversion sources
    // entirely from the $500k IRA (account order), so the HSA `pre` is untouched.
    const accts = [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      account({ id: 'hsa', initialPre: 50_000, initialPost: 80_000, floorDollars: 70_000, taxTreatment: 'HSA', accountType: 'HSA' }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    const out = simulateDrawdown(baseInput(accts, 2040, 2040, 0, fixedConversionHook(60_000, 0.25).hook, FILL_CAP('roth'), 2050));
    const y = out.years[0];
    expect(y.rothConvertedCents).toBe(6_000_000);
    const hsa = y.accountBalances!.get('hsa')!;
    // `post` capped at the floor ($70k), NOT drained on the combined basis ($55k).
    expect(hsa.postEnd).toBeCloseTo(70_000, 0);
    // `pre` untouched — the floor is enforced on `post` alone.
    expect(hsa.preEnd).toBeCloseTo(50_000, 0);
    expect(y.depleted).toBe(true);
  });

  it('should_still_fund_the_full_post_of_an_UNFLOORED_HSA_no_op_regression_control', () => {
    // No-op control: an HSA with no floor set is unchanged
    // by the floor logic — `floorEligibleDollars` returns 0, so its full $100k `post` is
    // drawable. The $15k tax funds entirely; the year is not a depletion.
    const accts = [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      account({ id: 'hsa', initialPost: 100_000, taxTreatment: 'HSA', accountType: 'HSA' }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    const out = simulateDrawdown(baseInput(accts, 2040, 2040, 0, fixedConversionHook(60_000, 0.25).hook, FILL_CAP('roth'), 2050));
    const y = out.years[0];
    expect(y.rothConvertedCents).toBe(6_000_000);
    const hsa = y.accountBalances!.get('hsa')!;
    // Full $15k tax funded from the unfloored HSA → $85k remains, no depletion.
    expect(hsa.postEnd).toBeCloseTo(85_000, 0);
    expect(y.depleted).toBe(false);
  });

  it('should_route_the_post_floor_shortfall_to_the_next_MAGI_neutral_candidate', () => {
    // When a floored candidate's above-floor
    // slice can't cover the tax, the shortfall routes to the NEXT MAGI-neutral
    // account in the existing order — the loop is unchanged, the floor just
    // shrinks the first candidate's contribution. Floored cash ($10k above floor)
    // + an unfloored cash bucket ($200k) together cover the $15k tax, no depletion.
    const accts = [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      account({ id: 'cash1', initialPost: 100_000, floorDollars: 90_000, taxTreatment: 'POST_TAX', accountType: 'SAVINGS' }, 2040, 2040),
      account({ id: 'cash2', initialPost: 200_000, taxTreatment: 'POST_TAX', accountType: 'MONEY_MARKET' }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    const out = simulateDrawdown(baseInput(accts, 2040, 2040, 0, fixedConversionHook(60_000, 0.25).hook, FILL_CAP('roth'), 2050));
    const y = out.years[0];
    expect(y.rothConvertedCents).toBe(6_000_000);
    const cash1 = y.accountBalances!.get('cash1')!;
    const cash2 = y.accountBalances!.get('cash2')!;
    // Floored cash1 gives exactly its $10k above-floor slice, then cash2 covers the $5k rest.
    expect(cash1.postEnd).toBeCloseTo(90_000, 0);
    expect(cash2.postEnd).toBeCloseTo(195_000, 0);
    expect(y.depleted).toBe(false);
  });

  it('should_leave_an_unfundable_residual_when_floor_exhaustion_leaves_no_other_candidate', () => {
    // A floored CD is the ONLY MAGI-neutral
    // source. Its $10k above-floor slice funds part of the $15k tax; with no other
    // candidate the $5k residual stays unfunded and surfaces as the year's
    // depletion — the existing degrade path, reachable via floor exhaustion.
    const accts = [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      account({ id: 'cd', initialPost: 100_000, floorDollars: 90_000, taxTreatment: 'POST_TAX', accountType: 'CD' }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    const out = simulateDrawdown(baseInput(accts, 2040, 2040, 0, fixedConversionHook(60_000, 0.25).hook, FILL_CAP('roth'), 2050));
    const y = out.years[0];
    expect(y.rothConvertedCents).toBe(6_000_000);
    const cd = y.accountBalances!.get('cd')!;
    expect(cd.postEnd).toBeCloseTo(90_000, 0);
    expect(y.depleted).toBe(true);
  });

  it('should_offer_only_integer_cent_conversions_with_no_penny_drift', () => {
    const accts = [
      account({ id: 'ira', initialPre: 500_000 }, 2040, 2040),
      account({ id: 'roth', initialPost: 0, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2040, 2040),
    ];
    // Convert a fractional-cent amount; the engine rounds to whole cents and the
    // debit == the Roth credit exactly.
    const { hook } = fixedConversionHook(12_345.678);
    const out = simulateDrawdown(baseInput(accts, 2040, 2040, 0, hook, FILL_CAP('roth'), 2050));
    const cents = out.years[0].rothConvertedCents!;
    expect(Number.isInteger(cents)).toBe(true);
    const roth = out.years[0].accountBalances!.get('roth')!;
    expect(Math.round(roth.postEnd * 100)).toBe(cents);
  });
});
