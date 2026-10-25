import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import InnerChart from './SwrCompositionChartInner';
import type { SwrComparisonYearRow } from '../lib/safe-withdrawal-rate-chart-types';
import { renderWithTheme, seriesColor, ThemeWrapper } from '../test/theme-render';
import { expectNoA11yViolations } from '../test/a11y';
import { CHART_COLORS } from '../lib/tokens';

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

// A stacked-area path is the top edge (one point per row) followed by the reversed base edge.
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

    expect(new Set(guaranteed.base.map((p) => p.y)).size).toBe(1);

    for (let i = 0; i < VARYING_ROWS.length; i++) {
      expect(other.base[i].y).toBeCloseTo(guaranteed.top[i].y, 2);
      expect(draw.base[i].y).toBeCloseTo(other.top[i].y, 2);
      expect(tax.base[i].y).toBeCloseTo(draw.top[i].y, 2);
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
    expect(new Set(fourPct.map((p) => p.y)).size).toBe(1);
    expect(new Set(fourHalfPct.map((p) => p.y)).size).toBe(1);
  });

  // Under Future-dollars the rows' rule values rise with inflation, so the chart must not clamp the line level.
  it('rises with the rows when the active dollar mode inflates the rule value, still measured from the axis', () => {
    const rows: SwrComparisonYearRow[] = [2032, 2033, 2034].map((year, i) => ({
      year,
      guaranteedIncome: 30_000,
      otherIncome: 0,
      afterTaxDraw: 40_000 + i * 5_000,
      tax: 8_000,
      guaranteedIncomeSplit: { socialSecurity: 30_000, pension: 0 },
      guaranteedIncomeSurplus: 0,
      // 40,000 / 45,000 real, re-expressed at 3% inflation.
      fourPercentRuleValue: 40_000 * 1.03 ** i,
      fourPointFivePercentRuleValue: 45_000 * 1.03 ** i,
      isPartialYear: false,
    }));
    const container = renderWithTheme(
      'light',
      <InnerChart rows={rows} depletionYear={null} members={[]} />,
    );
    // The bottom layer's base is the zero axis and its top a known dollar figure: together they give pixels per dollar.
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
      for (let i = 1; i < points.length; i++) {
        expect(points[i].y).toBeLessThan(points[i - 1].y);
      }
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

    const draw = areaLayer(container, DRAW);
    expect(fourPct[0].x).toBeCloseTo(draw.top[1].x, 2);
    expect(fourPct[0].x).not.toBeCloseTo(draw.top[0].x, 2);

    expect(
      container.querySelector(`[data-marker-label="${COMPARISON_LABEL}"]`),
    ).not.toBeNull();
  });

  it("carries the partial-year note on that point's tooltip and not on a later year's", () => {
    const partial = renderWithTheme('light', <InnerChart rows={PARTIAL_ROWS} depletionYear={null} members={[]} />);
    expect(within(hoverTooltip(partial)).getByText(PARTIAL_YEAR_NOTE)).toBeInTheDocument();

    const later = renderWithTheme('light', <InnerChart rows={VARYING_ROWS} depletionYear={null} members={[]} />);
    expect(within(hoverTooltip(later)).queryByText(PARTIAL_YEAR_NOTE)).toBeNull();
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
    const atDepletion = renderWithTheme('light', <InnerChart rows={VARYING_ROWS} depletionYear={2032} members={[]} />);
    expect(within(hoverTooltip(atDepletion)).getByText(POST_DEPLETION_NOTE)).toBeInTheDocument();

    const before = renderWithTheme('light', <InnerChart rows={VARYING_ROWS} depletionYear={2033} members={[]} />);
    expect(within(hoverTooltip(before)).queryByText(POST_DEPLETION_NOTE)).toBeNull();
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
  // Isolating records every other series as hidden and stale keys are pruned only on the next click, so rows that drop
  // the isolated layer would leave a blank frame under a fully struck-through legend.
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
    fireEvent.click(within(container).getByRole('button', { name: DRAW }));
    fireEvent.click(within(container).getByRole('button', { name: TAX }));
    rerender(
      <InnerChart
        rows={VARYING_ROWS.map((r) => ({ ...r, otherIncome: 0 }))}
        depletionYear={null}
        members={[]}
      />,
    );
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

    expect(other.top[1].y).toBeCloseTo(other.base[1].y, 2);
    expect(other.base[1].y).toBeCloseTo(guaranteed.top[1].y, 2);
    expect(draw.base[1].y).toBeCloseTo(other.top[1].y, 2);
  });

  it("omits the other-income tooltip line on the zero year while its neighbour's carries one", () => {
    const hovered = (otherIncome: number): HTMLElement =>
      hoverTooltip(
        renderWithTheme(
          'light',
          <InnerChart
            rows={VARYING_ROWS.map((r, i) => (i === 0 ? { ...r, otherIncome } : r))}
            depletionYear={null}
            members={[]}
          />,
        ),
      );
    expect(within(hovered(0)).queryByText(OTHER)).toBeNull();
    expect(within(hovered(4_000)).getByText(OTHER)).toBeInTheDocument();
  });
});

describe('SwrCompositionChartInner — tooltip content', () => {
  const hoverFirstRow = (
    first: Partial<SwrComparisonYearRow>,
    members: Array<{ firstName: string; birthYear: number }> = [],
  ): HTMLElement =>
    hoverTooltip(
      renderWithTheme(
        'light',
        <InnerChart
          rows={VARYING_ROWS.map((r, i) => (i === 0 ? { ...r, ...first } : r))}
          depletionYear={null}
          members={members}
        />,
      ),
    );

  it('states full-precision dollars per layer, and the surplus line only on a row that carries one', () => {
    const tip = within(hoverFirstRow({ afterTaxDraw: 41_234 }));
    for (const amount of ['$30,000', '$20,000', '$10,000', '$1,500', '$5,000', '$41,234', '$8,000', '$40,000', '$45,000']) {
      expect(tip.getByText(amount)).toBeInTheDocument();
    }

    expect(within(hoverFirstRow({ guaranteedIncomeSurplus: 0 })).queryByText('Surplus (not needed that year)')).toBeNull();
  });

  it("heads the tooltip with the hovered year plus each member's age when members are supplied, and the bare year alone when none are", () => {
    const withMembers = hoverFirstRow({}, [
      { firstName: 'Alice', birthYear: 1970 },
      { firstName: 'Bob', birthYear: 1972 },
    ]);
    expect(within(withMembers).getByText('2032')).toBeInTheDocument();
    expect(withMembers.textContent).toContain('Alice (age 62) · Bob (age 60)');

    const withoutMembers = hoverFirstRow({});
    expect(within(withoutMembers).getByText('2032')).toBeInTheDocument();
    expect(withoutMembers.textContent).not.toContain('age');
  });

  it("stops reporting a series the legend has hidden on a real hover, so the tooltip never contradicts the legend's own feedback", () => {
    const container = renderWithTheme(
      'light',
      <InnerChart rows={VARYING_ROWS} depletionYear={null} members={[]} />,
    );
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
    // A zero-row series still emits a path with an empty `d`.
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
