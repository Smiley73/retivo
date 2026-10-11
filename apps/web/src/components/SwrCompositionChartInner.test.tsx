/**
 * Tests for `SwrCompositionChartInner`.
 *
 * What is specific to this chart: the four
 * layers actually stack in order (asserted on rendered path geometry,
 * not props — reading the series specs back cannot tell a stack from four
 * overlaid areas), hiding both income series through the legend restacks
 * the after-tax draw onto the baseline, both rule lines are drawn from the
 * axis and stay inside the plotted Y range regardless of the stack beneath
 * them (level when the rows carry a level value, rising when the active
 * dollar mode makes the rows themselves rise), the
 * partial transition year is excluded from the rule comparison, the
 * depletion marker and its tooltip note, the two conditional layers
 * (otherIncome, tax) appear/disappear independently and never leave a
 * blank frame when one of them disappears while isolated, a zero mid-series
 * otherIncome year pinches to no visible segment without disturbing the
 * layers above it, tooltip content/precision, theme colour flips, an
 * empty-series guard, and a11y.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import InnerChart, { makeTooltip } from './SwrCompositionChartInner';
import type { SwrComparisonYearRow } from './SwrCompositionChart';
import { renderWithTheme, seriesColor, ThemeWrapper } from '../test/theme-render';
import { expectNoA11yViolations } from '../test/a11y';
import { CHART_COLORS, CHART_CHROME } from '../lib/tokens';
import type { ChartDatum } from './charts';

const GUARANTEED = 'Guaranteed income';
const OTHER = 'Other income';
const DRAW = 'Portfolio withdrawal (after tax)';
const TAX = 'Tax on that withdrawal';
const FOUR_PCT = '4% rule';
const FOUR_HALF_PCT = '4.5% rule';
const DEPLETION_LABEL = 'Portfolio depleted';
const COMPARISON_LABEL = 'Comparison starts';

const FRAME_NAME = 'Spending composition and safe withdrawal rate chart';

const PARTIAL_YEAR_NOTE =
  "This year is a part-year total and isn't compared against the rules.";
const POST_DEPLETION_NOTE =
  "These layers are the year's planned spending, not spending the portfolio can fund.";

/** A fixture whose all four layers differ year to year — a flat-line or
 *  overlaid-area assertion can't be satisfied by accident against this. */
const VARYING_ROWS: SwrComparisonYearRow[] = [
  {
    year: 2032,
    guaranteedIncome: 30_000,
    otherIncome: 5_000,
    afterTaxDraw: 40_000,
    tax: 8_000,
    guaranteedIncomeSplit: { socialSecurity: 20_000, pension: 10_000 },
    guaranteedIncomeSurplus: 1_500,
    fourPercentRuleValue: 40_000,
    fourPointFivePercentRuleValue: 45_000,
    isPartialYear: false,
  },
  {
    year: 2033,
    guaranteedIncome: 32_000,
    otherIncome: 6_000,
    afterTaxDraw: 45_000,
    tax: 9_000,
    guaranteedIncomeSplit: { socialSecurity: 21_000, pension: 11_000 },
    guaranteedIncomeSurplus: 0,
    fourPercentRuleValue: 40_000,
    fourPointFivePercentRuleValue: 45_000,
    isPartialYear: false,
  },
  {
    year: 2034,
    guaranteedIncome: 31_000,
    otherIncome: 4_000,
    afterTaxDraw: 50_000,
    tax: 10_000,
    guaranteedIncomeSplit: { socialSecurity: 20_500, pension: 10_500 },
    guaranteedIncomeSurplus: 0,
    fourPercentRuleValue: 40_000,
    fourPointFivePercentRuleValue: 45_000,
    isPartialYear: false,
  },
];

/** Parse an SVG path's `d="M x,y L x,y ... Z"` into its (x, y) points. */
function parsePathPoints(d: string): Array<{ x: number; y: number }> {
  return Array.from(d.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)).map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));
}

function linePoints(container: HTMLElement, name: string): Array<{ x: number; y: number }> {
  const path = container.querySelector(`path[name="${name}"]`);
  if (!path) throw new Error(`series "${name}" path not found`);
  return parsePathPoints(path.getAttribute('d') ?? '');
}

