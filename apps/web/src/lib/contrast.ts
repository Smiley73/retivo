/**
 * WCAG 2.x contrast math + the canonical AA-safe fg/bg pair allowlist.
 *
 * The locked WCAG 2.2 AA target (see `docs/ui-conventions.md`, "Contrast") is
 * honored by construction — the design may only style
 * with pairs registered here, and `contrast.test.ts` proves each clears
 * its AA threshold in BOTH themes. This numerically covers the
 * `color-contrast` axe rule that the shared-component a11y helper
 * disables under jsdom.
 *
 * Palette is the Graphite Spectrum system: graphite neutrals, a pine
 * money-green accent (with a lighter `accent-link` green for text), and
 * five account-bucket hues (iris/violet/cyan/amber/teal). Each hex below is
 * the sRGB rendering of the matching OKLCH token in styles.css.
 * The chart-series-vs-surface pairs (`CHART_CONTRAST_PAIRS`) gate every
 * opaque chart series / marker color as non-text UI (1.4.11, ≥ 3.0)
 * against the page + card surface it renders on, in both themes.
 *
 * The relative-luminance / contrast-ratio functions are the verbatim
 * WCAG 2.x definitions — a ~10-line pure computation, no dependency.
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 * https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */
import { CHART_COLORS } from './tokens';

/** WCAG 2.x 1.4.3 — normal text. */
export const AA_NORMAL_TEXT_MIN = 4.5;
/** WCAG 2.x 1.4.3 — large text (>= 18.66px bold / 24px regular). */
export const AA_LARGE_TEXT_MIN = 3.0;
/** WCAG 2.x 1.4.11 — non-text UI (borders, focus rings, icons, controls). */
export const AA_NON_TEXT_MIN = 3.0;

/** `#rgb` or `#rrggbb` (case-insensitive) → [r, g, b] in 0–255. */
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
  /** Stable identifier for the test report + the allowlist. */
  readonly name: string;
  /** Foreground hex (text / icon / border). */
  readonly fg: string;
  /** Background hex it renders against. */
  readonly bg: string;
  /** Which WCAG 2.x threshold applies. */
  readonly kind: ContrastPairKind;
}

// Graphite Spectrum token values used below (sRGB hex of the OKLCH
// tokens in styles.css):
//   LIGHT: surface #f9fafb  raised #ffffff  sunken #f2f3f5
//          line #d9dbde  line-strong #c1c4c9  input-line #82868e
//          muted #575b62  ink #0e1218  accent #0e6549  accent-ink #ffffff
//          accent-link #00704b  accent-subtle #ddf5e9
//          ring #158561  positive #097f23  negative #b32228
//          warning #975800  pretax(iris) #195cc7
//   DARK:  surface #08090c  raised #121417  sunken #040609
//          line #2b2e33  line-strong #44484e  input-line #6d727a
//          muted #a1a5ac  ink #edeef2  accent #0e6549  accent-ink #ffffff
//          accent-link #4ab689  accent-subtle #002d1d
//          ring #4ab689  positive #4cb86a  negative #ef6661
//          warning #e9ab2b  pretax(iris) #969fff

/**
 * The canonical AA-safe UI fg/bg allowlist. Every UI colour pair
 * must be registered here; a new pair lands here in the
 * same PR (the test gates it). This is the proven, numeric allowlist
 * backing the locked WCAG AA guarantee.
 */
