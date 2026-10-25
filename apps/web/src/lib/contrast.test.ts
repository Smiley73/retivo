import { describe, expect, it } from 'vitest';

import {
  AA_LARGE_TEXT_MIN,
  AA_NON_TEXT_MIN,
  AA_NORMAL_TEXT_MIN,
  CHART_CONTRAST_PAIRS,
  contrastRatio,
  relativeLuminance,
  UI_CONTRAST_PAIRS,
} from './contrast';
import { CHART_COLORS } from './tokens';

// WCAG 2.x reference values (https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio).
describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('accepts shorthand and uppercase hex', () => {
    expect(relativeLuminance('#FFF')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000')).toBeCloseTo(0, 5);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black vs white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('is 1 for a color against itself', () => {
    expect(contrastRatio('#3730a3', '#3730a3')).toBeCloseTo(1, 5);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#1e293b', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#1e293b'),
      5,
    );
  });
});

// jsdom disables axe's color-contrast rule, so every registered pair is checked numerically in both themes.
describe('UI_CONTRAST_PAIRS — every registered pair clears WCAG 2.2 AA', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const pair of UI_CONTRAST_PAIRS[theme]) {
      const min =
        pair.kind === 'normal-text'
          ? AA_NORMAL_TEXT_MIN
          : pair.kind === 'large-text'
            ? AA_LARGE_TEXT_MIN
            : AA_NON_TEXT_MIN;
      it(`${theme}: ${pair.name} (${pair.kind}) >= ${min}`, () => {
        const ratio = contrastRatio(pair.fg, pair.bg);
        expect(ratio).toBeGreaterThanOrEqual(min);
      });
    }
  }

  it('registers pairs for both themes', () => {
    expect(UI_CONTRAST_PAIRS.light.length).toBeGreaterThan(0);
    expect(UI_CONTRAST_PAIRS.dark.length).toBeGreaterThan(0);
  });
});

// Chart colors must clear the non-text-UI threshold (WCAG 1.4.11, >= 3.0) in both themes; the registry is generated from CHART_COLORS.
describe('CHART_CONTRAST_PAIRS — every chart series clears WCAG 1.4.11', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const pair of CHART_CONTRAST_PAIRS[theme]) {
      it(`${theme}: ${pair.name} (non-text) >= ${AA_NON_TEXT_MIN}`, () => {
        expect(pair.kind).toBe('non-text');
        expect(contrastRatio(pair.fg, pair.bg)).toBeGreaterThanOrEqual(
          AA_NON_TEXT_MIN,
        );
      });
    }
  }

  it('gates every opaque chart key in both themes (2 surfaces each)', () => {
    for (const theme of ['light', 'dark'] as const) {
      const opaque = Object.values(CHART_COLORS[theme]).filter((v) =>
        v.startsWith('#'),
      ).length;
      expect(CHART_CONTRAST_PAIRS[theme].length).toBe(opaque * 2);
    }
  });

  it('excludes the translucent Monte Carlo band fills by construction', () => {
    const names = CHART_CONTRAST_PAIRS.light.map((p) => p.name);
    expect(names.some((n) => n.includes('mcBandOuter'))).toBe(false);
    expect(names.some((n) => n.includes('mcBandInner'))).toBe(false);
    expect(CHART_COLORS.light.mcBandOuter.startsWith('rgba')).toBe(true);
    expect(CHART_COLORS.dark.mcBandInner.startsWith('rgba')).toBe(true);
  });
});