/** A stacked-area path's `d` is the top edge (one point per row, forward)
 *  followed by the base edge (one point per row, reversed) then `Z` —
 *  `areaPath()` in `charts/engine/scales.ts`. Split it back into per-row
 *  top/base pixel points, in row order, so a test can assert on the
 *  ACTUAL rendered stacking geometry rather than the series props. */
function areaLayer(
  container: HTMLElement,
  name: string,
): { top: Array<{ x: number; y: number }>; base: Array<{ x: number; y: number }> } {
  const path = container.querySelector(`path[name="${name}"]`);
  if (!path) throw new Error(`series "${name}" path not found`);
  const pts = parsePathPoints(path.getAttribute('d') ?? '');
  const n = pts.length / 2;
  return { top: pts.slice(0, n), base: pts.slice(n).reverse() };
}

/** Mirrors `SafeWithdrawalRateChartInner.test.tsx`'s `hoverTooltip` helper. */
function hoverTooltip(container: HTMLElement): HTMLElement {
  const svg = container.querySelector('svg') as SVGSVGElement;
  Object.defineProperty(svg, 'getBoundingClientRect', {
    value: () => ({
      x: 0,
      y: 0,
      width: 600,
      height: 320,
      top: 0,
      left: 0,
      right: 600,
      bottom: 320,
      toJSON: () => ({}),
    }),
    configurable: true,
  });
  fireEvent.pointerMove(svg, { clientX: 40 });
  const tip = container.querySelector('[role="tooltip"]') as HTMLElement;
  expect(tip).not.toBeNull();
  return tip;
}

/** Build a flattened `ChartDatum` matching `SwrCompositionChartInner`'s
 *  internal `FlatRow` shape, for exercising the exported `makeTooltip`
 *  directly without simulating a pointer hover (mirrors
 *  `SafeWithdrawalRateChartInner.test.tsx`). */
function flatDatum(over: {
  year: number;
  guaranteedIncome?: number;
  otherIncome?: number;
  afterTaxDraw?: number;
  tax?: number;
  socialSecurity?: number;
  pension?: number;
  guaranteedIncomeSurplus?: number;
  fourPercentRuleValue?: number | null;
  fourPointFivePercentRuleValue?: number | null;
  isPartialYear?: 0 | 1;
}): ChartDatum {
  return {
    x: over.year,
    year: over.year,
    guaranteedIncome: over.guaranteedIncome ?? 0,
    otherIncome: over.otherIncome ?? 0,
    afterTaxDraw: over.afterTaxDraw ?? 0,
    tax: over.tax ?? 0,
    socialSecurity: over.socialSecurity ?? 0,
    pension: over.pension ?? 0,
    guaranteedIncomeSurplus: over.guaranteedIncomeSurplus ?? 0,
    fourPercentRuleValue: over.fourPercentRuleValue ?? null,
    fourPointFivePercentRuleValue: over.fourPointFivePercentRuleValue ?? null,
    isPartialYear: over.isPartialYear ?? 0,
  };
}

describe('SwrCompositionChartInner — stacking (order)', () => {
  it('stacks each layer offset by the sum of the layers below it, bottom to top', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={VARYING_ROWS} depletionYear={null} members={[]} />,
    );
    const guaranteed = areaLayer(container, GUARANTEED);
    const other = areaLayer(container, OTHER);
    const draw = areaLayer(container, DRAW);
    const tax = areaLayer(container, TAX);

    // Bottom layer's base is the zero baseline — constant across every row.
    expect(new Set(guaranteed.base.map((p) => p.y)).size).toBe(1);

    for (let i = 0; i < VARYING_ROWS.length; i++) {
      // Each layer's base is exactly the layer below it's top — the chain
      // that proves a real stack, not four overlaid areas each based at 0.
      expect(other.base[i].y).toBeCloseTo(guaranteed.top[i].y, 2);
      expect(draw.base[i].y).toBeCloseTo(other.top[i].y, 2);
      expect(tax.base[i].y).toBeCloseTo(draw.top[i].y, 2);
      // Every layer has real (upward, smaller-y-is-higher) thickness here.
      expect(guaranteed.top[i].y).toBeLessThan(guaranteed.base[i].y);
      expect(other.top[i].y).toBeLessThan(other.base[i].y);
      expect(draw.top[i].y).toBeLessThan(draw.base[i].y);
      expect(tax.top[i].y).toBeLessThan(tax.base[i].y);
    }
  });

  it('restacks the after-tax draw layer onto the baseline when both income layers are hidden', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={VARYING_ROWS} depletionYear={null} members={[]} />,
    );
    const baselineY = areaLayer(container, GUARANTEED).base[0].y;

    // Isolate-first legend semantics: isolate "Portfolio withdrawal (after
    // tax)", then re-enable everything except the two income layers.
    fireEvent.click(screen.getByRole('button', { name: DRAW }));
    fireEvent.click(screen.getByRole('button', { name: TAX }));
    fireEvent.click(screen.getByRole('button', { name: FOUR_PCT }));
    fireEvent.click(screen.getByRole('button', { name: FOUR_HALF_PCT }));

    const draw = areaLayer(container, DRAW);
    for (const p of draw.base) {
      expect(p.y).toBeCloseTo(baselineY, 2);
    }
  });
});

