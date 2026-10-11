/**
 * Tests for the shared per-category palette helper. The palette order is
 * load-bearing: it must stay stable (so a category lands on the same hue
 * across reloads) and resolve from the theme chart-color map so the
 * Expenses page and the cashflow category band agree on colours.
 */
import { describe, expect, it } from 'vitest';
import { assembleCategoryMeta, categoryPaletteFor } from './category-palette';
import { CHART_COLORS } from './tokens';

describe('categoryPaletteFor', () => {
  it('resolves the documented 10-slot order from the theme palette (light)', () => {
    const c = CHART_COLORS.light;
    expect(categoryPaletteFor('light')).toEqual([
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
    ]);
  });

  it('flips with the theme', () => {
    expect(categoryPaletteFor('dark')[0]).toBe(CHART_COLORS.dark.essential);
    expect(categoryPaletteFor('light')[0]).toBe(CHART_COLORS.light.essential);
  });
});

describe('assembleCategoryMeta', () => {
  const CATEGORIES = [
    { id: 'c-travel', name: 'Travel' },
    { id: 'c-housing', name: 'Housing' },
    { id: 'c-medical', name: 'Medical' },
  ];

  it('keeps only active categories, sorts alphabetical-by-name, assigns palette in order', () => {
    const meta = assembleCategoryMeta(
      CATEGORIES,
      new Set(['c-travel', 'c-housing']),
      'light',
    );
    expect(meta.map((m) => m.name)).toEqual(['Housing', 'Travel']);
    const palette = categoryPaletteFor('light');
    expect(meta[0].color).toBe(palette[0]);
    expect(meta[1].color).toBe(palette[1]);
    // Medical is inactive → excluded.
    expect(meta.find((m) => m.id === 'c-medical')).toBeUndefined();
  });

  it('cross-page color identity: same active set → same id→color on both surfaces', () => {
    // The Expenses page and the cashflow band both route through this
    // helper with the same active id set, so a category lands on the same
    // hue regardless of which surface assembles it.
    const active = new Set(['c-travel', 'c-housing', 'c-medical']);
    const a = assembleCategoryMeta(CATEGORIES, active, 'light');
    // A differently-ORDERED input list must not change the id→color map
    // (the helper sorts by name internally).
    const reordered = [CATEGORIES[2], CATEGORIES[0], CATEGORIES[1]];
    const b = assembleCategoryMeta(reordered, active, 'light');
    const mapA = Object.fromEntries(a.map((m) => [m.id, m.color]));
    const mapB = Object.fromEntries(b.map((m) => [m.id, m.color]));
    expect(mapB).toEqual(mapA);
  });
});
