import { describe, expect, it } from 'vitest';
import { PDF_LIGHT_COLORS } from './pdf-colors';
import { CHART_COLORS } from '../tokens';

describe('PDF_LIGHT_COLORS', () => {
  it('exposes non-empty string values for every key', () => {
    for (const [key, value] of Object.entries(PDF_LIGHT_COLORS)) {
      expect(typeof value, key).toBe('string');
      expect(value.length, key).toBeGreaterThan(0);
    }
  });

  it('sources chart hues from the LIGHT palette, never dark', () => {
    expect(PDF_LIGHT_COLORS.chartEssential).toBe(CHART_COLORS.light.essential);
    expect(PDF_LIGHT_COLORS.chartDiscretionary).toBe(
      CHART_COLORS.light.discretionary,
    );
    expect(PDF_LIGHT_COLORS.chartShortfall).toBe(CHART_COLORS.light.shortfall);
    expect(PDF_LIGHT_COLORS.chartQcd).toBe(CHART_COLORS.light.qcd);
    // And explicitly NOT the dark twin.
    expect(PDF_LIGHT_COLORS.chartEssential).not.toBe(CHART_COLORS.dark.essential);
    expect(PDF_LIGHT_COLORS.chartQcd).not.toBe(CHART_COLORS.dark.qcd);
  });

  it('uses fixed print-surface neutrals for chrome', () => {
    expect(PDF_LIGHT_COLORS.pageBg).toBe('#ffffff');
    expect(PDF_LIGHT_COLORS.text).toMatch(/^#[0-9a-f]{6}$/);
    expect(PDF_LIGHT_COLORS.border).toMatch(/^#[0-9a-f]{6}$/);
  });
});