describe('SwrCompositionChartInner — rule lines (boundary)', () => {
  it('draws each rule line from the axis, level across every compared year when the rows carry a level value', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={VARYING_ROWS} depletionYear={null} members={[]} />,
    );
    const fourPct = linePoints(container, FOUR_PCT);
    const fourHalfPct = linePoints(container, FOUR_HALF_PCT);
    expect(fourPct).toHaveLength(VARYING_ROWS.length);
    expect(fourHalfPct).toHaveLength(VARYING_ROWS.length);
    // The stack composition (guaranteed/other/draw/tax) differs every row in
    // this fixture; a line measured from a stacked offset would move with
    // it. It doesn't — every plotted y is identical.
    expect(new Set(fourPct.map((p) => p.y)).size).toBe(1);
    expect(new Set(fourHalfPct.map((p) => p.y)).size).toBe(1);
  });

  // The level line above is a property of the ROWS, not of this component.
  // The row builder holds the rule flat in REAL terms and re-expresses it into the
  // active dollar mode, so under Future-dollars the values it hands over
  // rise with inflation exactly as the draw and income layers do. A chart
  // that clamped the line level would then compare a later year's nominal
  // draw against a retirement-year rule figure.
  it('rises with the rows when the active dollar mode inflates the rule value, still measured from the axis', () => {
    const rows: SwrComparisonYearRow[] = [2032, 2033, 2034].map((year, i) => ({
      year,
      guaranteedIncome: 30_000,
      otherIncome: 0,
      afterTaxDraw: 40_000 + i * 5_000,
      tax: 8_000,
      guaranteedIncomeSplit: { socialSecurity: 30_000, pension: 0 },
      guaranteedIncomeSurplus: 0,
      // 40,000 / 45,000 real, re-expressed forward at 3% inflation.
      fourPercentRuleValue: 40_000 * 1.03 ** i,
      fourPointFivePercentRuleValue: 45_000 * 1.03 ** i,
      isPartialYear: false,
    }));
    const container = renderWithTheme(
      'light',
      <InnerChart rows={rows} depletionYear={null} members={[]} />,
    );
    // The bottom layer's base IS the zero axis, and its top is a known
    // dollar figure — together they give the plot's pixels-per-dollar
    // without assuming anything about the fitted Y domain.
    const guaranteed = areaLayer(container, GUARANTEED);
    const zeroY = guaranteed.base[0].y;
    const pxPerDollar = (zeroY - guaranteed.top[0].y) / rows[0].guaranteedIncome;

    const cases = [
      { name: FOUR_PCT, values: rows.map((r) => r.fourPercentRuleValue ?? 0) },
      { name: FOUR_HALF_PCT, values: rows.map((r) => r.fourPointFivePercentRuleValue ?? 0) },
    ];
    for (const { name, values } of cases) {
      const points = linePoints(container, name);
      expect(points).toHaveLength(rows.length);
      // Not clamped level: each year sits strictly higher (smaller y).
      for (let i = 1; i < points.length; i++) {
        expect(points[i].y).toBeLessThan(points[i - 1].y);
      }
      // And every plotted y is that row's RAW value measured from the axis —
      // no stacked offset, no re-derivation of its own.
      values.forEach((value, i) => {
        expect(points[i].y).toBeCloseTo(zeroY - value * pxPerDollar, 1);
      });
    }
  });

  it('keeps a rule line far above the whole stack inside the plotted Y range (never hLineY)', () => {
    const rows: SwrComparisonYearRow[] = [
      {
        year: 2032,
        guaranteedIncome: 20_000,
        otherIncome: 0,
        afterTaxDraw: 30_000,
        tax: 5_000,
        guaranteedIncomeSplit: { socialSecurity: 20_000, pension: 0 },
        guaranteedIncomeSurplus: 0,
        fourPercentRuleValue: 900_000,
        fourPointFivePercentRuleValue: 950_000,
        isPartialYear: false,
      },
      {
        year: 2033,
        guaranteedIncome: 21_000,
        otherIncome: 0,
        afterTaxDraw: 32_000,
        tax: 5_500,
        guaranteedIncomeSplit: { socialSecurity: 21_000, pension: 0 },
        guaranteedIncomeSurplus: 0,
        fourPercentRuleValue: 900_000,
        fourPointFivePercentRuleValue: 950_000,
        isPartialYear: false,
      },
    ];
    const height = 320;
    const container = renderWithTheme(
      'light',
      <InnerChart rows={rows} depletionYear={null} members={[]} />,
    );
    for (const name of [FOUR_PCT, FOUR_HALF_PCT]) {
      const points = linePoints(container, name);
      expect(points.length).toBeGreaterThan(0);
      for (const p of points) {
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(height);
      }
    }
  });
});

