/**
 * Balance Projection page — stat-card sibling. Renders two distinct
 * blocks:
 *
 *   1. A 4-up deterministic KPI grid (`StatGrid cols="four"`): Planned ·
 *      at retirement, Planned · at horizon, TWR · at retirement, TWR · at
 *      horizon — the four headline deterministic balances (the Graphite
 *      Spectrum `.kpi` mock). At-retirement tiles are neutral; at-horizon
 *      tiles tint green when funded (> $0) / red when depleted (≤ $0).
 *   2. A separate "Monte Carlo outcomes" section: a small heading +
 *      caption, then the three percentile tiers (Typical / Pessimistic /
 *      Bad-luck) as dedicated `<BalanceProjectionMcCard>`s in a 3-up grid,
 *      two rows (At retirement / At horizon).
 *
 * Extracted from BalanceProjectionPage.tsx to keep the page itself under
 * the file shape cap. The MC numbers come from the existing
 * `PlanStressTestVm` percentile fields — this is a presentation re-skin,
 * not a new computation. The at-horizon Today's-dollar arithmetic routes
 * through the shared `computePlannedAtHorizonToday` helper — same
 * source of truth the optimizer and the BPP runner consume.
 */
import React from 'react';
import type { PlanStressTestVm } from '../components/PlanStressTestSection';
import { Stat, StatGrid } from '../components/StatGrid';
import { ChartInfoPopover } from '../components/ChartInfoPopover';
import { McProgressBar } from '../components/McProgressBar';
import { formatCurrencyShort } from '../lib/format-currency';
import { computePlannedAtHorizonToday } from '../lib/balance-projection-runner';
import { horizonStatus } from '../lib/horizon-status';
import type { ProjectionMethod } from '../components/ProjectionChart';
import type { DrawdownYear } from '../lib/drawdown-engine';
import {
  BalanceProjectionMcCard,
  type McTier,
} from './balance-projection-mc-card';

interface BalanceProjectionMethodTotal {
  readonly total: number;
  /** Count of accounts included at their planned rate under
   *  the Historical method (lack ≥2 yr empirical history). Was the prior
   *  "excluded from total" count. */
  readonly plannedRateCount: number;
}

export interface BalanceProjectionStatsProps {
  readonly methodOrder: ReadonlyArray<ProjectionMethod>;
  readonly methodLabels: Readonly<Record<ProjectionMethod, string>>;
  readonly displayedTotals: Record<ProjectionMethod, BalanceProjectionMethodTotal> | null;
  readonly enabledCalculatedMethods: ReadonlySet<Exclude<ProjectionMethod, 'planned'>>;
  readonly drawdownByMethod: Record<
    ProjectionMethod,
    {
      readonly years: ReadonlyArray<DrawdownYear>;
      readonly depletionYear: number | null;
    } | null
  > | null;
  readonly retirementYear: number | null;
  readonly cashflowFromYear: number | null;
  readonly lastDeathYear: number | null;
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  readonly stressVm: PlanStressTestVm;
  /**
   * Primary household member's birth year — used to render MC depletion
   * ages ("Depletes — age N"). `null` when no member has a usable
   * birthdate; the MC card then falls back to the depletion year.
   */
  readonly primaryBirthYear: number | null;
}

/** Compute the at-horizon Today's-dollar balance for a deterministic
 *  method, or `null` when its drawdown didn't run. */
function atHorizonToday(
  dd: { readonly years: ReadonlyArray<DrawdownYear> } | null,
  horizonYear: number | null,
  viewDeflator: (year: number, monthIndex?: number) => number,
): number | null {
  if (!dd || dd.years.length === 0) return null;
  const factor = horizonYear !== null ? viewDeflator(horizonYear, 11) : 1;
  // Same arithmetic, behind a function boundary shared with the
  // runner — parity test pins both paths to one source of truth.
  return computePlannedAtHorizonToday({
    drawdownPlannedYears: dd.years,
    factor,
  });
}

