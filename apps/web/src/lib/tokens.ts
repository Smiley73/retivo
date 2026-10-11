/**
 * Chart color map — the SOLE source of chart series / marker colors.
 *
 * This map is the JS mirror of the Graphite Spectrum OKLCH palette: the
 * ported SVG chart engine (components/charts/) resolves chart colors from
 * it (NOT from runtime `getComputedStyle` reads of the CSS vars) so pure
 * marker builders (which run outside React render and cannot read the DOM
 * cheaply per-frame) and the AA gate (`contrast.ts`) share one source of
 * truth. Chart components read the active theme via `useChartColors()` /
 * `useChartChrome()` (in `./use-chart-tokens` — split out so this file
 * stays free of any `.tsx` import; otherwise the `ThemeContext` `.tsx`
 * drags Vite's React Refresh runtime into the optimiser worker bundle
 * and throws `ReferenceError: Can't find variable: window`).
 *
 * Palette is the Graphite Spectrum system: five type-coded account-bucket
 * hues (iris = pre-tax, violet = Roth, cyan = taxable, amber = cash,
 * teal = tax_free) plus
 * the lime accent (gated at the darker ring-lime so it clears the
 * non-text 3.0 threshold), green/red semantic states, and life/retire
 * markers. Every value is the sRGB hex of the matching OKLCH token in
 * styles.css. Every chart-series-vs-surface pair is registered in
 * `contrast.ts` and gated AA in both themes.
 *
 * Drift guard (`tokens.test.ts`): every key present in BOTH `light`
 * and `dark`, `light !== dark` per key, shape/type stable.
 */

/**
 * Theme-keyed chart palette. Each `light` key has a matching `dark` key
 * with the same hue lifted for legibility on dark surfaces (light uses
 * the ~0.50 lightness band, dark the ~0.74 band).
 *
 * Band fills (Monte Carlo) carry their own alpha — they paint over the
 * plot area, not text, so they are translucent by design.
 */
export const CHART_COLORS = {
  light: {
    // Primary series lead with the bucket hues (iris / violet).
    essential: '#195cc7', // iris (pre-tax bucket hue) — primary series
    discretionary: '#7c298e', // violet (Roth-adjacent) — secondary series
    income: '#097f23', // positive green
    incomeSs: '#195cc7', // iris
    incomePension: '#7c298e', // violet
    incomePartTime: '#a16100', // amber (cash bucket hue)
    incomeOneOff: '#a13170', // pink
    portfolioAdd: '#008892', // cyan (taxable bucket hue)
    incomeWithdrawal: '#287aa3', // graphite-cyan (shifted off pretax hue)
    lifeMarkerPrimary: '#bb061e', // 2nd-death marker — red
    lifeMarkerSecondary: '#cd4805', // 1st-death marker — orange
    retirementMarker: '#007780', // teal/cyan retire marker
    twr: '#7c298e', // violet
    average: '#097f23', // green
    netChangePositive: '#097f23', // green
    netChangeNegative: '#bb061e', // red
    cashflowIncome: '#287aa3', // graphite-cyan (shifted off pretax hue)
    accountReturnPositive: '#097f23', // green
    accountReturnNegative: '#bb061e', // red
    plannedSeries: '#195cc7', // iris (Planned method line)
    expenseTotal: '#195cc7', // iris (Expenses-page total line)
    shortfall: '#bb061e', // red
    depletionMarker: '#bb061e', // red
    retireMarkerAccent: '#195cc7', // iris (MC "Retire" marker)
    mcBandOuter: 'rgba(25, 92, 199, 0.16)', // iris @ .16
    mcBandInner: 'rgba(25, 92, 199, 0.34)', // iris @ .34
    mcMedian: '#611ba7', // deep violet
    mcPlanned: '#a16100', // amber
    mcTypical: '#008892', // cyan (taxable hue) — dashboard MC P50 overlay line
    mcPessimistic: '#a16100', // amber (warning hue) — dashboard MC P25 overlay line
    mcBadLuck: '#b32228', // danger red — MC P10 (Bad-luck) representative line
    // Tax & health-cost burden chart.
    federalTax: '#bb061e', // red (federal income tax bar, above zero)
    irmaa: '#7c298e', // violet (IRMAA surcharge — distinct from red + green)
    acaPtc: '#097f23', // green (ACA-PTC subsidy — benefit, below zero)
    // Required Minimum Distribution chart.
    rmdMet: '#007780', // teal/cyan (RMD met — neutral obligation, distinct from federalTax red)
    rmdShortfall: '#bb061e', // red (RMD shortfall — cost accent, analogous to federalTax)
    rmdRetained: '#097f23', // positive green (surplus kept in portfolio)
    qcd: '#a13170', // pink (charitable distribution — distinct from the RMD band's teal/red/green)
    qcdOffset: '#a16100', // amber (covered-by-gift slice of the QCD-RMD split bar — deliberately NOT the gift pink, so the adjacent QCD gift chart never reads as the same series; hex shared with the amber family, already contrast-gated)
    // Account balance stack chart — bucket hues.
    acctPreTax: '#195cc7', // iris
    acctRoth: '#851b9b', // violet (Roth)
    acctTaxable: '#007780', // cyan (taxable)
    acctHsa: '#097f23', // green (HSA)
    acctCash: '#a16100', // amber (cash)
    acctExcluded: '#287aa3', // graphite-cyan (excluded overlay, shifted off pretax hue)
  },
  dark: {
    essential: '#969fff', // iris
    discretionary: '#d080e2', // violet
    income: '#4cb86a', // green
    incomeSs: '#969fff', // iris
    incomePension: '#d080e2', // violet
    incomePartTime: '#e9ab2b', // amber
    incomeOneOff: '#f080b8', // pink
    portfolioAdd: '#24c1c9', // cyan
    incomeWithdrawal: '#98a5be', // muted graphite-blue
    lifeMarkerPrimary: '#ef6661', // red
    lifeMarkerSecondary: '#d44f13', // orange
    retirementMarker: '#24c1c9', // teal/cyan
    twr: '#d080e2', // violet
    average: '#4cb86a', // green
    netChangePositive: '#4cb86a', // green
    netChangeNegative: '#ef6661', // red
    cashflowIncome: '#98a5be', // muted graphite-blue
    accountReturnPositive: '#4cb86a', // green
    accountReturnNegative: '#ef6661', // red
    plannedSeries: '#969fff', // iris
    expenseTotal: '#969fff', // iris
    shortfall: '#ef6661', // red
    depletionMarker: '#ef6661', // red
    retireMarkerAccent: '#969fff', // iris
    mcBandOuter: 'rgba(150, 159, 255, 0.22)', // iris @ .22
    mcBandInner: 'rgba(150, 159, 255, 0.42)', // iris @ .42
    mcMedian: '#b082f7', // violet
    mcPlanned: '#e9ab2b', // amber
    mcTypical: '#24c1c9', // cyan (taxable hue) — dashboard MC P50 overlay line
    mcPessimistic: '#e9ab2b', // amber (warning hue) — dashboard MC P25 overlay line
    mcBadLuck: '#ef6661', // danger red (lifted) — MC P10 (Bad-luck) representative line
    // Tax & health-cost burden chart.
    federalTax: '#ef6661', // red
    irmaa: '#d080e2', // violet
    acaPtc: '#4cb86a', // green
    // Required Minimum Distribution chart.
    rmdMet: '#24c1c9', // teal/cyan (RMD met)
    rmdShortfall: '#ef6661', // red (RMD shortfall)
    rmdRetained: '#4cb86a', // positive green (surplus kept in portfolio)
    qcd: '#f080b8', // pink (charitable distribution — distinct from the RMD band's teal/red/green)
    qcdOffset: '#e9ab2b', // amber (covered-by-gift slice of the QCD-RMD split bar — deliberately NOT the gift pink; hex shared with the amber family, already contrast-gated)
    // Account balance stack chart — bucket hues.
    acctPreTax: '#969fff', // iris
    acctRoth: '#b688fe', // violet
    acctTaxable: '#24c1c9', // cyan
    acctHsa: '#4cb86a', // green
    acctCash: '#e9b452', // amber
    acctExcluded: '#98a5be', // muted graphite-blue
  },
} as const;