describe('SwrCompositionChartInner — partial transition year', () => {
  const PARTIAL_ROWS: SwrComparisonYearRow[] = [
    {
      year: 2032,
      guaranteedIncome: 10_000,
      otherIncome: 0,
      afterTaxDraw: 15_000,
      tax: 2_000,
      guaranteedIncomeSplit: { socialSecurity: 10_000, pension: 0 },
      guaranteedIncomeSurplus: 0,
      fourPercentRuleValue: null,
      fourPointFivePercentRuleValue: null,
      isPartialYear: true,
    },
    {
      year: 2033,
      guaranteedIncome: 20_000,
      otherIncome: 0,
      afterTaxDraw: 30_000,
      tax: 5_000,
      guaranteedIncomeSplit: { socialSecurity: 20_000, pension: 0 },
      guaranteedIncomeSurplus: 0,
      fourPercentRuleValue: 40_000,
      fourPointFivePercentRuleValue: 45_000,
      isPartialYear: false,
    },
    {
      year: 2034,
      guaranteedIncome: 22_000,
      otherIncome: 0,
      afterTaxDraw: 33_000,
      tax: 5_500,
      guaranteedIncomeSplit: { socialSecurity: 22_000, pension: 0 },
      guaranteedIncomeSurplus: 0,
      fourPercentRuleValue: 40_000,
      fourPointFivePercentRuleValue: 45_000,
      isPartialYear: false,
    },
  ];

  it('excludes the partial year: one fewer plotted point per rule line, starting at the first compared year, with the comparison-start marker', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={PARTIAL_ROWS} depletionYear={null} members={[]} />,
    );
    const fourPct = linePoints(container, FOUR_PCT);
    expect(fourPct).toHaveLength(PARTIAL_ROWS.length - 1);
    expect(linePoints(container, FOUR_HALF_PCT)).toHaveLength(PARTIAL_ROWS.length - 1);

    // The rule line's first plotted x matches the after-tax draw area's
    // SECOND row (the first compared year), not its first (the partial year).
    const draw = areaLayer(container, DRAW);
    expect(fourPct[0].x).toBeCloseTo(draw.top[1].x, 2);
    expect(fourPct[0].x).not.toBeCloseTo(draw.top[0].x, 2);

    expect(
      container.querySelector(`[data-marker-label="${COMPARISON_LABEL}"]`),
    ).not.toBeNull();
  });

  it("carries the partial-year note on that point's tooltip and not on a later year's", () => {
    const tooltip = makeTooltip(CHART_COLORS.light, CHART_CHROME.light, null);
    const partialNode = tooltip(flatDatum({ year: 2032, isPartialYear: 1 }));
    const laterNode = tooltip(flatDatum({ year: 2033, isPartialYear: 0 }));
    const partial = render(<>{partialNode}</>);
    expect(partial.getByText(PARTIAL_YEAR_NOTE)).toBeInTheDocument();
    partial.unmount();
    const later = render(<>{laterNode}</>);
    expect(later.queryByText(PARTIAL_YEAR_NOTE)).toBeNull();
  });
});

