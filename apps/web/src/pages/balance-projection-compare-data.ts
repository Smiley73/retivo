/**
 * Scenario Compare — PURE comparison data for two projected scenarios (no React
 * hooks, no store access), so the Compare tab renders without computing.
 *
 * Both sides are the Planned method in today's dollars, whatever the header
 * Basis/Display controls say. Every driver total comes through the same
 * burden-row builders the Taxes tab uses, under that tab's Planned /
 * today's-dollars arguments, with each side on its OWN inflation deflator and
 * its OWN death-year clip: federal tax, IRMAA and the ACA credit equal the
 * Taxes-tab tiles, number for number. Roth conversions are the one deflated
 * figure: the tab's series is nominal by design, so each year's dollars are
 * deflated here to today's dollars. RMDs are the gross requirement
 * (met + shortfall) and QCDs the gift in today's dollars.
 *
 * Every difference is `viewed - comparison`, `null` when either side is.
 *
 * Years of withdrawals, per `AccountBucket`: the count of death-clipped planned
 * years in which any account of that bucket has `accountBalances.get(id).withdrawn
 * > 0`. An account's bucket comes from `data.accounts`; an id absent from it is
 * skipped (the engine's synthetic RMD-overflow cash carrier is not an
 * aggregate). Forced RMD withdrawals and conversion-tax funding sit in
 * `withdrawn` and count.
 */
import { accountBucket, type AccountBucket } from '../lib/account-bucket';
import type { DrawdownYear } from '../lib/drawdown-engine';
import {
  buildScenarioChangeList,
  type ScenarioChangeList,
} from '../lib/scenario-change-list';
import { structurallyEqual } from '../lib/structural-equality';
import {
  drawdownByMethodFromPageResult,
  type PipelineData,
} from './balance-projection-page-data';
import {
  buildQcdRows,
  buildRmdRows,
  buildRothConversionsSeries,
  buildTaxBurdenRows,
} from './balance-projection-burden-rows';
import { sumTaxBurden } from './balance-projection-page-tax-burden';
import {
  buildBasisDeflator,
  buildViewDeflatorForExport,
} from './balance-projection-view-derivation';

const BUCKETS: ReadonlyArray<AccountBucket> = ['pretax', 'roth', 'taxable', 'cash', 'tax_free'];

/** Lifetime driver totals in today's dollars (a count of years for
 *  `withdrawalYears`). Tax, IRMAA and RMDs are costs; the ACA credit is a
 *  credit received, positive as the Taxes tab shows it. */
export interface CompareDrivers {
  readonly federalTax: number;
  readonly irmaaSurcharge: number;
  readonly acaPtcCredit: number;
  readonly rothConversions: number;
  readonly rmds: number;
  readonly qcds: number;
  readonly withdrawalYears: Readonly<Record<AccountBucket, number>>;
}

interface CompareSide {
  readonly horizonYear: number | null;
  /** At the horizon, today's dollars; `null` without a planned result. */
  readonly endingBalance: number | null;
  /** The year the money runs out; `null` = never (or no planned result). */
  readonly runOutYear: number | null;
  /** `null` without a planned result. */
  readonly drivers: CompareDrivers | null;
}

export interface CompareData {
  readonly viewed: CompareSide;
  readonly comparison: CompareSide;
  /** `viewed - comparison`. */
  readonly difference: {
    readonly horizonYear: number | null;
    readonly endingBalance: number | null;
    readonly runOutYear: number | null;
    readonly drivers: CompareDrivers | null;
  };
  readonly identity: {
    /** The two planned year-by-year results are structurally equal. */
    readonly planned: boolean;
    /** The two stress-test cache keys are equal; `null` when either is unknown. */
    readonly stress: boolean | null;
  };
  /** Which settings the descendant's chain sets; empty when unrelated. */
  readonly changes: ScenarioChangeList;
}

