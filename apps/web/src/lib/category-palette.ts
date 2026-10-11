/**
 * Shared per-expense-category palette + the `CategoryMeta` contract.
 *
 * Both the Expenses-by-Category chart and the Balance Projection
 * "Expected cashflow" category-mode band assign per-category hues from
 * this single palette so a given category lands on the same colour on
 * both pages. Pure; no React.
 *
 * Categories are assigned in alphabetical order so a given category name
 * lands on the same colour across reloads. Falls back to cycling when
 * there are more categories than palette slots.
 */
import { CHART_COLORS } from './tokens';

/** Named contract for one rendered category band: stable id, display
 *  name, and the assigned palette colour. Shared by both inner charts
 *  (the Expenses-by-Category chart and the cashflow category band). */
export interface CategoryMeta {
  id: string;
  name: string;
  color: string;
}

/**
 * Assemble the active-category `CategoryMeta[]` shared by both per-category
 * surfaces: filter to the active ids, sort alphabetical-by-name (stable
 * across reloads), and assign palette colours in that order so a given
 * category lands on the SAME hue on the Expenses page and the cashflow
 * band. Pure. The caller decides the active set (the Expenses page
 * from non-zero category-chart totals; the cashflow band from the
 * display-basis-independent nominal signal).
 */
export function assembleCategoryMeta(
  categories: ReadonlyArray<{ id: string; name: string }>,
  activeIds: ReadonlySet<string>,
  theme: 'light' | 'dark',
): CategoryMeta[] {
  const palette = categoryPaletteFor(theme);
  return categories
    .filter((c) => activeIds.has(c.id))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
    .map((c, i) => ({
      id: c.id,
      name: c.name,
      color: palette[i % palette.length],
    }));
}

/**
 * Stacked-area palette for the per-category charts, resolved for a theme.
 * Reuses the chart-color map so the user's theme palette flows through.
 */
export function categoryPaletteFor(theme: 'light' | 'dark'): readonly string[] {
  const c = CHART_COLORS[theme];
  return [
    c.essential,
    c.discretionary,
    c.income,
    c.incomeSs,
    c.incomePension,
    c.incomePartTime,
    c.incomeOneOff,
    c.incomeWithdrawal,
    c.twr,
    c.average,
  ];
}