describe('SwrCompositionChartInner — depletion marker', () => {
  it('renders at the supplied year and not at all when the prop is null', () => {
    const withDepletion = renderWithTheme(
      'light',
      <InnerChart rows={VARYING_ROWS} depletionYear={2034} members={[]} />,
    );
    expect(
      withDepletion.querySelector(`[data-marker-label="${DEPLETION_LABEL}"]`),
    ).not.toBeNull();

    const withoutDepletion = renderWithTheme(
      'light',
      <InnerChart rows={VARYING_ROWS} depletionYear={null} members={[]} />,
    );
    expect(
      withoutDepletion.querySelector(`[data-marker-label="${DEPLETION_LABEL}"]`),
    ).toBeNull();
  });

  it('notes that a year at or after depletion is planned spending the portfolio cannot fund', () => {
    const tooltip = makeTooltip(CHART_COLORS.light, CHART_CHROME.light, 2034);
    const atDepletion = tooltip(flatDatum({ year: 2034 }));
    const before = tooltip(flatDatum({ year: 2033 }));
    const atRender = render(<>{atDepletion}</>);
    expect(atRender.getByText(POST_DEPLETION_NOTE)).toBeInTheDocument();
    atRender.unmount();
    const beforeRender = render(<>{before}</>);
    expect(beforeRender.queryByText(POST_DEPLETION_NOTE)).toBeNull();
  });
});

describe('SwrCompositionChartInner — conditional layers', () => {
  it('omits the "Other income" series/legend entirely when every row is zero, and shows it once one year is non-zero', () => {
    const zeroOther: SwrComparisonYearRow[] = VARYING_ROWS.map((r) => ({
      ...r,
      otherIncome: 0,
    }));
    const withoutOther = renderWithTheme(
      'light',
      <InnerChart rows={zeroOther} depletionYear={null} members={[]} />,
    );
    expect(withoutOther.querySelector(`path[name="${OTHER}"]`)).toBeNull();
    expect(within(withoutOther).queryByText(OTHER)).toBeNull();
    // The tax layer (independently non-zero in this fixture) is unaffected.
    expect(withoutOther.querySelector(`path[name="${TAX}"]`)).not.toBeNull();

    const oneYearOther = zeroOther.map((r, i) => (i === 1 ? { ...r, otherIncome: 2_000 } : r));
    const withOther = renderWithTheme(
      'light',
      <InnerChart rows={oneYearOther} depletionYear={null} members={[]} />,
    );
    expect(withOther.querySelector(`path[name="${OTHER}"]`)).not.toBeNull();
    expect(within(withOther).queryByText(OTHER)).not.toBeNull();
  });

  it('omits the "Tax on that withdrawal" series/legend entirely when every row is zero, and shows it once one year is non-zero', () => {
    const zeroTax: SwrComparisonYearRow[] = VARYING_ROWS.map((r) => ({ ...r, tax: 0 }));
    const withoutTax = renderWithTheme(
      'light',
      <InnerChart rows={zeroTax} depletionYear={null} members={[]} />,
    );
    expect(withoutTax.querySelector(`path[name="${TAX}"]`)).toBeNull();
    expect(within(withoutTax).queryByText(TAX)).toBeNull();
    // The other-income layer (independently non-zero in this fixture) is unaffected.
    expect(withoutTax.querySelector(`path[name="${OTHER}"]`)).not.toBeNull();

    const oneYearTax = zeroTax.map((r, i) => (i === 1 ? { ...r, tax: 1_500 } : r));
    const withTax = renderWithTheme(
      'light',
      <InnerChart rows={oneYearTax} depletionYear={null} members={[]} />,
    );
    expect(withTax.querySelector(`path[name="${TAX}"]`)).not.toBeNull();
    expect(within(withTax).queryByText(TAX)).not.toBeNull();
  });
});

