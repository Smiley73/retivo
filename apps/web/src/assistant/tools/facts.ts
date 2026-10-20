/**
 * Facts about the app and its calculation tables that every tool result states,
 * read from the constants the engine itself imports so a result and the math it
 * describes cannot name different versions.
 */
import { ENGINE_VERSION } from '../../lib/monte-carlo';
import { DEFAULT_TAX_CALIBRATION_BUNDLE, resolveSnapshotYear } from '../../lib/tax-integration-helpers';

export interface TaxTableFacts {
  /** The newest tax year the built-in federal tables cover. */
  year: number;
  /** True when today's tax year is later than that, so the engine scales the newest table forward. */
  extrapolated: boolean;
}

export function taxTableFacts(todayYear: number): TaxTableFacts {
  const snapshot = DEFAULT_TAX_CALIBRATION_BUNDLE.federalTax;
  const year = Math.max(...Object.keys(snapshot.values).map(Number));
  return { year, extrapolated: resolveSnapshotYear(snapshot, todayYear).taxYearExtrapolated };
}

export function engineVersion(): number {
  return ENGINE_VERSION;
}

/** The tab's local calendar date, the way the pages anchor "today". */
export function localDateIso(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}