/**
 * Chart chrome — the decorative, non-series neutrals every chart paints
 * around its data (grid lines, axis strokes/ticks, the hover-tooltip
 * surface + its border + text). Graphite Spectrum neutral tokens
 * (sRGB hex mirrors of the styles.css OKLCH neutrals), lifted for dark
 * surfaces.
 *
 * Deliberately SEPARATE from `CHART_COLORS`: chrome is decoration, not a
 * series line/bar/area/marker that conveys required information, so it is
 * out of scope for the WCAG-1.4.11 non-text-UI gate that `contrast.ts`
 * applies to every `CHART_COLORS` hex (grid lines are intentionally
 * low-contrast and would — correctly — fail a ≥ 3.0 series threshold).
 */
export const CHART_CHROME = {
  light: {
    grid: '#d9dbde', // line
    axis: '#82868e', // input-line (axis line + tick text chrome)
    tooltipBg: '#ffffff', // raised card surface
    tooltipBorder: '#c1c4c9', // line-strong
    tooltipText: '#0e1218', // ink
  },
  dark: {
    grid: '#2b2e33', // line
    axis: '#6d727a', // input-line
    tooltipBg: '#121417', // raised card surface
    tooltipBorder: '#44484e', // line-strong
    tooltipText: '#edeef2', // ink
  },
} as const;

type ChartChromeKey = keyof (typeof CHART_CHROME)['light'];
/** Resolved chrome for one theme. The `light`/`dark` literal types
 *  differ per key, so widen to `string` for the shared shape. */
export type ChartChrome = Record<ChartChromeKey, string>;

export type ChartTheme = keyof typeof CHART_COLORS;
type ChartColorKey = keyof (typeof CHART_COLORS)['light'];
/** Resolved palette for one theme: every key → a color string. The
 *  `light`/`dark` literal types differ per key, so widen to `string`
 *  for the shared consumer-facing shape. */
export type ChartColors = Record<ChartColorKey, string>;

/**
 * Life-event marker colors keyed by household member slot, for a given
 * resolved theme. Both pages that draw life-marker lines (Balance
 * Projection, Expenses) and the expense-preview builder share this so a
 * palette change ripples in one place.
 */
export function lifeMarkerColors(
  theme: ChartTheme,
): Record<'primary' | 'secondary', string> {
  return {
    primary: CHART_COLORS[theme].lifeMarkerPrimary,
    secondary: CHART_COLORS[theme].lifeMarkerSecondary,
  };
}