describe('SwrCompositionChartInner — an isolated conditional layer that then disappears', () => {
  // Isolating a legend entry records every OTHER series as hidden, and
  // `useSeriesVisibility` prunes stale keys only on the next click. So when
  // the isolated series is one of the two conditional layers and the same
  // mounted chart is then handed rows that no longer carry it (a basis swap
  // under the parent), the series that survive are exactly the hidden ones —
  // a blank frame under a legend with every entry struck through.
  function isolateThenDrop(
    isolated: string,
    rowsWithout: SwrComparisonYearRow[],
  ): { container: HTMLElement; legendButtons: HTMLElement[] } {
    const { container, rerender, getAllByRole } = render(
      <InnerChart rows={VARYING_ROWS} depletionYear={null} members={[]} />,
      { wrapper: ThemeWrapper },
    );
    fireEvent.click(within(container).getByRole('button', { name: isolated }));
    rerender(<InnerChart rows={rowsWithout} depletionYear={null} members={[]} />);
    return { container, legendButtons: getAllByRole('button') };
  }

  it('keeps drawing the remaining series when the isolated "Other income" layer goes to zero everywhere', () => {
    const { container, legendButtons } = isolateThenDrop(
      OTHER,
      VARYING_ROWS.map((r) => ({ ...r, otherIncome: 0 })),
    );
    expect(container.querySelector(`path[name="${OTHER}"]`)).toBeNull();
    for (const name of [GUARANTEED, DRAW, TAX, FOUR_PCT, FOUR_HALF_PCT]) {
      expect(linePoints(container, name).length).toBeGreaterThan(0);
    }
    // ... and the legend says so: nothing is left marked hidden.
    expect(legendButtons.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  });

  it('keeps drawing the remaining series when the isolated tax layer goes to zero everywhere', () => {
    const { container, legendButtons } = isolateThenDrop(
      TAX,
      VARYING_ROWS.map((r) => ({ ...r, tax: 0 })),
    );
    expect(container.querySelector(`path[name="${TAX}"]`)).toBeNull();
    for (const name of [GUARANTEED, OTHER, DRAW, FOUR_PCT, FOUR_HALF_PCT]) {
      expect(linePoints(container, name).length).toBeGreaterThan(0);
    }
    expect(legendButtons.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  });

  it('keeps hiding the series still emitted when a hidden layer disappears but others stay visible', () => {
    const { container, rerender } = render(
      <InnerChart rows={VARYING_ROWS} depletionYear={null} members={[]} />,
      { wrapper: ThemeWrapper },
    );
    // Isolate the draw, then re-enable the tax layer: "Other income",
    // "Guaranteed income" and both rule lines stay hidden.
    fireEvent.click(within(container).getByRole('button', { name: DRAW }));
    fireEvent.click(within(container).getByRole('button', { name: TAX }));
    rerender(
      <InnerChart
        rows={VARYING_ROWS.map((r) => ({ ...r, otherIncome: 0 }))}
        depletionYear={null}
        members={[]}
      />,
    );
    // The orphaned "Other income" key is dropped without disturbing the rest.
    expect(linePoints(container, DRAW).length).toBeGreaterThan(0);
    expect(linePoints(container, TAX).length).toBeGreaterThan(0);
    expect(container.querySelector(`path[name="${GUARANTEED}"]`)).toBeNull();
    expect(container.querySelector(`path[name="${FOUR_PCT}"]`)).toBeNull();
    expect(
      within(container).getByRole('button', { name: GUARANTEED }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
});

describe('SwrCompositionChartInner — a zero otherIncome year inside a present series', () => {
  const PRESENT_WITH_ZERO: SwrComparisonYearRow[] = [
    {
      year: 2032,
      guaranteedIncome: 20_000,
      otherIncome: 4_000,
      afterTaxDraw: 30_000,
      tax: 5_000,
      guaranteedIncomeSplit: { socialSecurity: 20_000, pension: 0 },
      guaranteedIncomeSurplus: 0,
      fourPercentRuleValue: 40_000,
      fourPointFivePercentRuleValue: 45_000,
      isPartialYear: false,
    },
    {
      year: 2033,
      guaranteedIncome: 20_000,
      otherIncome: 0,
      afterTaxDraw: 30_000,
      tax: 5_000,
      guaranteedIncomeSplit: { socialSecurity: 20_000, pension: 0 },
      guaranteedIncomeSurplus: 0,
      fourPercentRuleValue: 40_000,
      fourPointFivePercentRuleValue: 45_000,
      isPartialYear: false,
    },
    {
      year: 2034,
      guaranteedIncome: 20_000,
      otherIncome: 3_000,
      afterTaxDraw: 30_000,
      tax: 5_000,
      guaranteedIncomeSplit: { socialSecurity: 20_000, pension: 0 },
      guaranteedIncomeSurplus: 0,
      fourPercentRuleValue: 40_000,
      fourPointFivePercentRuleValue: 45_000,
      isPartialYear: false,
    },
  ];
  it('pinches the zero year to no visible segment and leaves the layers above it undisturbed', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={PRESENT_WITH_ZERO} depletionYear={null} members={[]} />,
    );
    const guaranteed = areaLayer(container, GUARANTEED);
    const other = areaLayer(container, OTHER);
    const draw = areaLayer(container, DRAW);

    // Base and top coincide at the zero year — a zero-height pinch, not a
    // gap or a hole.
    expect(other.top[1].y).toBeCloseTo(other.base[1].y, 2);
    // ... and that pinch point sits exactly on the guaranteed-income layer's
    // top, with no gap between them — proof the layer above (the draw) sits
    // at precisely the height it would with the "Other income" series
    // absent altogether, not merely visually thin.
    expect(other.base[1].y).toBeCloseTo(guaranteed.top[1].y, 2);
    expect(draw.base[1].y).toBeCloseTo(other.top[1].y, 2);
  });

  it("omits the other-income tooltip line on the zero year while its neighbour's carries one", () => {
    const tooltip = makeTooltip(CHART_COLORS.light, CHART_CHROME.light, null);
    const zeroYear = render(
      <>{tooltip(flatDatum({ year: 2033, otherIncome: 0 }))}</>,
    );
    expect(zeroYear.queryByText(OTHER)).toBeNull();
    const neighbourYear = render(
      <>{tooltip(flatDatum({ year: 2032, otherIncome: 4_000 }))}</>,
    );
    expect(neighbourYear.getByText(OTHER)).toBeInTheDocument();
  });
});

describe('SwrCompositionChartInner — tooltip content', () => {
  it('states full-precision dollars per layer, the source split summing to guaranteed income, and the surplus line only on a row that carries one', () => {
    const socialSecurity = 20_000;
    const pension = 10_000;
    const guaranteedIncome = socialSecurity + pension;
    expect(socialSecurity + pension).toBe(guaranteedIncome);

    const tooltip = makeTooltip(CHART_COLORS.light, CHART_CHROME.light, null);
    const withSurplus = render(
      <>
        {tooltip(
          flatDatum({
            year: 2032,
            guaranteedIncome,
            socialSecurity,
            pension,
            guaranteedIncomeSurplus: 1_500,
            otherIncome: 5_000,
            afterTaxDraw: 41_234,
            tax: 8_000,
            fourPercentRuleValue: 40_000,
            fourPointFivePercentRuleValue: 45_000,
          }),
        )}
      </>,
    );
    expect(withSurplus.getByText('$30,000')).toBeInTheDocument();
    expect(withSurplus.getByText('$20,000')).toBeInTheDocument();
    expect(withSurplus.getByText('$10,000')).toBeInTheDocument();
    expect(withSurplus.getByText('$1,500')).toBeInTheDocument();
    expect(withSurplus.getByText('$5,000')).toBeInTheDocument();
    expect(withSurplus.getByText('$41,234')).toBeInTheDocument();
    expect(withSurplus.getByText('$8,000')).toBeInTheDocument();
    expect(withSurplus.getByText('$40,000')).toBeInTheDocument();
    expect(withSurplus.getByText('$45,000')).toBeInTheDocument();
    withSurplus.unmount();

    const noSurplus = render(
      <>{tooltip(flatDatum({ year: 2033, guaranteedIncome: 32_000, guaranteedIncomeSurplus: 0 }))}</>,
    );
    expect(noSurplus.queryByText('Surplus (not needed that year)')).toBeNull();
  });

  it('heads the tooltip with the hovered year plus each member\'s age when members are supplied, and the bare year alone when none are', () => {
    const withMembers = render(
      <>
        {makeTooltip(CHART_COLORS.light, CHART_CHROME.light, null, [
          { firstName: 'Alice', birthYear: 1970 },
          { firstName: 'Bob', birthYear: 1972 },
        ])(flatDatum({ year: 2032 }))}
      </>,
    );
    expect(withMembers.getByText('2032')).toBeInTheDocument();
    expect(withMembers.container.textContent).toContain('Alice (age 62) · Bob (age 60)');
    withMembers.unmount();

    const withoutMembers = render(
      <>{makeTooltip(CHART_COLORS.light, CHART_CHROME.light, null)(flatDatum({ year: 2032 }))}</>,
    );
    expect(withoutMembers.getByText('2032')).toBeInTheDocument();
    expect(withoutMembers.container.textContent).not.toContain('age');
  });

  it('omits a legend-hidden series so the tooltip never contradicts the legend', () => {
    const tooltip = makeTooltip(
      CHART_COLORS.light,
      CHART_CHROME.light,
      null,
      [],
      new Set([GUARANTEED, OTHER]),
    );
    const node = tooltip(
      flatDatum({
        year: 2032,
        guaranteedIncome: 30_000,
        otherIncome: 5_000,
        afterTaxDraw: 40_000,
        tax: 8_000,
      }),
    );
    const { queryByText, getByText } = render(<>{node}</>);
    expect(queryByText(GUARANTEED)).toBeNull();
    expect(queryByText(OTHER)).toBeNull();
    expect(getByText(DRAW)).toBeInTheDocument();
    expect(getByText(TAX)).toBeInTheDocument();
  });

  it("stops reporting a series the legend has hidden on a real hover, so the tooltip never contradicts the legend's own feedback", () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={VARYING_ROWS} depletionYear={null} members={[]} />,
    );
    // Isolate-first click: the FIRST legend click on "4.5% rule" hides
    // every other series.
    fireEvent.click(screen.getByRole('button', { name: FOUR_HALF_PCT }));
    const tip = hoverTooltip(container);
    expect(within(tip).queryByText(GUARANTEED)).toBeNull();
    expect(within(tip).queryByText(DRAW)).toBeNull();
    expect(within(tip).getByText(FOUR_HALF_PCT)).toBeInTheDocument();
  });
});

describe('SwrCompositionChartInner — theme', () => {
  it('sources every series colour from the theme-reactive palette and flips light↔dark', () => {
    const light = renderWithTheme(
      'light',
      <InnerChart rows={VARYING_ROWS} depletionYear={null} members={[]} />,
    );
    const dark = renderWithTheme(
      'dark',
      <InnerChart rows={VARYING_ROWS} depletionYear={null} members={[]} />,
    );
    const areaChecks: Array<[string, keyof typeof CHART_COLORS.light]> = [
      [GUARANTEED, 'income'],
      [OTHER, 'incomePartTime'],
      [DRAW, 'incomeWithdrawal'],
      [TAX, 'federalTax'],
    ];
    for (const [name, key] of areaChecks) {
      expect(CHART_COLORS.light[key]).not.toBe(CHART_COLORS.dark[key]);
      expect(seriesColor(light, name, 'fill')).toBe(CHART_COLORS.light[key]);
      expect(seriesColor(dark, name, 'fill')).toBe(CHART_COLORS.dark[key]);
    }
    const lineChecks: Array<[string, keyof typeof CHART_COLORS.light]> = [
      [FOUR_PCT, 'essential'],
      [FOUR_HALF_PCT, 'twr'],
    ];
    for (const [name, key] of lineChecks) {
      expect(CHART_COLORS.light[key]).not.toBe(CHART_COLORS.dark[key]);
      expect(seriesColor(light, name, 'stroke')).toBe(CHART_COLORS.light[key]);
      expect(seriesColor(dark, name, 'stroke')).toBe(CHART_COLORS.dark[key]);
    }
  });
});

describe('SwrCompositionChartInner — degenerate input', () => {
  it('renders an empty series without throwing and with no plotted points', () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={[]} depletionYear={null} members={[]} />,
    );
    // The two unconditional layers (and both rule lines) still emit a
    // `<path>` node with an empty `d` for a zero-row series — parse the
    // points back out rather than asserting the node itself is absent
    // (mirrors `SafeWithdrawalRateChartInner.test.tsx`'s own empty-series
    // case).
    for (const name of [GUARANTEED, DRAW, FOUR_PCT, FOUR_HALF_PCT]) {
      expect(linePoints(container, name)).toHaveLength(0);
    }
  });
});

describe('SwrCompositionChartInner — a11y', () => {
  it("states the frame's accessible name and renders without a11y violations", async () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={VARYING_ROWS} depletionYear={2034} members={[]} />,
    );
    expect(screen.getByRole('img', { name: FRAME_NAME })).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });
});
