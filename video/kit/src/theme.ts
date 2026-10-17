// Graphite Spectrum tokens, copied from apps/web/src/styles.css.
// `stage*` values are the app's dark theme (the video canvas); the rest are the
// light theme (the app windows that float on it).
/** Graphite Spectrum colour tokens: `stage*` for the video backdrop, the rest for the mock app. */
export const C = {
  stage: "oklch(0.14 0.008 264)",
  stageRaised: "oklch(0.19 0.008 264)",
  stageLine: "oklch(0.30 0.010 264)",
  stageInk: "oklch(0.95 0.005 264)",
  stageMuted: "oklch(0.72 0.012 264)",
  accent: "oklch(0.45 0.09 165)",
  accentInk: "oklch(0.99 0 0)",
  accentLinkDark: "oklch(0.70 0.12 163)",
  brand: "#0e6549",

  surface: "oklch(0.985 0.002 264)",
  surfaceRaised: "oklch(1 0 0)",
  surfaceSunken: "oklch(0.965 0.003 264)",
  overlay: "oklch(0.2 0.01 264 / 0.45)",
  line: "oklch(0.89 0.005 264)",
  lineStrong: "oklch(0.82 0.008 264)",
  inputLine: "oklch(0.62 0.012 264)",
  ink: "oklch(0.18 0.015 264)",
  muted: "oklch(0.47 0.012 264)",
  accentLink: "oklch(0.48 0.11 163)",
  accentSubtle: "oklch(0.95 0.03 165)",
  positive: "oklch(0.52 0.16 145)",
  warning: "oklch(0.52 0.13 70)",
  warningSubtle: "oklch(0.96 0.04 70)",

  pretax: "oklch(0.50 0.18 260)",
  roth: "oklch(0.46 0.20 320)",
  taxable: "oklch(0.50 0.13 200)",
  cash: "oklch(0.52 0.13 70)",
};

/** The app's UI typeface (loaded by `loadBrandFonts`). */
export const SANS = "'Hanken Grotesk', system-ui, sans-serif";
/** The app's monospace typeface (loaded by `loadBrandFonts`). */
export const MONO = "'JetBrains Mono', ui-monospace, monospace";
