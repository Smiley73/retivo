// WCAG 2.x contrast math and the AA-safe fg/bg pair registry (`docs/ui-conventions.md`,
// "Contrast"). `contrast.test.ts` proves each pair clears its threshold in both themes.

import { CHART_COLORS } from './tokens';

/** WCAG 2.x 1.4.3 — normal text. */
export const AA_NORMAL_TEXT_MIN = 4.5;
/** WCAG 2.x 1.4.3 — large text (>= 18.66px bold / 24px regular). */
export const AA_LARGE_TEXT_MIN = 3.0;
/** WCAG 2.x 1.4.11 — non-text UI (borders, focus rings, icons, controls). */
export const AA_NON_TEXT_MIN = 3.0;

function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`Invalid hex color: "${hex}"`);
  }
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** WCAG 2.x relative luminance of an sRGB hex color (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const lin = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG 2.x contrast ratio between two hex colors (1.0 … 21.0). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

type ContrastPairKind = 'normal-text' | 'large-text' | 'non-text';

export interface ContrastPair {
  readonly name: string;
  readonly fg: string;
  readonly bg: string;
  readonly kind: ContrastPairKind;
}

/** Every UI fg/bg pair the design may use; a new pair is registered here in the same PR. */
export const UI_CONTRAST_PAIRS: Record<'light' | 'dark', readonly ContrastPair[]> = {
  light: [
    { name: 'body text on page bg', fg: '#0e1218', bg: '#f9fafb', kind: 'normal-text' },
    { name: 'body text on card surface', fg: '#0e1218', bg: '#ffffff', kind: 'normal-text' },
    { name: 'muted text on card surface', fg: '#575b62', bg: '#ffffff', kind: 'normal-text' },
    { name: 'muted text on page bg', fg: '#575b62', bg: '#f9fafb', kind: 'normal-text' },
    { name: 'heading text on subtle surface', fg: '#0e1218', bg: '#f2f3f5', kind: 'normal-text' },
    { name: 'muted text on striped row', fg: '#575b62', bg: '#f2f3f5', kind: 'normal-text' },
    { name: 'accent link on card surface', fg: '#00704b', bg: '#ffffff', kind: 'normal-text' },
    { name: 'accent link on page bg', fg: '#00704b', bg: '#f9fafb', kind: 'normal-text' },
    { name: 'primary button label on accent', fg: '#ffffff', bg: '#0e6549', kind: 'normal-text' },
    { name: 'accent link on accent wash', fg: '#00704b', bg: '#ddf5e9', kind: 'normal-text' },
    { name: 'active-nav text on accent wash', fg: '#00704b', bg: '#ddf5e9', kind: 'normal-text' },
    { name: 'toggle hover label on accent wash', fg: '#0e1218', bg: '#ddf5e9', kind: 'normal-text' },
    { name: 'danger button label on danger', fg: '#f9fafb', bg: '#b32228', kind: 'normal-text' },
    // Card and panel hairlines (`border-line`) are decorative and 1.4.11-exempt, so deliberately unregistered.
    { name: 'input border on card surface', fg: '#82868e', bg: '#ffffff', kind: 'non-text' },
    { name: 'input border on sunken surface', fg: '#82868e', bg: '#f2f3f5', kind: 'non-text' },
    { name: 'focus ring on card surface', fg: '#158561', bg: '#ffffff', kind: 'non-text' },
    { name: 'focus ring on page bg', fg: '#158561', bg: '#f9fafb', kind: 'non-text' },
    { name: 'negative value text on card surface', fg: '#b32228', bg: '#ffffff', kind: 'normal-text' },
    { name: 'negative value text on subtle surface', fg: '#b32228', bg: '#f2f3f5', kind: 'normal-text' },
    { name: 'positive value text on card surface', fg: '#097f23', bg: '#ffffff', kind: 'normal-text' },
    { name: 'positive value text on subtle surface', fg: '#097f23', bg: '#f2f3f5', kind: 'normal-text' },
    { name: 'success button label on success', fg: '#f9fafb', bg: '#097f23', kind: 'normal-text' },
    { name: 'switch thumb on unchecked track', fg: '#f9fafb', bg: '#82868e', kind: 'non-text' },
    { name: 'switch thumb on checked track', fg: '#f9fafb', bg: '#097f23', kind: 'non-text' },
    { name: 'switch unchecked boundary on card surface', fg: '#82868e', bg: '#ffffff', kind: 'non-text' },
    { name: 'switch checked boundary on card surface', fg: '#097f23', bg: '#ffffff', kind: 'non-text' },
    { name: 'stress status muted on stat card', fg: '#575b62', bg: '#ffffff', kind: 'normal-text' },
    { name: 'stress status success on stat card', fg: '#097f23', bg: '#ffffff', kind: 'normal-text' },
    { name: 'stress status warning on stat card', fg: '#975800', bg: '#ffffff', kind: 'normal-text' },
    { name: 'stress status danger on stat card', fg: '#b32228', bg: '#ffffff', kind: 'normal-text' },
    { name: 'alert warning text on sunken', fg: '#975800', bg: '#f2f3f5', kind: 'normal-text' },
    { name: 'alert info text on sunken', fg: '#006aaa', bg: '#f2f3f5', kind: 'normal-text' },
    { name: 'badge iris text on iris-subtle', fg: '#195cc7', bg: '#d8edff', kind: 'normal-text' },
    { name: 'badge cyan text on cyan-subtle', fg: '#007780', bg: '#cdf4f6', kind: 'normal-text' },
    { name: 'badge violet text on violet-subtle', fg: '#851b9b', bg: '#fbe1ff', kind: 'normal-text' },
    { name: 'badge amber text on amber-subtle', fg: '#975800', bg: '#ffeed6', kind: 'normal-text' },
    { name: 'badge teal text on teal-subtle', fg: '#00756b', bg: '#cff4ef', kind: 'normal-text' },
    { name: 'tooltip text on ink bubble', fg: '#f9fafb', bg: '#0e1218', kind: 'normal-text' },
    { name: 'hsa category swatch on card surface', fg: '#097f23', bg: '#ffffff', kind: 'non-text' },
  ],
  dark: [
    { name: 'body text on page bg', fg: '#edeef2', bg: '#08090c', kind: 'normal-text' },
    { name: 'body text on card surface', fg: '#edeef2', bg: '#121417', kind: 'normal-text' },
    { name: 'muted text on card surface', fg: '#a1a5ac', bg: '#121417', kind: 'normal-text' },
    { name: 'muted text on page bg', fg: '#a1a5ac', bg: '#08090c', kind: 'normal-text' },
    { name: 'heading text on page bg', fg: '#edeef2', bg: '#08090c', kind: 'normal-text' },
    { name: 'muted text on striped row', fg: '#a1a5ac', bg: '#040609', kind: 'normal-text' },
    { name: 'accent link on card surface', fg: '#4ab689', bg: '#121417', kind: 'normal-text' },
    { name: 'accent link on page bg', fg: '#4ab689', bg: '#08090c', kind: 'normal-text' },
    { name: 'primary button label on accent', fg: '#ffffff', bg: '#0e6549', kind: 'normal-text' },
    { name: 'accent link on accent wash', fg: '#4ab689', bg: '#002d1d', kind: 'normal-text' },
    { name: 'active-nav text on accent wash', fg: '#4ab689', bg: '#002d1d', kind: 'normal-text' },
    { name: 'toggle hover label on accent wash', fg: '#edeef2', bg: '#002d1d', kind: 'normal-text' },
    { name: 'danger button label on danger', fg: '#08090c', bg: '#ef6661', kind: 'normal-text' },
    { name: 'input border on card surface', fg: '#6d727a', bg: '#121417', kind: 'non-text' },
    { name: 'focus ring on card surface', fg: '#4ab689', bg: '#121417', kind: 'non-text' },
    { name: 'negative value text on card surface', fg: '#ef6661', bg: '#121417', kind: 'normal-text' },
    { name: 'negative value text on page bg', fg: '#ef6661', bg: '#08090c', kind: 'normal-text' },
    { name: 'negative value text on sunken surface', fg: '#ef6661', bg: '#040609', kind: 'normal-text' },
    { name: 'positive value text on card surface', fg: '#4cb86a', bg: '#121417', kind: 'normal-text' },
    { name: 'positive value text on page bg', fg: '#4cb86a', bg: '#08090c', kind: 'normal-text' },
    { name: 'success button label on success', fg: '#08090c', bg: '#4cb86a', kind: 'normal-text' },
    { name: 'switch thumb on unchecked track', fg: '#08090c', bg: '#6d727a', kind: 'non-text' },
    { name: 'switch thumb on checked track', fg: '#08090c', bg: '#4cb86a', kind: 'non-text' },
    { name: 'switch unchecked boundary on card surface', fg: '#6d727a', bg: '#121417', kind: 'non-text' },
    { name: 'switch checked boundary on card surface', fg: '#4cb86a', bg: '#121417', kind: 'non-text' },
    { name: 'stress status muted on stat card', fg: '#a1a5ac', bg: '#121417', kind: 'normal-text' },
    { name: 'stress status success on stat card', fg: '#4cb86a', bg: '#121417', kind: 'normal-text' },
    { name: 'stress status warning on stat card', fg: '#e9ab2b', bg: '#121417', kind: 'normal-text' },
    { name: 'stress status danger on stat card', fg: '#ef6661', bg: '#121417', kind: 'normal-text' },
    { name: 'alert warning text on sunken', fg: '#e9ab2b', bg: '#040609', kind: 'normal-text' },
    { name: 'alert info text on sunken', fg: '#52b5f4', bg: '#040609', kind: 'normal-text' },
    { name: 'badge iris text on iris-subtle', fg: '#969fff', bg: '#1e2040', kind: 'normal-text' },
    { name: 'badge cyan text on cyan-subtle', fg: '#24c1c9', bg: '#002b2d', kind: 'normal-text' },
    { name: 'badge violet text on violet-subtle', fg: '#b688fe', bg: '#291c3c', kind: 'normal-text' },
    { name: 'badge amber text on amber-subtle', fg: '#e9b452', bg: '#362607', kind: 'normal-text' },
    { name: 'badge teal text on teal-subtle', fg: '#45c1b4', bg: '#002c27', kind: 'normal-text' },
    { name: 'tooltip text on ink bubble', fg: '#08090c', bg: '#edeef2', kind: 'normal-text' },
    { name: 'hsa category swatch on card surface', fg: '#4cb86a', bg: '#121417', kind: 'non-text' },
  ],
};

const CHART_SURFACES = {
  light: { page: '#f9fafb', card: '#ffffff' },
  dark: { page: '#08090c', card: '#121417' },
} as const;

function buildChartPairs(
  theme: 'light' | 'dark',
): readonly ContrastPair[] {
  const palette = CHART_COLORS[theme];
  const { page, card } = CHART_SURFACES[theme];
  const out: ContrastPair[] = [];
  for (const [key, value] of Object.entries(palette)) {
    if (!value.startsWith('#')) continue;
    out.push(
      { name: `chart ${key} on page bg`, fg: value, bg: page, kind: 'non-text' },
      { name: `chart ${key} on card surface`, fg: value, bg: card, kind: 'non-text' },
    );
  }
  return out;
}

/**
 * Every opaque `CHART_COLORS` hex as non-text UI (>= 3.0) on the page and card
 * surface, generated so it cannot drift from what charts paint. Translucent
 * band fills stay `rgba()` and are skipped.
 */
export const CHART_CONTRAST_PAIRS: Record<
  'light' | 'dark',
  readonly ContrastPair[]
> = {
  light: buildChartPairs('light'),
  dark: buildChartPairs('dark'),
};
