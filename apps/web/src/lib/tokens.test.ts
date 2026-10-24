// Chart-color map drift guard: `tokens.ts` is the sole chart-color source, so this locks the map's shape (no chart loses its dark value, no key lands in only one theme); per-chart theme reactivity is gated by the chart render tests.
import { describe, expect, it } from 'vitest';

import { CHART_COLORS, lifeMarkerColors } from './tokens';

const HEX_OR_RGBA = /^(#[0-9a-fA-F]{6}|rgba?\([^)]+\))$/;

describe('CHART_COLORS — map drift guard', () => {
  it('exposes exactly the two theme keys', () => {
    expect(Object.keys(CHART_COLORS).sort()).toEqual(['dark', 'light']);
  });

  it('every light key has a matching dark key (no theme-only keys)', () => {
    const lightKeys = Object.keys(CHART_COLORS.light).sort();
    const darkKeys = Object.keys(CHART_COLORS.dark).sort();
    expect(darkKeys).toEqual(lightKeys);
  });

  describe('per-key contract', () => {
    for (const key of Object.keys(CHART_COLORS.light) as Array<
      keyof typeof CHART_COLORS.light
    >) {
      it(`${key}: present in both themes, valid color, light !== dark`, () => {
        const light = CHART_COLORS.light[key];
        const dark = CHART_COLORS.dark[key];
        expect(typeof light).toBe('string');
        expect(typeof dark).toBe('string');
        expect(light).toMatch(HEX_OR_RGBA);
        expect(dark).toMatch(HEX_OR_RGBA);
        expect(light).not.toBe(dark);
      });
    }
  });
});

describe('lifeMarkerColors', () => {
  it('resolves slot colors from the requested theme', () => {
    expect(lifeMarkerColors('light')).toEqual({
      primary: CHART_COLORS.light.lifeMarkerPrimary,
      secondary: CHART_COLORS.light.lifeMarkerSecondary,
    });
    expect(lifeMarkerColors('dark')).toEqual({
      primary: CHART_COLORS.dark.lifeMarkerPrimary,
      secondary: CHART_COLORS.dark.lifeMarkerSecondary,
    });
  });
});
