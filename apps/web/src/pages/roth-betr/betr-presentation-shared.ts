/**
 * Shared presentation helpers for the Roth-conversion (BETR) surfaces.
 *
 * Extracted to keep the neutral display copy in ONE place — the comparison
 * label and the tax-payment-source labels were previously duplicated
 * byte-for-byte across RetirementYearsTable, WorkingYearsPanel, and
 * RothBETRPage, which is a drift risk when the wording changes. Imported by:
 *   - RetirementYearsTable.tsx  (comparisonLabel)
 *   - WorkingYearsPanel.tsx     (comparisonLabel + BETR_SOURCE_LABELS)
 *   - RothBETRPage.tsx          (BETR_SOURCE_SELECT_OPTIONS)
 */
import type { BETRSource } from '../../lib/betr-calculator';

/** Neutral, non-directive display text for the comparison result. Maps the
 *  internal `'Convert' | 'Hold'` verdict to a factual statement of how the
 *  RMD-era rate compares to the break-even rate, so each surface describes the
 *  comparison rather than instructing the user (the page disclaimer notes the
 *  comparison does not tell the user whether converting is right for them). */
export function comparisonLabel(verdict: 'Convert' | 'Hold'): string {
  return verdict === 'Convert'
    ? 'RMD-era rate above break-even'
    : 'RMD-era rate at or below break-even';
}

/** Ordered tax-payment-source rows with their neutral display labels — the
 *  single source of truth for the four BETR source variants' copy. */
export const BETR_SOURCE_LABELS: ReadonlyArray<{ source: BETRSource; label: string }> = [
  { source: 'ira', label: 'Pay tax from the IRA' },
  { source: 'taxEfficient', label: 'Taxable account (lower default tax drag)' },
  { source: 'taxInefficient', label: 'Taxable account (higher default tax drag)' },
  { source: 'cash', label: 'Cash' },
];

/** The same source labels shaped as `<Select>` options (`{ value, label }`).
 *  A fresh mutable array (matches the `<Select>` `options` prop type). */
export const BETR_SOURCE_SELECT_OPTIONS: { value: BETRSource; label: string }[] =
  BETR_SOURCE_LABELS.map(({ source, label }) => ({ value: source, label }));
