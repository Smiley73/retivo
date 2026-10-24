// Per-expense-category palette and `CategoryMeta`, shared by the Expenses-by-Category chart and the cashflow category band so a category keeps one colour.
// Categories take colours in alphabetical order (stable across reloads), cycling past the palette length.

import { CHART_COLORS } from './tokens';

/** One rendered category band: id, display name and assigned colour. */
export interface CategoryMeta {
  id: string;
  name: string;
  color: string;
}

/** `CategoryMeta` for the active categories, sorted by name so colours are stable across reloads; the caller decides the active set. */
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

/** Stacked-area palette for a theme, from the chart-color map. */
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