export const UI_CONTRAST_PAIRS: Record<'light' | 'dark', readonly ContrastPair[]> = {
  light: [
    { name: 'body text on page bg', fg: '#0e1218', bg: '#f9fafb', kind: 'normal-text' },
    { name: 'body text on card surface', fg: '#0e1218', bg: '#ffffff', kind: 'normal-text' },
    { name: 'muted text on card surface', fg: '#575b62', bg: '#ffffff', kind: 'normal-text' },
    { name: 'muted text on page bg', fg: '#575b62', bg: '#f9fafb', kind: 'normal-text' },
    { name: 'heading text on subtle surface', fg: '#0e1218', bg: '#f2f3f5', kind: 'normal-text' },
    // Muted body text on a sunken / zebra-striped surface.
    { name: 'muted text on striped row', fg: '#575b62', bg: '#f2f3f5', kind: 'normal-text' },
    // Accent link / active-nav text uses the dedicated `accent-link` green
    // (the pine accent fill is button-only — too dark to vary across themes
    // as text). 6.14:1 on card, 5.88:1 on page bg.
    { name: 'accent link on card surface', fg: '#00704b', bg: '#ffffff', kind: 'normal-text' },
    { name: 'accent link on page bg', fg: '#00704b', bg: '#f9fafb', kind: 'normal-text' },
    // Primary button label-on-fill: a WHITE label reads on the deep pine
    // accent fill (bg-accent text-accent-ink), 7.06:1. Destructive = white
    // on the negative red.
    { name: 'primary button label on accent', fg: '#ffffff', bg: '#0e6549', kind: 'normal-text' },
    // Link / active-nav text = accent-link green on the pale green accent
    // wash (bg-accent-subtle). 5.36:1.
    { name: 'accent link on accent wash', fg: '#00704b', bg: '#ddf5e9', kind: 'normal-text' },
    // Sidebar active row = accent-link green label + icon on the accent wash
    // (repointed from text-positive, which read a muddy green-on-green 4.50).
    { name: 'active-nav text on accent wash', fg: '#00704b', bg: '#ddf5e9', kind: 'normal-text' },
    // Show/Hide password toggle darkens its label to ink on hover (the bg
    // shifts to the accent wash); ink on that wash is the rendered pair.
    { name: 'toggle hover label on accent wash', fg: '#0e1218', bg: '#ddf5e9', kind: 'normal-text' },
    // Danger / success filled-button labels use the `surface` token (it
    // swaps near-white in light → near-black in dark), so a single
    // utility reads on the negative/positive fill in both themes.
    { name: 'danger button label on danger', fg: '#f9fafb', bg: '#b32228', kind: 'normal-text' },
    // No `card border on page bg` entry: card / panel / divider hairlines
    // ship `border-line` — a *purely decorative* boundary (WCAG
    // 1.4.11-exempt: surface fill + shadow + spacing convey the
    // container). Intentionally NOT registered. See `docs/ui-conventions.md`
    // ("Contrast").
    // Native text-input / select / textarea control boundary
    // (`border-input-line`). #82868e on white = 3.65:1; on the sunken
    // input fill #f2f3f5 = 3.29:1 — both clear WCAG 1.4.11.
    { name: 'input border on card surface', fg: '#82868e', bg: '#ffffff', kind: 'non-text' },
    { name: 'input border on sunken surface', fg: '#82868e', bg: '#f2f3f5', kind: 'non-text' },
    // Focus ring uses the mid-tone ring-green so it clears the non-text 3.0
    // gate on both surfaces (4.61:1 / 4.41:1).
    { name: 'focus ring on card surface', fg: '#158561', bg: '#ffffff', kind: 'non-text' },
    { name: 'focus ring on page bg', fg: '#158561', bg: '#f9fafb', kind: 'non-text' },
    // Semantic gain/loss value text in tables + summary cards.
    { name: 'negative value text on card surface', fg: '#b32228', bg: '#ffffff', kind: 'normal-text' },
    { name: 'negative value text on subtle surface', fg: '#b32228', bg: '#f2f3f5', kind: 'normal-text' },
    { name: 'positive value text on card surface', fg: '#097f23', bg: '#ffffff', kind: 'normal-text' },
    { name: 'positive value text on subtle surface', fg: '#097f23', bg: '#f2f3f5', kind: 'normal-text' },
    // Success button label (scenario Expense overrides "Re-enable") —
    // the `surface` token on the positive green (4.94:1).
    { name: 'success button label on success', fg: '#f9fafb', bg: '#097f23', kind: 'normal-text' },
    // ToggleSwitch (React Aria Switch) — non-text UI: the white thumb must
    // read against the track and the track boundary against the surface at
    // >= 3.0 in BOTH on/off states. Unchecked track = input-line graphite;
    // checked = positive green (green is the universal on convention).
    { name: 'switch thumb on unchecked track', fg: '#f9fafb', bg: '#82868e', kind: 'non-text' },
    { name: 'switch thumb on checked track', fg: '#f9fafb', bg: '#097f23', kind: 'non-text' },
    { name: 'switch unchecked boundary on card surface', fg: '#82868e', bg: '#ffffff', kind: 'non-text' },
    { name: 'switch checked boundary on card surface', fg: '#097f23', bg: '#ffffff', kind: 'non-text' },
    // Plan stress-test status ink on the raised stat-card surface.
    { name: 'stress status muted on stat card', fg: '#575b62', bg: '#ffffff', kind: 'normal-text' },
    { name: 'stress status success on stat card', fg: '#097f23', bg: '#ffffff', kind: 'normal-text' },
    { name: 'stress status warning on stat card', fg: '#975800', bg: '#ffffff', kind: 'normal-text' },
    { name: 'stress status danger on stat card', fg: '#b32228', bg: '#ffffff', kind: 'normal-text' },
    // Alert tones — state-token text on the sunken surface (warning /
    // info join the already-registered positive / negative on subtle).
    { name: 'alert warning text on sunken', fg: '#975800', bg: '#f2f3f5', kind: 'normal-text' },
    { name: 'alert info text on sunken', fg: '#006aaa', bg: '#f2f3f5', kind: 'normal-text' },
    // Type-coded Badge pills — the account-bucket hue text on its own
    // `-subtle` tint (iris/cyan/violet). Scenario = iris, essential =
    // cyan (taxable), discretionary = violet (Roth).
    { name: 'badge iris text on iris-subtle', fg: '#195cc7', bg: '#d8edff', kind: 'normal-text' },
    { name: 'badge cyan text on cyan-subtle', fg: '#007780', bg: '#cdf4f6', kind: 'normal-text' },
    { name: 'badge violet text on violet-subtle', fg: '#851b9b', bg: '#fbe1ff', kind: 'normal-text' },
    // The `cash` bucket chip (amber): the cash hue text on its own
    // cash-subtle tint. The amber-on-amber-subtle pair the other three
    // buckets already register — added with the account-table
    // row pattern (4.97:1). cash fg = warning-equivalent #975800.
    { name: 'badge amber text on amber-subtle', fg: '#975800', bg: '#ffeed6', kind: 'normal-text' },
    // The `tax_free` bucket chip (teal): the tax_free hue text on its own
    // tax_free-subtle tint — the 5th account-bucket hue, added for the HSA
    // account-table row tint (4.75:1). teal fg #00756b on subtle #cff4ef.
    { name: 'badge teal text on teal-subtle', fg: '#00756b', bg: '#cff4ef', kind: 'normal-text' },
    // Inverse Tooltip bubble — `surface` text on the `ink` fill.
    { name: 'tooltip text on ink bubble', fg: '#f9fafb', bg: '#0e1218', kind: 'normal-text' },
    // HSA account-category swatch (`bg-hsa`) on the dashboard by-account-type
    // card — a non-text decorative bar segment + legend swatch (the legend
    // text carries the meaning). A standalone account-CATEGORY green
    // (#097f23, mirroring `acctHsa`), NOT one of the four account-bucket
    // hues. 5.16:1 on the raised card surface.
    { name: 'hsa category swatch on card surface', fg: '#097f23', bg: '#ffffff', kind: 'non-text' },
  ],
  dark: [
    { name: 'body text on page bg', fg: '#edeef2', bg: '#08090c', kind: 'normal-text' },
    { name: 'body text on card surface', fg: '#edeef2', bg: '#121417', kind: 'normal-text' },
    { name: 'muted text on card surface', fg: '#a1a5ac', bg: '#121417', kind: 'normal-text' },
    { name: 'muted text on page bg', fg: '#a1a5ac', bg: '#08090c', kind: 'normal-text' },
    { name: 'heading text on page bg', fg: '#edeef2', bg: '#08090c', kind: 'normal-text' },
    { name: 'muted text on striped row', fg: '#a1a5ac', bg: '#040609', kind: 'normal-text' },
    // Accent link / active-nav text uses the lifted `accent-link` green
    // (the deep pine fill is unchanged in dark; only the link green lifts so
    // it stays legible on dark surfaces). 8.40:1 on card, higher on page bg.
    { name: 'accent link on card surface', fg: '#4ab689', bg: '#121417', kind: 'normal-text' },
    { name: 'accent link on page bg', fg: '#4ab689', bg: '#08090c', kind: 'normal-text' },
    // Primary button = WHITE label on the deep pine accent fill (same fill
    // as light). 7.06:1.
    { name: 'primary button label on accent', fg: '#ffffff', bg: '#0e6549', kind: 'normal-text' },
    // Link / active-nav text = lifted accent-link green on the dark accent
    // wash (bg-accent-subtle). 6.87:1.
    { name: 'accent link on accent wash', fg: '#4ab689', bg: '#002d1d', kind: 'normal-text' },
    // Sidebar active row = accent-link green label + icon on the dark accent
    // wash (repointed from text-positive).
    { name: 'active-nav text on accent wash', fg: '#4ab689', bg: '#002d1d', kind: 'normal-text' },
    // Show/Hide password toggle darkens its label to ink on hover (dark).
    { name: 'toggle hover label on accent wash', fg: '#edeef2', bg: '#002d1d', kind: 'normal-text' },
    // Danger / success filled-button labels use the `surface` token
    // (#08090c in dark) — the dark mirror of the light near-white label.
    { name: 'danger button label on danger', fg: '#08090c', bg: '#ef6661', kind: 'normal-text' },
    // Input control boundary (dark). #6d727a on the raised card #121417
    // = 3.81:1 (the card surface is the worst case). Decorative card
    // hairlines (`border-line`) stay unregistered (1.4.11-exempt).
    { name: 'input border on card surface', fg: '#6d727a', bg: '#121417', kind: 'non-text' },
    // Dark focus ring uses the lifted accent-link green (clears easily on
    // dark, 8.40:1).
    { name: 'focus ring on card surface', fg: '#4ab689', bg: '#121417', kind: 'non-text' },
    // Semantic gain/loss value text.
    { name: 'negative value text on card surface', fg: '#ef6661', bg: '#121417', kind: 'normal-text' },
    { name: 'negative value text on page bg', fg: '#ef6661', bg: '#08090c', kind: 'normal-text' },
    // Dark mirror of the light "negative value text on subtle surface"
    // (line ~150) — gates the Badge `negative` ("Needs attention" chip)
    // tone's dark-mode AA (~6.5:1).
    { name: 'negative value text on sunken surface', fg: '#ef6661', bg: '#040609', kind: 'normal-text' },
    { name: 'positive value text on card surface', fg: '#4cb86a', bg: '#121417', kind: 'normal-text' },
    { name: 'positive value text on page bg', fg: '#4cb86a', bg: '#08090c', kind: 'normal-text' },
    // Success button label — dark lime accent-ink mirror: white on the
    // dark positive green still reads.
    { name: 'success button label on success', fg: '#08090c', bg: '#4cb86a', kind: 'normal-text' },
    // ToggleSwitch (dark) — unchecked track input-line graphite, checked
    // track positive green. White thumb + track boundary vs the card.
    { name: 'switch thumb on unchecked track', fg: '#08090c', bg: '#6d727a', kind: 'non-text' },
    { name: 'switch thumb on checked track', fg: '#08090c', bg: '#4cb86a', kind: 'non-text' },
    { name: 'switch unchecked boundary on card surface', fg: '#6d727a', bg: '#121417', kind: 'non-text' },
    { name: 'switch checked boundary on card surface', fg: '#4cb86a', bg: '#121417', kind: 'non-text' },
    // Plan stress-test status ink on the raised stat-card surface.
    { name: 'stress status muted on stat card', fg: '#a1a5ac', bg: '#121417', kind: 'normal-text' },
    { name: 'stress status success on stat card', fg: '#4cb86a', bg: '#121417', kind: 'normal-text' },
    { name: 'stress status warning on stat card', fg: '#e9ab2b', bg: '#121417', kind: 'normal-text' },
    { name: 'stress status danger on stat card', fg: '#ef6661', bg: '#121417', kind: 'normal-text' },
    // Alert tones — state-token text on the dark sunken surface.
    { name: 'alert warning text on sunken', fg: '#e9ab2b', bg: '#040609', kind: 'normal-text' },
    { name: 'alert info text on sunken', fg: '#52b5f4', bg: '#040609', kind: 'normal-text' },
    // Type-coded Badge pills — the account-bucket hue text on its own
    // dark `-subtle` tint (iris/cyan/violet).
    { name: 'badge iris text on iris-subtle', fg: '#969fff', bg: '#1e2040', kind: 'normal-text' },
    { name: 'badge cyan text on cyan-subtle', fg: '#24c1c9', bg: '#002b2d', kind: 'normal-text' },
    { name: 'badge violet text on violet-subtle', fg: '#b688fe', bg: '#291c3c', kind: 'normal-text' },
    // The `cash` bucket chip (amber, dark): cash hue text on its dark
    // cash-subtle tint (7.73:1). Added with the account-table row pattern.
    { name: 'badge amber text on amber-subtle', fg: '#e9b452', bg: '#362607', kind: 'normal-text' },
    // The `tax_free` bucket chip (teal, dark): tax_free hue text on its dark
    // tax_free-subtle tint (6.87:1). teal fg #45c1b4 on subtle #002c27.
    { name: 'badge teal text on teal-subtle', fg: '#45c1b4', bg: '#002c27', kind: 'normal-text' },
    // Inverse Tooltip bubble — `surface` text on the `ink` fill.
    { name: 'tooltip text on ink bubble', fg: '#08090c', bg: '#edeef2', kind: 'normal-text' },
    // HSA account-category swatch (`bg-hsa`, dark #4cb86a) on the dark card
    // surface — non-text decorative bar segment + legend swatch. 7.36:1.
    { name: 'hsa category swatch on card surface', fg: '#4cb86a', bg: '#121417', kind: 'non-text' },
  ],
};