const MC_TIERS: ReadonlyArray<McTier> = ['typical', 'pessimistic', 'badluck'];

export const BalanceProjectionStats: React.FC<BalanceProjectionStatsProps> = ({
  methodOrder,
  methodLabels,
  displayedTotals,
  enabledCalculatedMethods,
  drawdownByMethod,
  retirementYear,
  cashflowFromYear,
  lastDeathYear,
  viewDeflator,
  stressVm,
  primaryBirthYear,
}) => {
  const horizonYearFor = (
    dd: { readonly years: ReadonlyArray<DrawdownYear> } | null,
  ): number | null => {
    if (!dd) return null;
    return cashflowFromYear !== null
      ? cashflowFromYear + dd.years.length - 1
      : (retirementYear ?? 0) + dd.years.length - 1;
  };

  // MC ending balance + depletion year per tier, keyed for the row map.
  const mcEnding: Record<McTier, number | null> = {
    typical: stressVm.endTypical,
    pessimistic: stressVm.endPessimistic,
    badluck: stressVm.endBadLuck,
  };
  const mcStart: Record<McTier, number | null> = {
    typical: stressVm.startTypical,
    pessimistic: stressVm.startPessimistic,
    badluck: stressVm.startBadLuck,
  };
  const mcDepletionYear: Record<McTier, number | null> = {
    typical: stressVm.typicalDepletionYear,
    pessimistic: stressVm.pessimisticDepletionYear,
    badluck: stressVm.badLuckDepletionYear,
  };

  const depletionAge = (year: number | null): number | null =>
    year !== null && primaryBirthYear !== null ? year - primaryBirthYear : null;

  return (
    <>
      {displayedTotals && drawdownByMethod && (
        <StatGrid className="mt-4" cols="four">
          {methodOrder.map((m) => {
            const t = displayedTotals[m];
            const dd = drawdownByMethod[m];
            const showTotal = m === 'planned' || enabledCalculatedMethods.has(m);
            const atRetirement =
              showTotal && t.total > 0 ? formatCurrencyShort(t.total) : '—';
            const horizonValue = showTotal
              ? atHorizonToday(dd, horizonYearFor(dd), viewDeflator)
              : null;
            const atHorizon =
              horizonValue !== null ? formatCurrencyShort(horizonValue) : '—';
            // At horizon: green when the plan still has money, red when it
            // has run dry (≤ $0); neutral when there's no value to show.
            // At retirement carries no value-based colour.
            const horizonColor =
              horizonValue == null
                ? undefined
                : horizonValue > 0
                  ? 'text-positive'
                  : 'text-negative';
            return (
              <React.Fragment key={m}>
                <Stat
                  label={`${methodLabels[m]} · at retirement`}
                  value={atRetirement}
                />
                <Stat
                  label={`${methodLabels[m]} · at horizon`}
                  value={atHorizon}
                  valueClassName={horizonColor}
                />
              </React.Fragment>
            );
          })}
        </StatGrid>
      )}

      {!stressVm.hasNoAccounts && (
        <section
          className={`mt-6 transition-opacity duration-150 ${
            stressVm.isStale || stressVm.isRunning ? 'opacity-50' : 'opacity-100'
          }`}
          aria-labelledby="mc-outcomes-heading"
          aria-busy={stressVm.isStale || stressVm.isRunning}
        >
          <div className="flex items-center gap-1.5">
            <h3 id="mc-outcomes-heading" className="m-0 text-base font-bold text-ink">
              Monte Carlo outcomes
            </h3>
            <ChartInfoPopover label="About Monte Carlo outcomes">
              <p className="m-0">
                Projected portfolio value across simulated market histories,
                from a Typical outcome to increasingly unlucky ones
                (Pessimistic, Bad-luck).
              </p>
            </ChartInfoPopover>
          </div>
          {/* At retirement row — always-positive balances, no status line. */}
          <StatGrid className="mt-2 mb-3" cols="three">
            {MC_TIERS.map((tier) => (
              <BalanceProjectionMcCard
                key={`ret-${tier}`}
                scope="At retirement"
                tier={tier}
                value={mcStart[tier]}
              />
            ))}
          </StatGrid>
          {/* At horizon row — funded/depleted status per tier. */}
          <StatGrid cols="three">
            {MC_TIERS.map((tier) => {
              const end = mcEnding[tier];
              const dep = mcDepletionYear[tier];
              const status = horizonStatus({
                balance: end,
                depletionYear: dep,
                lastDeathYear,
              });
              return (
                <BalanceProjectionMcCard
                  key={`hor-${tier}`}
                  scope="At horizon"
                  tier={tier}
                  value={end}
                  status={{
                    funded: !status.isDanger,
                    depletionAge: depletionAge(dep),
                    depletionYear: dep,
                  }}
                />
              );
            })}
          </StatGrid>
          <GuardrailsComparisonCallout comparison={stressVm.guardrailComparison} />
        </section>
      )}
    </>
  );
};

