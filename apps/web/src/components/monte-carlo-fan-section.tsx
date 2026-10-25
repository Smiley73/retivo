/**
 * Fan chart section hosting the `useChartZoom` call and `<ChartZoomReset>`; the Reset button renders at section level
 * so it stays visible during the lazy-Suspense fallback.
 */
import React, { useCallback, useMemo } from 'react';
import { MonteCarloFanChart } from './MonteCarloFanChart';
import { ChartZoomReset } from './ChartZoomReset';
import { useChartZoom } from '../lib/use-chart-zoom';
import type { MonteCarloSummary } from '../lib/monte-carlo';

interface LifeMarker {
  fractionalYear: number;
  label: string;
  color: string;
}

export interface MonteCarloFanSectionProps {
  readonly result: MonteCarloSummary;
  readonly real: boolean;
  readonly retirementYear: number | null;
  /** Canonical `Retires <Mon YYYY>` marker label, threaded to the chart. */
  readonly retirementLabel?: string | null;
  readonly lifeMarkers?: LifeMarker[];
  readonly yScale?: 'linear' | 'log';
}

export const MonteCarloFanSection: React.FC<MonteCarloFanSectionProps> = ({
  result,
  real,
  retirementYear,
  retirementLabel,
  lifeMarkers,
  yScale = 'linear',
}) => {
  // `xDomainFull` mirrors MonteCarloFanChart's row construction: x = year + 1.
  const xDomainFull = useMemo((): [number, number] => {
    const n = result.percentilesReal.p50.length;
    if (n === 0) return [0, 0];
    return [result.firstYear + 1, result.firstYear + n];
  }, [result.firstYear, result.percentilesReal.p50.length]);

  const rowsForY = useMemo(() => {
    const n = result.percentilesReal.p50.length;
    return Array.from({ length: n }, (_, i) => ({ x: result.firstYear + 1 + i }));
  }, [result.firstYear, result.percentilesReal.p50.length]);

  // Visible MC percentile range so the y-axis auto-fits on zoom; i = x - (firstYear + 1).
  const computeY = useCallback(
    (visibleRows: readonly { x: number }[]): [number, number] | null => {
      const percentiles = real ? result.percentilesReal : result.percentilesNominal;
      const bands: number[][] = [
        percentiles.p10, percentiles.p25, percentiles.p50,
      ];
      const vals: number[] = [];
      for (const row of visibleRows) {
        const i = row.x - (result.firstYear + 1);
        if (i < 0) continue;
        for (const band of bands) {
          const v = band[i];
          if (v !== undefined) vals.push(v);
        }
      }
      if (vals.length < 2) return null;
      const yMin = Math.min(...vals);
      const yMax = Math.max(...vals);
      if (yMin === yMax) return null;
      return [yMin, yMax];
    },
    [result, real],
  );

  const zoom = useChartZoom({ xDomainFull, rowsForY, computeY });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <ChartZoomReset isZoomed={zoom.isZoomed} onReset={zoom.reset} />
      </div>
      <MonteCarloFanChart
        result={result}
        real={real}
        retirementYear={retirementYear}
        retirementLabel={retirementLabel}
        lifeMarkers={lifeMarkers}
        yScale={yScale}
        xDomain={zoom.xDomain}
        yDomain={zoom.yDomain}
        dragSelection={zoom.dragSelection}
        mouseHandlers={zoom.mouseHandlers}
        isDragging={zoom.isDragging}
      />
    </div>
  );
};
