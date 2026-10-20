/**
 * `retivo_get_projection`: the deterministic year-by-year projection the Balance
 * Projection page shows, for one scenario and one method. The numbers come from
 * the page's own assembly and runner (`projection-support.ts`); this module only
 * chooses which fields leave (a fixed allowlist), converts the engine's cents to
 * dollars, applies the today's-dollar deflator once per row and rounds to the
 * person's choice. Nothing is written.
 */
import type { ProjectionMethod } from '@retirement/assistant-protocol';
import type { DrawdownYear } from '../../lib/drawdown-engine';
import { realDeflatorAt } from '../../lib/projection-context';
import { defineTool, ToolArgsError, ToolFailure } from './define';
import { deterministicAssumptions } from './projection-assumptions';
import { dollarsFor, headlineOf, methodSlice, requirePageResult, resolveScenarioArg, runPlan } from './projection-support';

/** Tax and benefit figures the engine stamps in integer cents, by the name they leave under. */
const CENTS_FIELDS = {
  federalTax: 'federalTaxCents',
  taxableSocialSecurity: 'taxableSsCents',
  rmdFloor: 'rmdFloorCents',
  rmdShortfall: 'rmdShortfallCents',
  irmaaSurcharge: 'irmaaSurchargeCents',
  acaPtcSubsidy: 'acaPtcSubsidyCents',
  rothConverted: 'rothConvertedCents',
  qcd: 'qcdCents',
  magi: 'magiCents',
  netAfterTax: 'netAfterTaxCents',
  earlyWithdrawalPenalty: 'earlyWithdrawalPenaltyCents',
  hsaAdditionalTax: 'hsaAdditionalTaxCents',
} as const satisfies Record<string, keyof DrawdownYear>;

function yearLimit(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function rowOf(year: DrawdownYear, deflator: number, dollars: (value: number | null | undefined) => number | null) {
  const cents: Record<string, number | null> = {};
  for (const [name, field] of Object.entries(CENTS_FIELDS)) {
    const stored = year[field as keyof DrawdownYear];
    if (typeof stored === 'number') cents[name] = dollars(stored / 100);
  }
  return {
    year: year.year,
    balanceNominal: dollars(year.balance),
    // The deflator is applied to the unrounded balance, once, then the figure is rounded.
    balanceTodayDollars: dollars(year.balance * deflator),
    todayDollarsFactor: deflator,
    withdrawn: dollars(year.withdrawn),
    netNeed: dollars(year.netNeed),
    deposit: dollars(year.deposit),
    growth: dollars(year.growth),
    depleted: year.depleted,
    ...cents,
    ...(year.effectiveTaxRate !== undefined && { effectiveTaxRate: year.effectiveTaxRate }),
    ...(year.taxYearExtrapolated === true && { taxYearExtrapolated: true }),
    ...(year.magiEstimatedFromProjection === true && { magiEstimatedFromProjection: true }),
  };
}

export const retivoGetProjection = defineTool('retivo_get_projection', (args, env) => {
  const scenarioId = resolveScenarioArg(args.scenarioId, env);
  const method: ProjectionMethod = args.method === 'historical' ? 'historical' : 'planned';
  const run = runPlan(scenarioId, env);
  const pageResult = requirePageResult(run);
  if (pageResult.sharedCtx.cbpResolution && !pageResult.sharedCtx.cbpResolution.ok) {
    throw new ToolFailure(
      'INVALID_ARGS',
      'This scenario cannot be projected until the payout election on its cash balance plan account is set in Retivo.',
    );
  }
  // The page offers Historical exactly when the runner returns a slice for it.
  if (method === 'historical' && pageResult.twr === null) {
    throw new ToolArgsError(
      'The Historical view is not available for this plan: it needs a measured return from at least two years of balance history. Use method planned.',
    );
  }
  const slice = methodSlice(pageResult, method);
  if (slice === null) {
    throw new ToolFailure('INVALID_ARGS', 'The projection could not be completed for this scenario. Check its withdrawal and income settings in Retivo.');
  }
  const from = yearLimit(args.fromYear);
  const to = yearLimit(args.toYear);
  if (from !== undefined && to !== undefined && from > to) throw new ToolArgsError('fromYear is after toYear.');

  const dollars = dollarsFor(env);
  const headline = headlineOf(pageResult, method);
  const rows = slice.years
    .filter((year) => (from === undefined || year.year >= from) && (to === undefined || year.year <= to))
    .map((year) => rowOf(year, realDeflatorAt(pageResult.sharedCtx.ctx, year.year, 11), dollars));
  return {
    data: {
      scenarioId,
      method,
      basis: {
        method:
          method === 'planned'
            ? 'Planned: each account grows at its planned return.'
            : 'Historical: each account grows at the return it actually earned in its balance history.',
        rows: 'One row per calendar year from the retirement year to the horizon. Balances are at the end of December.',
        dollars:
          "balanceNominal, withdrawn, netNeed, deposit, growth and the tax figures are nominal dollars of that row's year. balanceTodayDollars is balanceNominal times todayDollarsFactor, which removes the scenario's inflation from the current month to that December.",
        tax: 'Tax, income-adjustment and benefit figures are dollars converted from the engine’s integer cents. A field the engine did not compute for a year is left out of that row.',
      },
      headline: {
        horizonYear: headline.horizonYear,
        retirementYear: headline.retirementYear,
        endingBalanceTodayDollars: dollars(headline.endingBalanceTodayDollars),
        runOutYear: headline.runOutYear,
        portfolioAtRetirementNominal: dollars(headline.portfolioAtRetirementNominal),
        portfolioAtRetirementTodayDollars: dollars(headline.portfolioAtRetirementTodayDollars),
      },
      years: rows,
    },
    assumptions: deterministicAssumptions(run, method, env),
  };
});