/**
 * Chart-series-vs-surface allowlist. Charts render on the
 * page background and on card surfaces; every chart series line / bar /
 * area stroke / reference-line marker is non-text UI that conveys
 * required information (which series is which, where a marker sits), so
 * WCAG 1.4.11 applies — `kind: 'non-text'`, threshold ≥ 3.0. The
 * registry is generated from the live `CHART_COLORS` map so it can
 * never drift from what charts actually paint: a future palette edit
 * that drops a key below 3.0 fails `contrast.test.ts`.
 *
 * Graphite Spectrum surfaces (sRGB of the styles.css OKLCH tokens):
 *   light → page `surface #f9fafb`, card `surface-raised #ffffff`
 *   dark  → page `surface #08090c`, card `surface-raised #121417`
 *
 * Excluded by construction: the translucent Monte Carlo band fills
 * (`mcBandOuter` / `mcBandInner`) — they are alpha wash painted over
 * the plot area for depth, not a discrete UI component or text; the
 * fan chart's *required* information (the typical-case median + the
 * percentile labels) is carried by the opaque `mcMedian` / marker
 * colors, which ARE gated here. Any new opaque chart key is gated
 * automatically; a new translucent band fill must stay rgba() (the
 * generator skips non-hex values and the test asserts that).
 */
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
    // Skip the translucent band fills (rgba()) — see the doc comment.
    if (!value.startsWith('#')) continue;
    out.push(
      { name: `chart ${key} on page bg`, fg: value, bg: page, kind: 'non-text' },
      { name: `chart ${key} on card surface`, fg: value, bg: card, kind: 'non-text' },
    );
  }
  return out;
}

export const CHART_CONTRAST_PAIRS: Record<
  'light' | 'dark',
  readonly ContrastPair[]
> = {
  light: buildChartPairs('light'),
  dark: buildChartPairs('dark'),
};
