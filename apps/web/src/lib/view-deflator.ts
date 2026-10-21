/**
 * Page-local view-model deflator. Wraps
 * `projection-context.realDeflatorAt` with the page's display-mode
 * toggle so callers can pass `'today'` / `'future'` instead of branching
 * inline. Returns the identity factor 1 when:
 *   - `mode === 'future'` (engine output is already nominal-at-event),
 *   - `inflationPct === 0`, OR
 *   - `nowYear` / `nowMonthIndex` are undefined.
 *
 * Anchor is the *real-clock* "now" (the page reads `new Date()` at
 * memoise-time) so a Jan-2026 user and a Jun-2026 user see different
 * factors for the same scenario. Engines anchor the same way via
 * `IncomeContext.todayMonthIndex` / `ProjectionContext.asOfMonth`.
 */
export type DisplayMode = 'today' | 'future';

export interface ViewDeflatorAnchor {
  nowYear: number;
  /** 0-11. Drives the month-precise exponent for the deflator. */
  nowMonthIndex: number;
  /** Annual inflation rate (percent). 0 collapses to the identity. */
  inflationPct: number;
}

/**
 * Build a closure that returns the multiplier applied to a nominal
 * dollar amount at `(year, monthIndex)` before display.
 */
export function buildViewDeflator(
  mode: DisplayMode,
  anchor: ViewDeflatorAnchor | null,
): (year: number, monthIndex?: number) => number {
  if (mode === 'future') return () => 1;
  if (!anchor) return () => 1;
  if (anchor.inflationPct === 0) return () => 1;
  const asOfMonth = anchor.nowYear * 12 + anchor.nowMonthIndex;
  const base = 1 + anchor.inflationPct / 100;
  return (year: number, monthIndex: number = 11) =>
    Math.pow(base, -(year * 12 + monthIndex - asOfMonth) / 12);
}

/** localStorage key used by the page-header segmented control. */
export const DISPLAY_MODE_STORAGE_KEY = 'retivo.balanceProjection.displayMode';

/** Coerce an arbitrary string from localStorage into a `DisplayMode`,
 *  defaulting to `'today'` when the stored value is missing / invalid. */
export function parseDisplayMode(stored: string | null): DisplayMode {
  return stored === 'future' ? 'future' : 'today';
}

/** localStorage key for the Compare tab's remembered choices: a JSON object
 *  mapping a viewed scenario id to the scenario it was last compared with.
 *  One id per viewed scenario — a single id would collide the moment the person
 *  views the scenario they last compared with. */
export const COMPARE_CHOICE_STORAGE_KEY =
  'retivo.balanceProjection.compareWith';

/** Coerce a stored string into the viewed-id → comparison-id map. Anything but
 *  a JSON object (missing, malformed, an array, a number) reads as empty, and
 *  entries whose value is not a string are dropped; it never throws. */
export function parseCompareChoices(
  stored: string | null,
): ReadonlyMap<string, string> {
  if (stored === null) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return new Map();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return new Map();
  }
  return new Map(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/**
 * Granularity of the cashflow + income-breakdown chart bands.
 *
 *   - `'yearly'` (default) — one Dec-anchored point per year. Flat-
 *     nominal income (SS / pension / part-time) reads constant across
 *     the year; in `'today'` mode the expense band is the engine's
 *     entered real amount (flat for a non-glided expense, on the real
 *     glide curve for a glided one — exact, no inflation sawtooth, no
 *     Yearly offset). Equals the year-by-year table for that year.
 *   - `'monthly'` — one row per month in true monthly dollars. Income
 *     stays Dec-anchored flat-nominal; in `'today'` mode the expense
 *     band reads the engine's entered real amount (a non-glided
 *     constant expense is identical Jan→Dec; a glided one follows its
 *     real monthly glide ramp), so the within-year inflation sawtooth
 *     is gone in both modes. (`'future'` mode is the prior nominal
 *     month-precise path verbatim.)
 *
 * Page-local display preference only; never written to a scenario
 * payload. Mirrors the `DisplayMode` persistence pattern above.
 */
export type CashflowGranularity = 'monthly' | 'yearly';

/** localStorage key used by the cashflow-granularity segmented control. */
export const CASHFLOW_GRANULARITY_STORAGE_KEY =
  'retivo.balanceProjection.cashflowGranularity';

/** localStorage key for the income-breakdown card's own granularity
 *  segmented control. The cashflow + income-breakdown cards each own an
 *  independent Monthly/Yearly toggle (they may drift out of sync). */
export const INCOME_BREAKDOWN_GRANULARITY_STORAGE_KEY =
  'retivo.balanceProjection.incomeBreakdownGranularity';

/** Coerce an arbitrary string from localStorage into a
 *  `CashflowGranularity`, defaulting to `'yearly'` when the stored
 *  value is missing / invalid. */
export function parseCashflowGranularity(
  stored: string | null,
): CashflowGranularity {
  return stored === 'monthly' ? 'monthly' : 'yearly';
}
