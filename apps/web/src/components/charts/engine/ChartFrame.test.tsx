/**
 * Render + interaction test for the SVG ChartFrame engine: series nodes
 * carry the resolved color, markers render at the right place, a hover
 * shows the crosshair + tooltip body, a drag selection renders the
 * marquee, and the frame is a11y-clean.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { ChartFrame } from './ChartFrame';
import type { ChartDatum, MarkerSpec, SeriesSpec } from './types';
import { renderWithTheme, seriesColor } from '../../../test/theme-render';
import { expectNoA11yViolations } from '../../../test/a11y';

const rows: ChartDatum[] = [
  { x: 2026, a: 100, b: 50 },
  { x: 2027, a: 120, b: 60 },
  { x: 2028, a: 140, b: 70 },
];

const series: SeriesSpec[] = [
  { kind: 'area', dataKey: 'a', name: 'Alpha', color: '#112233', stackId: 's', fillOpacity: 0.6 },
  { kind: 'line', dataKey: 'b', name: 'Beta', color: '#445566', strokeWidth: 2 },
];

const markers: MarkerSpec[] = [
  { x: 2027, label: 'Retire 2027', color: '#778899', slot: 0 },
];

function frame(extra: Partial<React.ComponentProps<typeof ChartFrame>> = {}) {
  return (
    <ChartFrame
      rows={rows}
      series={series}
      markers={markers}
      height={320}
      ariaLabel="Test chart"
      xDomain={null}
      xTicks={[2026, 2027, 2028]}
      renderTooltip={(d) => <div role="tooltip">val {d.a}</div>}
      {...extra}
    />
  );
}

describe('ChartFrame', () => {
  it('renders series nodes carrying the resolved color', () => {
    const container = renderWithTheme('light', frame());
    expect(seriesColor(container, 'Alpha', 'fill')).toBe('#112233');
    expect(seriesColor(container, 'Beta', 'stroke')).toBe('#445566');
  });

  it('drops a series named in hiddenSeries and keeps the rest', () => {
    // Hiding by `name` removes that series before the stack/domain are
    // computed, so the legend-filter restacks + rescales for free.
    const container = renderWithTheme(
      'light',
      frame({ hiddenSeries: new Set(['Alpha']) }),
    );
    expect(container.querySelector('path[name="Alpha"]')).toBeNull();
    // The non-hidden line still renders.
    expect(seriesColor(container, 'Beta', 'stroke')).toBe('#445566');
  });

  it('re-fits Y to the visible series when filtered, ignoring an explicit zoom yDomain', () => {
    // A zoomed chart supplies an explicit yDomain computed from the
    // UNFILTERED series. Hiding the tall Alpha area must re-fit Y to Beta's
    // own (much smaller) extent → Beta's path geometry changes.
    const explicit: [number, number] = [0, 1_000_000];
    const betaPath = (hiddenSeries?: Set<string>): string | null =>
      renderWithTheme('light', frame({ yDomain: explicit, hiddenSeries }))
        .querySelector('path[name="Beta"]')!
        .getAttribute('d');
    expect(betaPath(new Set(['Alpha']))).not.toBe(betaPath());
  });

  it('splits a zoned area series into one data-zone path per zone', () => {
    const zoned: SeriesSpec[] = [
      {
        kind: 'area',
        dataKey: 'a',
        name: 'Alpha',
        color: '#112233',
        stackId: 's',
        fillOpacity: 0.6,
        zones: [
          { kind: 'actual', fromX: 2026, toX: 2027, fillOpacity: 0.55 },
          { kind: 'projected', fromX: 2027, toX: 2028, fillOpacity: 0.28 },
        ],
      },
    ];
    const container = renderWithTheme(
      'light',
      <ChartFrame
        rows={rows}
        series={zoned}
        height={320}
        ariaLabel="zoned chart"
        xDomain={null}
        xTicks={[2026, 2027, 2028]}
      />,
    );
    // Each zone renders its own queryable `<path name=… data-zone=…>`.
    expect(
      container.querySelector('path[name="Alpha"][data-zone="actual"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('path[name="Alpha"][data-zone="projected"]'),
    ).not.toBeNull();
  });

  it('renders a single un-zoned area as one path with no data-zone (no behavior change)', () => {
    const container = renderWithTheme('light', frame());
    const path = container.querySelector('path[name="Alpha"]');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('data-zone')).toBeNull();
  });

  it('hides every spec sharing a legendId', () => {
    const specs: SeriesSpec[] = [
      { kind: 'area', dataKey: 'a', name: 'A', color: '#111111', stackId: 's', legendId: 'grp' },
      { kind: 'area', dataKey: 'a2', name: 'A2', color: '#222222', stackId: 's', legendId: 'grp' },
    ];
    const container = renderWithTheme(
      'light',
      <ChartFrame
        rows={[{ x: 2026, a: 1, a2: 2 }, { x: 2027, a: 3, a2: 4 }]}
        series={specs}
        height={320}
        ariaLabel="grp chart"
        xDomain={null}
        xTicks={[2026, 2027]}
        hiddenSeries={new Set(['grp'])}
      />,
    );
    expect(container.querySelector('path[name="A"]')).toBeNull();
    expect(container.querySelector('path[name="A2"]')).toBeNull();
  });

  it('renders an empty plot (no series) when every series is hidden', () => {
    const container = renderWithTheme(
      'light',
      frame({ hiddenSeries: new Set(['Alpha', 'Beta']) }),
    );
    expect(container.querySelector('path[name="Alpha"]')).toBeNull();
    expect(container.querySelector('path[name="Beta"]')).toBeNull();
    // Axes still render — the frame doesn't crash on an empty series set.
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('renders the marker line + label at the marker x', () => {
    const container = renderWithTheme('light', frame());
    const line = container.querySelector('[data-marker-label="Retire 2027"]');
    expect(line).not.toBeNull();
    expect(container.textContent).toContain('Retire 2027');
  });

  it('shows the crosshair + tooltip on pointer-move', () => {
    const container = renderWithTheme('light', frame());
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    vi.spyOn(svg as SVGSVGElement, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 800, height: 320, right: 800, bottom: 320, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    fireEvent.pointerMove(svg as SVGSVGElement, { clientX: 400 });
    expect(container.querySelector('[data-testid="chart-crosshair"]')).not.toBeNull();
    expect(container.querySelector('[role="tooltip"]')).not.toBeNull();
  });

  it('renders the drag marquee for a drag selection', () => {
    const container = renderWithTheme('light', frame({ dragSelection: [2026, 2028] }));
    expect(container.querySelector('[data-testid="chart-drag-marquee"]')).not.toBeNull();
    expect(
      renderWithTheme('light', frame({ dragSelection: null })).querySelector('[data-testid="chart-drag-marquee"]'),
    ).toBeNull();
  });

  // The drag-zoom gesture is mouse + pen only (see use-chart-zoom.ts): a
  // touch pointer must never start or continue a drag, so a finger swipe
  // to scroll the page over the chart can't arm a zoom selection.
  it('ignores touch pointers — touch down/move never reaches the drag handlers', () => {
    const pointerHandlers = {
      onPointerDown: vi.fn(),
      onPointerMove: vi.fn(),
      onPointerUp: vi.fn(),
      onPointerLeave: vi.fn(),
    };
    const container = renderWithTheme('light', frame({ pointerHandlers }));
    const svg = container.querySelector('svg') as SVGSVGElement;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 800, height: 320, right: 800, bottom: 320, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerDown(svg, { clientX: 200, pointerType: 'touch' });
    fireEvent.pointerMove(svg, { clientX: 400, pointerType: 'touch' });
    expect(pointerHandlers.onPointerDown).not.toHaveBeenCalled();
    expect(pointerHandlers.onPointerMove).not.toHaveBeenCalled();
    // No marquee armed by the touch swipe.
    expect(container.querySelector('[data-testid="chart-drag-marquee"]')).toBeNull();

    // Mouse still drives the drag handlers.
    fireEvent.pointerDown(svg, { clientX: 200, pointerType: 'mouse' });
    fireEvent.pointerMove(svg, { clientX: 400, pointerType: 'mouse' });
    expect(pointerHandlers.onPointerDown).toHaveBeenCalledTimes(1);
    expect(pointerHandlers.onPointerMove).toHaveBeenCalledTimes(1);
  });

  it('onPointerCancel runs the same drag-reset cleanup as onPointerLeave', () => {
    const pointerHandlers = {
      onPointerDown: vi.fn(),
      onPointerMove: vi.fn(),
      onPointerUp: vi.fn(),
      onPointerLeave: vi.fn(),
    };
    const container = renderWithTheme('light', frame({ pointerHandlers }));
    const svg = container.querySelector('svg') as SVGSVGElement;
    fireEvent.pointerCancel(svg);
    // A cancelled pointer must reset drag state via the leave path so
    // isDragging/selection can't get stranded.
    expect(pointerHandlers.onPointerLeave).toHaveBeenCalledTimes(1);
  });

  it('is a11y-clean', async () => {
    const container = renderWithTheme('light', frame());
    await expectNoA11yViolations(container);
  });
});