/**
 * With-vs-without spending-guardrails success-probability callout.
 * Rendered only when the active scenario ENABLES the guardrail (the
 * `comparison` prop is present). The delta is shown as signal only when it
 * exceeds the paired sampling standard error; below that it renders "about the
 * same" rather than false signal. Handles pending / error states.
 */
/** Seed-paired with/without-guardrails callout. Exported for
 *  render testing of its five branches. Renders nothing when the
 *  comparison is absent. */
export const GuardrailsComparisonCallout: React.FC<{
  comparison: PlanStressTestVm['guardrailComparison'];
}> = ({ comparison }) => {
  if (comparison === undefined) return null;
  const pct = (v: number | null): string =>
    v === null ? '—' : `${Math.round(v * 100)}%`;

  if (comparison.state === 'pending') {
    // The sibling (without-guardrails) run is a separate MC pass whose per-path
    // progress isn't threaded into this VM, so the bar runs INDETERMINATE
    // (total 0 → animated sweep) — it reads as "working" without a misleading
    // 0%. The verbatim comparing-copy rides the bar's own label line.
    return (
      <div className="mt-3" role="status" aria-live="polite">
        <McProgressBar
          done={0}
          total={0}
          label="Comparing your plan's odds with and without spending guardrails"
          className="flex w-full flex-col gap-1"
        />
      </div>
    );
  }
  if (comparison.state === 'error') {
    return (
      <p className="mt-3 text-sm text-muted">
        Couldn't compare your plan with and without guardrails this time.
      </p>
    );
  }

  const { withPct, withoutPct, deltaPct, se } = comparison;
  if (withPct === null || withoutPct === null || deltaPct === null || se === null) {
    return null;
  }
  // Only treat the delta as signal when it clears the conservative
  // unpaired-SE bound (an upper bound on the true paired SE; see the
  // buildGuardrailComparison docstring).
  const meaningful = Math.abs(deltaPct) > se;
  return (
    <div className="mt-3 rounded-lg border border-line bg-surface-raised px-4 py-3 text-sm">
      {!meaningful ? (
        <span className="text-muted">
          Spending guardrails leave your plan's odds about the same (
          {pct(withoutPct)} without, {pct(withPct)} with).
        </span>
      ) : deltaPct > 0 ? (
        <span className="text-ink">
          Spending guardrails raise your plan's success from{' '}
          <strong>{pct(withoutPct)}</strong> to <strong className="text-positive">{pct(withPct)}</strong>.
        </span>
      ) : (
        <span className="text-ink">
          With spending guardrails your plan's success is{' '}
          <strong>{pct(withPct)}</strong> versus <strong>{pct(withoutPct)}</strong> without.
        </span>
      )}
    </div>
  );
};
