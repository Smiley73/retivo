/**
 * Source-grep regression for the Graphite Spectrum `styles.css` shape.
 *
 * styles.css is the Tailwind v4 entry plus: self-hosted `@font-face`
 * declarations, an `@theme inline` semantic OKLCH token layer (the sole
 * color vocabulary), a `:root` / `.dark` variable swap, and a minimal
 * `@layer base` for the genuine globals that cannot be utilities. JSDOM
 * can't resolve `@import`ed Tailwind or pseudo-element computed styles,
 * so this reads the file as text.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'styles.css'), 'utf8');

describe('styles.css — Graphite Spectrum shape', () => {
  it('is the idiomatic Tailwind v4 entry with the dark custom-variant', () => {
    expect(css).toMatch(/@import\s+["']tailwindcss["'];/);
    expect(css).toMatch(/@custom-variant\s+dark\s+\(&:where\(\.dark, \.dark \*\)\);/);
  });

  it('self-hosts both variable fonts via @font-face', () => {
    expect(css).toMatch(/@font-face\s*\{/);
    expect(css).toMatch(/font-family:\s*'Hanken Grotesk'/);
    expect(css).toMatch(/font-family:\s*'JetBrains Mono'/);
    expect(css).toMatch(/\/fonts\/hanken-grotesk-var\.woff2/);
    expect(css).toMatch(/\/fonts\/jetbrains-mono-var\.woff2/);
    expect(css).toMatch(/format\('woff2-variations'\)/);
  });

  it('declares the @theme inline semantic token layer', () => {
    expect(css).toMatch(/@theme inline\s*\{/);
    // The semantic color vocabulary the whole app styles with.
    expect(css).toMatch(/--color-surface:/);
    expect(css).toMatch(/--color-surface-raised:/);
    expect(css).toMatch(/--color-ink:/);
    expect(css).toMatch(/--color-muted:/);
    expect(css).toMatch(/--color-line:/);
    expect(css).toMatch(/--color-input-line:/);
    expect(css).toMatch(/--color-accent:/);
    expect(css).toMatch(/--color-accent-ink:/);
    // Account bucket hues.
    expect(css).toMatch(/--color-pretax:/);
    expect(css).toMatch(/--color-roth:/);
    expect(css).toMatch(/--color-taxable:/);
    expect(css).toMatch(/--color-cash:/);
    // HSA account-category color (dashboard by-account-type card only —
    // a standalone category color, NOT a fifth account-bucket hue).
    expect(css).toMatch(/--color-hsa:/);
    // Typography tokens.
    expect(css).toMatch(/--font-sans:\s*'Hanken Grotesk'/);
    expect(css).toMatch(/--font-mono:\s*'JetBrains Mono'/);
  });

  it('defines a :root light theme and a .dark variable swap', () => {
    expect(css).toMatch(/:root\s*\{/);
    expect(css).toMatch(/\.dark\s*\{/);
    // OKLCH is the token color space.
    expect(css).toMatch(/oklch\(/);
  });

  it('carries no retired Tailwind-default slate/indigo palette refs', () => {
    expect(css).not.toMatch(/var\(--color-slate-/);
    expect(css).not.toMatch(/var\(--color-indigo-/);
  });

  it('retains only the genuine globals inside @layer base', () => {
    expect(css).toMatch(/@layer base\s*\{/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/\.scenario-tree__slot--connector::after\s*\{/);
    expect(css).toMatch(/\.chart-marker-label\s*\{/);
  });

  it('re-tokens the genuine globals to the semantic vars (no raw hex)', () => {
    // File-tree rails + the chart-label halo reference the semantic
    // tokens, not raw hex or the retired slate scale.
    expect(css).toMatch(/border-left:\s*1px solid var\(--color-line-strong\)/);
    expect(css).toMatch(/stroke:\s*var\(--color-surface-raised\)/);
  });

  it('keeps the legacy bespoke component/page classes deleted', () => {
    expect(css).not.toMatch(/\.card\s*\{/);
    expect(css).not.toMatch(/\.btn--sm\s*\{/);
    expect(css).not.toMatch(/\.field-group\s*\{/);
    expect(css).not.toMatch(/\.badge\s*\{/);
    expect(css).not.toMatch(/\.range-slider\s*\{/);
    expect(css).not.toMatch(/--range-pct\b/);
  });
});

describe('styles.css — Balance Projection tab-panel screen-only hide (02)', () => {
  it('keys the non-selected panel hide off [data-inert], is screen-scoped, and never uses display:none', () => {
    const match = css.match(
      /@media screen\s*\{\s*\.bp-view-panel\[data-inert\]\s*\{([^}]*)\}\s*\}/,
    );
    expect(match).not.toBeNull();
    const declarations = match![1];
    // Positioned so absolutely positioned descendants (sr-only spans) are
    // clipped with the panel instead of stretching the document's scroll
    // height from the page root.
    expect(declarations).toMatch(/position:\s*relative/);
    expect(declarations).toMatch(/height:\s*0/);
    expect(declarations).toMatch(/overflow:\s*hidden/);
    expect(declarations).toMatch(/visibility:\s*hidden/);
    expect(declarations).not.toMatch(/display:\s*none/);
  });
});
