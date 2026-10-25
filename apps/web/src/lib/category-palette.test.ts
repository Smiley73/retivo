import { describe, expect, it } from 'vitest';
import { assembleCategoryMeta } from './category-palette';
import { CHART_COLORS } from './tokens';

const slots = (c: (typeof CHART_COLORS)['light']): string[] => [
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
    expect(meta[0].color).toBe(CHART_COLORS.light.essential);
    expect(meta[1].color).toBe(CHART_COLORS.light.discretionary);
    expect(meta.find((m) => m.id === 'c-medical')).toBeUndefined();
  });

  it('cross-page color identity: same active set → same id→color on both surfaces', () => {
    const active = new Set(['c-travel', 'c-housing', 'c-medical']);
    const a = assembleCategoryMeta(CATEGORIES, active, 'light');
    const reordered = [CATEGORIES[2], CATEGORIES[0], CATEGORIES[1]];
    const b = assembleCategoryMeta(reordered, active, 'light');
    const mapA = Object.fromEntries(a.map((m) => [m.id, m.color]));
    const mapB = Object.fromEntries(b.map((m) => [m.id, m.color]));
    expect(mapB).toEqual(mapA);
  });

  it('assigns the documented 10-slot palette in name order, cycling past the last slot, and flips with the theme', () => {
    const names = 'ABCDEFGHIJK'.split('');
    const categories = names.map((n) => ({ id: `c-${n}`, name: n }));
    const active = new Set(categories.map((c) => c.id));
    const light = assembleCategoryMeta(categories, active, 'light').map((m) => m.color);
    const palette = slots(CHART_COLORS.light);
    expect(light).toEqual([...palette, palette[0]]);
    expect(assembleCategoryMeta(categories, active, 'dark')[0].color).toBe(
      CHART_COLORS.dark.essential,
    );
  });
});
