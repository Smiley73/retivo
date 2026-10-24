/** Per-year balance line chart section: card, log-scale toggle, ProjectionChart and disclaimer caption. */
import React, { useCallback, useMemo } from 'react';
import { ChartInfoPopover } from '../components/ChartInfoPopover';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import {
  ProjectionChart,
  type ProjectionChartRow,
  type ProjectionMethod,
  type RetirementMarker,
} from '../components/ProjectionChart';
import type { CashflowChartMarker } from '../components/CashflowProjectionChart';
import type { TooltipMember } from '../components/tooltip-member';
import { useChartColors } from '../lib/use-chart-tokens';
import type { McBasis } from './balance-projection-page-pipeline';
import { useChartZoom } from '../lib/use-chart-zoom';
import { ChartZoomReset } from '../components/ChartZoomReset';
import type { PlanStressTestVm } from '../components/PlanStressTestSection';
import { BalanceProjectionMcSampleNote } from '../components/BalanceProjectionMcSampleNote';
import { BalanceProjectionHistoricalFallbackNote } from '../components/BalanceProjectionHistoricalFallbackNote';
import {
  CARD_SECTION_CLASS,
  MC_BASIS_LABELS,
  SECTION_H2_CLASS,
} from './balance-projection-page-constants';

export interface BalanceProjectionChartProps {
  readonly rows: ReadonlyArray<ProjectionChartRow>;
  readonly enabledCalculatedMethods: ReadonlySet<Exclude<ProjectionMethod, 'planned'>>;
  readonly retirementMarkers: ReadonlyArray<RetirementMarker>;
  readonly lifeExpectancyMarkers: ReadonlyArray<CashflowChartMarker>;
  readonly tooltipMembers: ReadonlyArray<TooltipMember>;
  readonly yScale: 'linear' | 'log';
  readonly onYScaleChange: (next: 'linear' | 'log') => void;
  /** Drives the representative-run line's tier color and legend label, and gates the inline recalculation status and one-example banner. */
  readonly activeMcBasis?: McBasis | null;
  /** Drives the inline running / error status near the chart; the Recalculate control lives in the page toolbar. */
  readonly stressVm: PlanStressTestVm;
  readonly activeMethod: ProjectionMethod;
  readonly fallbackAccounts: ReadonlyArray<{ id: string; name: string }>;
}

export const BalanceProjectionChartSection: React.FC<BalanceProjectionChartProps> = ({
  rows,
  enabledCalculatedMethods,
  retirementMarkers,
  lifeExpectancyMarkers,
  tooltipMembers,
  yScale,
  onYScaleChange,
  activeMcBasis = null,
  stressVm,
  activeMethod,
  fallbackAccounts,
}) => {
  const chartColors = useChartColors();
  const mcLine = useMemo(() => {
    if (!activeMcBasis) return null;
    const color =
      activeMcBasis === 'mc-typical'
        ? chartColors.mcTypical
        : activeMcBasis === 'mc-pessimistic'
          ? chartColors.mcPessimistic
          : chartColors.mcBadLuck;
    return { color, label: MC_BASIS_LABELS[activeMcBasis] };
  }, [activeMcBasis, chartColors]);

  // Hook lives in the section, not the lazy Inner, so the Reset button can read isZoomed during the Inner's Suspense fallback.
  const xDomainFull = useMemo((): [number, number] => {
    if (rows.length === 0) return [0, 0];
    return [rows[0].x, rows[rows.length - 1].x];
  }, [rows]);

  const rowsForY = useMemo(
    () => rows.map((r) => ({ x: r.x })),
    [rows],
  );

  const computeY = useCallback(
    (visibleRows: readonly { x: number }[]): [number, number] | null => {
      const xs = new Set(visibleRows.map((r) => r.x));
      const visible = rows.filter((r) => xs.has(r.x));
      if (visible.length < 2) return null;
      const vals = visible.flatMap((r) =>
        [r.plannedSolid, r.plannedDashed, r.twrSolid, r.twrDashed, r.mcSolid, r.mcDashed].filter(
          (v): v is number => v !== null && v !== undefined,
        ),
      );
      if (vals.length === 0) return null;
      const yMin = Math.min(...vals);
      const yMax = Math.max(...vals);
      if (yMin === yMax) return null;
      return [yMin, yMax];
    },
    [rows],
  );

  const zoom = useChartZoom({ xDomainFull, rowsForY, computeY });

  return (
    <section className={CARD_SECTION_CLASS} aria-label="Per-year projection">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <h2 className={SECTION_H2_CLASS}>Per-year projection</h2>
          <ChartInfoPopover label="About the Per-year projection chart">
            <p className="m-0">
              Solid line is pre-retirement (contributions + growth). Dashed line
              is the post-retirement drawdown trajectory under each method,
              ending at the last household member&apos;s projected end of life.
              Totals in the section below show the balance at the actual
              retirement date.
            </p>
          </ChartInfoPopover>
        </div>
        <div className="report-print-hide flex flex-wrap items-center gap-2">
          {activeMcBasis && (
            <>
              {/* Lightweight inline feedback: polite while running, assertive on error; the full progress bar and Cancel stay in the outcomes-card status row. */}
              {stressVm.isRunning && (
                <span
                  className="text-sm text-muted"
                  role="status"
                  aria-live="polite"
                >
                  Recalculating…
                </span>
              )}
              {stressVm.error && (
                <span className="text-sm text-negative" role="alert">
                  Stress-test failed: {stressVm.error}
                </span>
              )}
            </>
          )}
          <ChartZoomReset isZoomed={zoom.isZoomed} onReset={zoom.reset} />
          <SegmentedRadioGroup<'linear' | 'log'>
            size="sm"
            ariaLabel="Y-axis scale"
            value={yScale}
            onChange={onYScaleChange}
            options={[
              { value: 'linear', label: 'Linear' },
              { value: 'log', label: 'Log' },
            ]}
          />
        </div>
      </div>
      {activeMcBasis && <BalanceProjectionMcSampleNote />}
      <ProjectionChart
        rows={[...rows]}
        enabledCalculatedMethods={
          new Set(enabledCalculatedMethods)
        }
        retirementMarkers={[...retirementMarkers]}
        lifeExpectancyMarkers={[...lifeExpectancyMarkers]}
        tooltipMembers={[...tooltipMembers]}
        yScale={yScale}
        xDomain={zoom.xDomain}
        yDomain={zoom.yDomain}
        dragSelection={zoom.dragSelection}
        mouseHandlers={zoom.mouseHandlers}
        isDragging={zoom.isDragging}
        mcLine={mcLine}
      />
      {activeMethod === 'twr' && !activeMcBasis && fallbackAccounts.length > 0 && (
        <BalanceProjectionHistoricalFallbackNote accounts={fallbackAccounts} />
      )}
    </section>
  );
};