function sum<T>(items: ReadonlyArray<T>, value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

/** The planned year-by-year rows, or `null` without a planned result (the
 *  `hasPlanned` guard of `deriveScenarioDeterministicMetrics`). */
function plannedYears(data: PipelineData): ReadonlyArray<DrawdownYear> | null {
  const planned = data.pageResult?.planned;
  return planned && planned.years.length > 0 ? planned.years : null;
}

/** True when `data` has a Planned projection to compare: a runner result, no
 *  unconfigured CBP election, and at least one planned year. The same guard
 *  `buildSide` applies before it reports any figure. */
export function hasPlannedProjection(data: PipelineData): boolean {
  return (
    plannedYears(data) !== null &&
    drawdownByMethodFromPageResult(data.pageResult)?.planned != null
  );
}

function withdrawalYears(
  data: PipelineData,
  years: ReadonlyArray<DrawdownYear>,
  deathYear: number | null,
): Record<AccountBucket, number> {
  const bucketById = new Map(
    data.accounts.map((a) => [a.id, accountBucket(a.payload.type)]),
  );
  const counts: Record<AccountBucket, number> = { pretax: 0, roth: 0, taxable: 0, cash: 0, tax_free: 0 };
  for (const yr of years) {
    if (deathYear !== null && yr.year > deathYear) continue;
    const drawn = new Set<AccountBucket>();
    for (const [id, acct] of yr.accountBalances ?? []) {
      const bucket = bucketById.get(id);
      if (bucket && acct.withdrawn > 0) drawn.add(bucket);
    }
    for (const bucket of drawn) counts[bucket] += 1;
  }
  return counts;
}

function buildSide(data: PipelineData): CompareSide {
  const pageResult = data.pageResult;
  const planned = pageResult?.planned ?? null;
  const years = plannedYears(data);
  const horizonYear = pageResult?.sharedCtx.horizonYear ?? null;
  const drawdown = drawdownByMethodFromPageResult(pageResult)?.planned ?? null;
  if (!pageResult || !planned || !years || !drawdown) {
    return { horizonYear, endingBalance: null, runOutYear: null, drivers: null };
  }
  const { todayYear, todayMonthIndex, lifeExpectancyMarkers } = pageResult.sharedCtx;
  const basisDeflator = buildBasisDeflator({
    isMcBasisActive: false,
    displayMode: 'today',
    activeRepresentativeRun: null,
    viewDeflator: buildViewDeflatorForExport(
      'today',
      data.resolved.inflation?.ratePct,
      todayYear,
      todayMonthIndex,
    ),
  });
  const lastDeathFractional = lifeExpectancyMarkers.length
    ? Math.max(...lifeExpectancyMarkers.map((m) => m.fractionalYear))
    : null;
  const deathYear =
    lastDeathFractional !== null && Number.isFinite(lastDeathFractional)
      ? Math.floor(lastDeathFractional)
      : null;
  const tax = sumTaxBurden(
    buildTaxBurdenRows({
      resolvedDrawdown: drawdown,
      basisDeflator,
      lastDeathFractional,
      isMcBasisActive: false,
    }),
  );
  const rothSeries = buildRothConversionsSeries({ drawdown, lastDeathFractional });
  const rmdRows = buildRmdRows({ drawdown, basisDeflator, lastDeathFractional });
  const qcdRows = buildQcdRows({
    drawdown,
    basisDeflator,
    lastDeathFractional,
    displayMode: 'today',
  });
  return {
    horizonYear,
    endingBalance: planned.atHorizonTodayDollars,
    runOutYear: planned.depletionYear,
    drivers: {
      federalTax: tax.federalTax,
      irmaaSurcharge: tax.irmaaSurcharge,
      acaPtcCredit: tax.acaPtcCredit,
      rothConversions: sum(rothSeries, (r) => r.dollars * basisDeflator(r.year)),
      rmds: sum(rmdRows, (r) => r.rmdMet + r.rmdShortfall),
      qcds: sum(qcdRows, (r) => r.qcdDollars),
      withdrawalYears: withdrawalYears(data, years, deathYear),
    },
  };
}

function diff(viewed: number | null, comparison: number | null): number | null {
  return viewed === null || comparison === null ? null : viewed - comparison;
}

function diffDrivers(a: CompareDrivers | null, b: CompareDrivers | null): CompareDrivers | null {
  if (!a || !b) return null;
  return {
    federalTax: a.federalTax - b.federalTax,
    irmaaSurcharge: a.irmaaSurcharge - b.irmaaSurcharge,
    acaPtcCredit: a.acaPtcCredit - b.acaPtcCredit,
    rothConversions: a.rothConversions - b.rothConversions,
    rmds: a.rmds - b.rmds,
    qcds: a.qcds - b.qcds,
    withdrawalYears: Object.fromEntries(
      BUCKETS.map((k) => [k, a.withdrawalYears[k] - b.withdrawalYears[k]]),
    ) as Record<AccountBucket, number>,
  };
}

/**
 * Compare the viewed scenario against another. The stress-test cache keys
 * (`mcCacheKey(buildMonteCarloInputForScenario(...))`) are async and
 * store-backed, so the caller computes them and passes them in as plain
 * strings (`null` when unknown); this builder stays synchronous.
 */
export function buildCompareData(args: {
  readonly viewed: PipelineData;
  readonly comparison: PipelineData;
  readonly stressCacheKeys: { readonly viewed: string | null; readonly comparison: string | null };
}): CompareData {
  const { viewed, comparison, stressCacheKeys } = args;
  const v = buildSide(viewed);
  const c = buildSide(comparison);
  const vYears = plannedYears(viewed);
  const cYears = plannedYears(comparison);
  return {
    viewed: v,
    comparison: c,
    difference: {
      horizonYear: diff(v.horizonYear, c.horizonYear),
      endingBalance: diff(v.endingBalance, c.endingBalance),
      runOutYear: diff(v.runOutYear, c.runOutYear),
      drivers: diffDrivers(v.drivers, c.drivers),
    },
    identity: {
      planned: vYears !== null && cYears !== null && structurallyEqual(vYears, cYears),
      stress:
        stressCacheKeys.viewed === null || stressCacheKeys.comparison === null
          ? null
          : stressCacheKeys.viewed === stressCacheKeys.comparison,
    },
    changes: buildScenarioChangeList(
      viewed.selectedScenarioId,
      comparison.selectedScenarioId,
      viewed.scenarios,
    ),
  };
}
