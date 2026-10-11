/**
 * Shared chrome for the accounts / balances / contributions area (Graphite
 * Spectrum semantic tokens). The
 * semantic-token replacement for the legacy global `button` /
 * `button.secondary` / `button.danger` / `input` / `select` /
 * `textarea` / `table` reset that these pages leaned on implicitly.
 *
 * Why a chrome module (not inline strings everywhere): these
 * pages share the same control vocabulary (primary / secondary / danger
 * buttons, a native text input, a native select, a data table, a
 * dimmed-inactive table row). Centralising the class strings keeps the
 * code DRY and — critically — keeps the two already-oversized pages
 * (`AccountBalancesPage`, `BalanceProjectionPage`) from growing as
 * the legacy classes are replaced by longer utility strings. Mirrors
 * the established `auth-page-chrome.tsx` pattern.
 *
 * Visual style only — no behavioral contract. Every fg/bg pair is an
 * AA-safe Graphite Spectrum pair from apps/web/src/lib/contrast.ts.
 */
import React from 'react';
import { Column, TableHeader } from 'react-aria-components';
import { Field } from '../components/Field';
import { CheckIcon } from '../components/icons';
import { Muted } from '../components/Muted';
import { formatPercent } from '../components/PercentInput';
import { TextInput } from '../components/TextInput';
import type { AccountBucket } from '../lib/account-bucket';

/**
 * Primary action button (legacy default `button`). The lime accent fill
 * with the dark `accent-ink` label (`bg-accent text-accent-ink`, 7.97:1
 * light / 10.68:1 dark — the bright lime is too light for white text).
 * Dark mode is the same tokens re-pointed by the `.dark` variable swap;
 * no `dark:` twins. Registered "primary button label on accent" in
 * contrast.ts.
 */
export const btnPrimaryClass =
  'inline-flex items-center justify-center rounded-md ' +
  'bg-accent px-4 py-2 text-sm font-medium text-accent-ink shadow-sm ' +
  'transition-colors hover:bg-accent/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/** Outlined secondary button (legacy `button.secondary`) — raised
 *  surface, strong hairline, iris ink. */
export const btnSecondaryClass =
  'inline-flex items-center justify-center rounded-md ' +
  'border border-line-strong bg-surface-raised px-4 py-2 text-sm font-medium text-accent-link ' +
  'transition-colors hover:bg-surface-sunken focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Destructive button (legacy `button.danger`). The `surface` token as the
 * label on the negative red fill (`bg-negative text-surface`) — near-white
 * in light, near-black in dark via the `.dark` variable swap, so a single
 * token reads in both themes. Registered "danger button label on danger"
 * in contrast.ts.
 */
export const btnDangerClass =
  'inline-flex items-center justify-center rounded-md ' +
  'bg-negative px-4 py-2 text-sm font-medium text-surface shadow-sm ' +
  'transition-colors hover:bg-negative/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Primary toolbar-variant button — a **standalone** class string used
 * **instead of** `btnPrimaryClass` (not concatenated) on Run / Cancel /
 * toolbar buttons sitting beside a `<SegmentedRadioGroup>` so their
 * outer height matches the radio group exactly. Replaces the legacy
 * `${btnPrimaryClass} ${btnMdClass}` concatenation pattern.
 *
 * Height-parity math (34px on both sides):
 *   - `<SegmentedRadioGroup>` outer = 1px border + 2px p-0.5 + 4px py-1
 *     (each side) + 20px text-sm line-height = 34px.
 *   - Toolbar button = 1px transparent border + 8px py-2 (each side)
 *     + 16px text-xs line-height = 34px.
 *
 * Why standalone, not `${btnPrimaryClass} ${btnMdClass}`: Tailwind v4
 * emits same-specificity utility rules in numeric source order
 * (verified — `.px-3` and `.py-1` emit before `.px-4` and `.py-2` in
 * the built `dist/assets/*.css`). With equal specificity, the **later**
 * rule wins regardless of className-string order, so the old
 * `${btnPrimaryClass} ${btnMdClass}` concatenation silently rendered
 * the role class's `px-4 py-2 font-medium` and never the toolbar
 * modifier's `px-3 py-1`. A standalone class has no override question.
 *
 * AA contrast pair (already registered in `lib/contrast.ts` — the same
 * "primary button label on accent" pair `btnPrimaryClass` uses, no
 * allowlist update needed): `accent-ink` on the lime `accent` fill,
 * 7.97:1 light / 10.68:1 dark.
 *
 * No `font-medium` — the toolbar variant deliberately stays at the
 * default weight so a Run button doesn't read bolder than the radios
 * beside it. See "Buttons and destructive actions" in docs/ui-conventions.md.
 */
export const btnPrimaryToolbarClass =
  'inline-flex items-center justify-center rounded-md ' +
  'border border-transparent bg-accent px-3 py-2 text-xs text-accent-ink shadow-sm ' +
  'transition-colors hover:bg-accent/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Destructive toolbar-variant button — standalone counterpart to
 * `btnPrimaryToolbarClass` for Cancel buttons sitting beside a
 * `<SegmentedRadioGroup>` (matches the same 34px outer height — see
 * the height-parity math on `btnPrimaryToolbarClass`).
 *
 * AA contrast pair (already registered in `lib/contrast.ts` — the same
 * "danger button label on danger" pair `btnDangerClass` uses, no
 * allowlist update needed): the `surface` token on the negative red fill.
 *
 * Used **instead of** `btnDangerClass` (not concatenated) for the same
 * Tailwind v4 source-order-cascade reason documented on
 * `btnPrimaryToolbarClass`. No `font-medium`. See "Buttons and destructive actions" in docs/ui-conventions.md.
 */
export const btnDangerToolbarClass =
  'inline-flex items-center justify-center rounded-md ' +
  'border border-transparent bg-negative px-3 py-2 text-xs text-surface shadow-sm ' +
  'transition-colors hover:bg-negative/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Primary action button at the small size (row / inline actions). A
 * **standalone** class string — not `${btnPrimaryClass} ${btnSmClass}` —
 * because Tailwind v4 emits same-specificity utilities in numeric source
 * order, so the role class's `px-4 py-2` would beat the fragment's
 * `px-2.5 py-1` regardless of className order (the concat path was a
 * silent no-op on padding). Byte-identical to `btnPrimaryClass` except
 * the compact sizing (`px-2.5 py-1 text-xs`, no `font-medium`), so the
 * AA-safe fg/bg pair is unchanged. See "Buttons and destructive actions" in docs/ui-conventions.md.
 */
export const btnPrimarySmClass =
  'inline-flex items-center justify-center rounded-md ' +
  'bg-accent px-2.5 py-1 text-xs text-accent-ink shadow-sm ' +
  'transition-colors hover:bg-accent/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Outlined secondary button at the small size (row actions). Standalone
 * string (see `btnPrimarySmClass` for the Tailwind-v4 source-order
 * rationale) — byte-identical to `btnSecondaryClass` except the compact
 * sizing (`px-2.5 py-1 text-xs`, no `font-medium`); AA-safe pair
 * unchanged.
 */
export const btnSecondarySmClass =
  'inline-flex items-center justify-center rounded-md ' +
  'border border-line-strong bg-surface-raised px-2.5 py-1 text-xs text-accent-link ' +
  'transition-colors hover:bg-surface-sunken focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Destructive button at the small size (row actions). Standalone string
 * (see `btnPrimarySmClass` for the Tailwind-v4 source-order rationale) —
 * byte-identical to `btnDangerClass` except the compact sizing
 * (`px-2.5 py-1 text-xs`, no `font-medium`); AA-safe pair unchanged.
 */
export const btnDangerSmClass =
  'inline-flex items-center justify-center rounded-md ' +
  'bg-negative px-2.5 py-1 text-xs text-surface shadow-sm ' +
  'transition-colors hover:bg-negative/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Native text / number input (legacy global `input` reset). The control
 * boundary uses the dedicated `input-line` token (darker than the
 * decorative `line`) so it clears the WCAG 1.4.11 non-text 3.0 gate in
 * both themes — registered "input border on …" pairs in contrast.ts.
 * Dark mode is the `.dark` variable swap; no `dark:` twins.
 */
export const inputClass =
  'block w-full min-w-0 rounded-md border border-input-line bg-surface px-3 py-2 ' +
  'text-ink placeholder:text-muted ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted';

/**
 * Numeric-entry variant of `inputClass` — adds `font-mono tabular-nums` so
 * editable comparands (asset-mix %, planning return %) render in JetBrains
 * Mono with tabular widths, matching the read-only mono cells they sit
 * beside (see "Typography" in docs/ui-conventions.md).
 * The dedicated money/percent controls (`MoneyInput`, `PercentInput`) carry
 * their own mono input class; this is for the plain `<TextInput>` numeric
 * fields in the account form.
 */
export const inputNumericClass = `${inputClass} font-mono tabular-nums`;

/** Data table (legacy global `table` reset). */
export const tableClass =
  'w-full border-collapse text-left text-sm text-ink';

/**
 * Header cell (legacy `th`: mono, uppercase, small). The mono /
 * uppercase / tracking is the legacy technical-metadata treatment —
 * retained here as a header convention, not a visual constitution rule.
 */
export const thClass =
  'border-b border-line px-3 py-2 font-mono text-xs font-medium ' +
  'uppercase tracking-wide text-muted';

/** Body cell (legacy `td`). */
export const tdClass = 'border-b border-line px-3 py-2';

/** Right-aligned numeric body cell — `font-mono tabular-nums` renders the
 *  figures in JetBrains Mono with tabular widths so columns a user compares
 *  vertically stay aligned (see "Typography" in
 *  docs/ui-conventions.md). Matches the mono comparands the KPI surfaces already
 *  use (`StatGrid`/`TotalsRow` values, the dashboard KV/allocation rows). */
export const tdNumClass = `${tdClass} text-right font-mono tabular-nums`;

/** Right-aligned numeric header cell. */
export const thNumClass = `${thClass} text-right`;

/**
 * Section heading (`<h2>`) for the Balance Projection chart bands. Matches the
 * inline chart-section headings on `balance-projection-page-yearly-*`
 * (text-base font-semibold); promoted from h3 → h2 because the outer
 * card-section no longer renders a duplicate title. Shared by the tax-detail,
 * tax-burden, and account-balance-stack bands.
 */
export const bandSectionH2Class =
  'm-0 text-base font-semibold text-ink';

/**
 * Sticky token vocabulary. The
 * `<TableScroll>` wrapper is the scroll-region landmark only;
 * sticky-thead / sticky-tfoot positioning is opt-in per-callsite via
 * these utility classes on the RA Table's `<Column>` (`thStickyClass` /
 * `thStickyNumClass`) and the final totals `<Row>` (`rowStickyBottomClass`).
 *
 * The `bg-surface-sunken` background gives the header row a distinct shade
 * so it reads as the column label band rather than a data row; `z-10` keeps
 * the sticky cells above the scrolling body rows. Pair with `<TableScroll>`
 * only — consumers outside a scroll region use the non-sticky
 * `thClass`/`thNumClass`.
 *
 * No `rowStickyTopClass`: only `<Column>`s stick at the top, not body
 * rows. Sticky-bottom applies to the final totals `<Row>` only.
 */
export const thStickyClass = `${thClass} sticky top-0 z-10 bg-surface-sunken`;
export const thStickyNumClass = `${thNumClass} sticky top-0 z-10 bg-surface-sunken`;
export const rowStickyBottomClass = 'sticky bottom-0 z-10 bg-surface-raised';

/**
 * Totals-row tint for the final `<Row>` in a `<TableBody>` (per-account
 * summary breakdowns + year-by-year totals). The `surface-sunken` shade
 * makes the totals row read as a discrete band, not a body row. Combine
 * with `rowStickyBottomClass` for in-scroll totals (later utilities win in
 * the Tailwind cascade — the sunken tint overrides the sticky-class's
 * raised surface).
 */
export const rowTotalsClass = 'bg-surface-sunken font-semibold';

/**
 * Dimmed text for an inactive table row (legacy `tr.is-inactive > td`:
 * muted text, slightly faded badge). Applied to each `<td>` so the row
 * reads as de-emphasised but still legible.
 */
export const inactiveRowCellClass = 'text-muted';

/**
 * Even-row zebra stripe (1-based: the 2nd, 4th, … `<tr>`). Reuses the
 * exact `surface-sunken` tone the Balance Projection tables' totals row
 * already ships so the page reads as one striped surface; odd rows keep
 * the default card surface. A legibility behavior (track a value across
 * its row), applied to `<tbody>` rows only. The muted-on-stripe fg/bg pairs
 * are registered in `lib/contrast.ts`.
 */
const stripeRowClass = 'bg-surface-sunken';

/**
 * Even-row (1-based: 2nd, 4th, …) stripe class for a `<tr>` at the
 * given 0-based body-row index, else `bg-surface-raised` (odd rows get
 * an explicit white surface so they stay visually distinct from the
 * shaded header). The single source of the striping rule —
 * both Balance Projection `<tbody>` call sites (per-account breakdown +
 * year-by-year) route through this so the rule has one tested
 * definition and cannot drift between them.
 */
export const stripeRowFor = (index: number): string =>
  index % 2 === 1 ? stripeRowClass : 'bg-surface-raised';

/** Semantic positive (gain) value text — AA-safe `positive` token. */
export const valuePositiveClass = 'text-positive';

/** Semantic negative (loss / danger) value text — AA-safe `negative` token. */
export const valueNegativeClass = 'text-negative';

/** Breadcrumb / sub-nav line above a page title. */
export const breadcrumbNavClass =
  'mb-1 text-sm text-muted ' +
  '[&_a]:text-accent-link [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:no-underline ' +
  '[&_a]:rounded-sm [&_a]:focus-visible:outline-none [&_a]:focus-visible:ring-2 ' +
  '[&_a]:focus-visible:ring-ring [&_a]:focus-visible:ring-offset-2';

/* ===========================================================================
 * Account-table row pattern. The shared
 * left bucket-bar + hover-revealed icon row-actions used by the two
 * flagship account tables (Accounts list + Account Balances list); other
 * account-area tables reuse these.
 * ========================================================================= */

/** Bucket → bucket-bar / icon fill utility. The four account-bucket hues
 *  from the token layer (iris / violet / cyan / amber). */
const BUCKET_BAR_BG: Record<AccountBucket, string> = {
  pretax: 'bg-pretax',
  roth: 'bg-roth',
  taxable: 'bg-taxable',
  cash: 'bg-cash',
  tax_free: 'bg-tax_free',
};

/**
 * The 3px bucket-colored bar pinned to the left edge of a row's first
 * cell (the mock `.bucket-bar`). Absolutely positioned, so the host
 * `<Cell>` MUST be `relative` (the account tables add `relative` to the
 * name cell). `aria-hidden` — purely decorative; the bucket meaning is
 * already conveyed by the type chip's tint + label, so the bar adds no
 * new information for assistive tech.
 *
 * The 3px width / 6px top-bottom inset / pill radius are exact mock
 * values with no nearest-token equivalent (Tailwind's `w-px`=1px /
 * `w-0.5`=2px / `w-1`=4px all miss 3px materially for a hairline
 * accent), so they ride a single arbitrary-value class with the
 * mock-reason disable.
 */
export const BucketBar: React.FC<{ bucket: AccountBucket }> = ({ bucket }) => (
  <span
    aria-hidden="true"
    // eslint-disable-next-line no-restricted-syntax -- exact mock .bucket-bar geometry (3px bar, 6px inset, pill radius) has no nearest-token equivalent
    className={`absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full ${BUCKET_BAR_BG[bucket]}`}
  />
);

/**
 * Icon row-action button (the mock `.iact`): a 30px-ish square ghost
 * button — `size-8` (32px) is the nearest default-scale token, the 2px
 * difference from the mock's 30px is immaterial for a hit target (and
 * keeps it at/above the 24px min). Muted glyph on the card surface with a
 * hairline border; `grid place-items-center` centers the 15px SVG. Hover
 * tint is layered on per-action by the edit / delete variants below.
 *
 * The `muted` glyph and `line` border on the card surface are AA pairs
 * already in `contrast.ts`. Used on a `group/row` row inside the
 * `.row-actions` cluster (styles.css) so the cluster reveals on
 * hover / focus-within (pointer) and stays visible on touch.
 */
const iactClass =
  'inline-grid size-8 place-items-center rounded-lg ' +
  'border border-line bg-surface ' +
  'transition-colors focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** Neutral (view / info) variant — muted glyph for the read-only "view
 *  balances" affordance on inactive accounts; stays muted, gentle hover. */
export const iactViewClass = `${iactClass} text-muted hover:border-line-strong hover:bg-surface-sunken hover:text-ink`;

/** Edit-icon variant — the glyph carries its semantic colour the moment the
 *  row reveals its actions (the mock's positive `.iact:not(.del)` green), not
 *  only on icon-hover; hover deepens the fill. */
export const iactEditClass = `${iactClass} text-positive hover:border-positive/40 hover:bg-positive/10`;

/** Delete-icon variant — red whenever visible (not hover-only), per the
 *  destructive-affordance convention; hover deepens the red fill. */
export const iactDeleteClass = `${iactClass} text-negative hover:border-negative/40 hover:bg-negative/10`;

/** Pencil (edit) glyph — Heroicons-style outline, 15px, decorative
 *  (`aria-hidden`; the host control carries the accessible name). */
export const PencilIcon: React.FC = () => (
  <svg
    aria-hidden="true"
    focusable="false"
    viewBox="0 0 20 20"
    fill="currentColor"
    width={15}
    height={15}
  >
    <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793 3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
  </svg>
);

/** Trash (delete) glyph — Heroicons-style outline, 15px, decorative. */
export const TrashIcon: React.FC = () => (
  <svg
    aria-hidden="true"
    focusable="false"
    viewBox="0 0 20 20"
    fill="currentColor"
    width={15}
    height={15}
  >
    <path
      fillRule="evenodd"
      d="M8.75 1a1 1 0 00-.95.69L7.56 2.5H4a1 1 0 000 2h.12l.78 11.07A2 2 0 006.9 17.5h6.2a2 2 0 002-1.93L15.88 4.5H16a1 1 0 100-2h-3.56l-.24-.81A1 1 0 0011.25 1h-2.5zM7.92 6.5a.75.75 0 011.5 0v6a.75.75 0 01-1.5 0v-6zm3.16 0a.75.75 0 00-1.5 0v6a.75.75 0 001.5 0v-6z"
      clipRule="evenodd"
    />
  </svg>
);

/** Eye (view) glyph — Heroicons-style outline, 15px, decorative. Used
 *  on inactive Account Balances rows whose action is view-only. */
export const EyeIcon: React.FC = () => (
  <svg
    aria-hidden="true"
    focusable="false"
    viewBox="0 0 20 20"
    fill="currentColor"
    width={15}
    height={15}
  >
    <path d="M10 4c-3.86 0-7.16 2.4-8.5 5.78a.8.8 0 000 .44C2.84 13.6 6.14 16 10 16s7.16-2.4 8.5-5.78a.8.8 0 000-.44C17.16 6.4 13.86 4 10 4zm0 9.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7zm0-1.75a1.75 1.75 0 100-3.5 1.75 1.75 0 000 3.5z" />
  </svg>
);

/**
 * Annual-Contributions "Remaining" stat-tile copy. A negative remaining
 * means the account was over-funded: the tile relabels to "… Overpaid"
 * and shows the absolute amount (an "Overpaid −$1,234" reads as a
 * contradiction), keeping the red `valueNegativeClass` so it still
 * flags as needing attention. Non-negative tiles are unchanged.
 * Extracted from `AccountContributionsPage` so that page stays under
 * the ≤400-line shape limit (same rationale as `AssetMixFieldGroup`).
 * Pure display helpers — no behavioral contract.
 */
export const remainingLabel = (prefix: string, v: number): string =>
  v < 0 ? `${prefix} Overpaid` : `${prefix} Remaining`;

/**
 * The over-funded tile shows the absolute amount; non-negative tiles
 * format the value as-is. `formatCurrency` is injected so this stays a
 * pure string helper free of the page's currency-format import.
 */
export const remainingText = (
  v: number,
  formatCurrency: (n: number) => string,
): string => (v < 0 ? formatCurrency(Math.abs(v)) : formatCurrency(v));

/**
 * Stacks a "Remaining" group word over its leaf so a long compound
 * header reads as two tidy lines (`Remaining` / `Pre-tax`) instead of
 * wrapping raggedly mid-word. The group line is de-emphasised with
 * `font-normal` against the leaf's inherited `font-medium` — it keeps
 * `thClass`'s AA-safe `muted` colour rather than a lighter shade,
 * so it stays within the contrast allowlist. The compound
 * accessible name is preserved by the whitespace node between the two
 * spans (adjacent spans would concatenate to "RemainingPre-tax"); this
 * is otherwise purely visual.
 */
const stackedHeader = (group: string, leaf: string): React.ReactNode => (
  <>
    <span className="block font-normal">{group}</span>
    {/* Whitespace node so the accessible name reads "Remaining Pre-tax"
        (adjacent spans would otherwise concatenate to "RemainingPre-tax").
        Guarded by the columnheader-name assertion in
        AccountContributionsPage.test.tsx. */}
    {' '}
    <span className="block">{leaf}</span>
  </>
);

/**
 * The Annual-Contributions table's single DOM header row for the
 * migrated React Aria `<Table>`
 * Returns the RA `<TableHeader>` element so
 * consumers slot it directly inside `<Table>` alongside their own
 * `<TableBody>`.
 *
 * React Aria renders a single `<thead>` row, so the legacy `Remaining`
 * colgroup parent cannot span its Pre-tax / Post-tax / Total leaves.
 * The grouping lives in the compound accessible name
 * (`Remaining Pre-tax`, …), which `stackedHeader` preserves by keeping
 * a space between its two visible lines; `textValue` keeps typeahead in
 * sync. All cells are `align-bottom` so every leaf sits on one shared
 * bottom line and the header reads as an intentional group rather than
 * ragged wrapping.
 */
export const ContributionsTableHead: React.FC = () => {
  // Sticky-top variants: the Annual-Contributions table is framed by a
  // scrolling <TableScroll>, so its headers must pin like
  // every other scrolling data table. The opaque bg keeps the two stacked
  // header lines readable over scrolled body rows.
  const head = `${thStickyClass} align-bottom`;
  const headNum = `${thStickyNumClass} align-bottom`;
  // Centered variant for the contribution-amount + annual-increase headers
  // (thStickyClass carries no text-align, so text-center wins cleanly).
  const headCentered = `${thStickyClass} align-bottom text-center`;
  return (
    <TableHeader>
      <Column isRowHeader className={head}>
        Name
      </Column>
      <Column className={head}>Owner</Column>
      <Column className={head}>Type</Column>
      <Column className={headCentered}>Pre-Tax</Column>
      <Column className={headCentered}>Post-Tax</Column>
      <Column className={headCentered} textValue="Annual increase">
        {stackedHeader('Annual', 'increase')}
      </Column>
      <Column className={headNum} textValue="Remaining Pre-tax">
        {stackedHeader('Remaining', 'Pre-tax')}
      </Column>
      <Column className={headNum} textValue="Remaining Post-tax">
        {stackedHeader('Remaining', 'Post-tax')}
      </Column>
      <Column className={headNum} textValue="Remaining Total">
        {stackedHeader('Remaining', 'Total')}
      </Column>
    </TableHeader>
  );
};

type MixKey = 'assetMixStocks' | 'assetMixBonds' | 'assetMixCash';
const MIX_FIELDS: ReadonlyArray<{ label: string; key: MixKey }> = [
  { label: 'Stocks', key: 'assetMixStocks' },
  { label: 'Bonds', key: 'assetMixBonds' },
  { label: 'Cash', key: 'assetMixCash' },
];

interface AssetMixFieldGroupProps {
  values: Record<MixKey, string>;
  onFieldChange: (key: MixKey, raw: string) => void;
  /** One-decimal normalise on blur (preserved input behavior). */
  onFieldBlur: (key: MixKey) => void;
  mixSum: number;
  isMixValid: boolean;
}

/**
 * The Account form's "Asset allocation" field group, extracted so the
 * already-oversized `AccountFormModal` does not grow. WAI-ARIA group
 * (the preserved `<div role="group">` + `<header>` pattern, NOT a
 * `<fieldset>`); deterministic flex layout from first paint.
 */
export const AssetMixFieldGroup: React.FC<AssetMixFieldGroupProps> = ({
  values,
  onFieldChange,
  onFieldBlur,
  mixSum,
  isMixValid,
}) => (
  <div
    role="group"
    aria-labelledby="asset-mix-heading"
    className="mb-3 flex flex-col gap-2 rounded-md border border-line bg-surface-sunken p-3"
  >
    <header
      id="asset-mix-heading"
      className="text-sm font-semibold text-ink"
    >
      Asset allocation
    </header>
    <Muted as="p" className="text-sm">
      Drives the Monte Carlo projection. Must sum to 100%.
    </Muted>
    <div className="flex flex-wrap items-start gap-3">
      {MIX_FIELDS.map(({ label, key }) => (
        <Field
          key={label}
          htmlFor={`mix-${label}`}
          label={`${label} %`}
          className="min-w-28"
        >
          <TextInput
            id={`mix-${label}`}
            inputMode="decimal"
            pattern="[0-9]*[.,]?[0-9]*"
            value={values[key]}
            onChange={(e) => onFieldChange(key, e.target.value)}
            onBlur={() => onFieldBlur(key)}
            className={inputNumericClass}
          />
        </Field>
      ))}
    </div>
    <div
      className={
        isMixValid
          ? 'text-sm text-muted'
          : 'text-sm text-negative'
      }
    >
      Total: {formatPercent(mixSum)}{' '}
      {isMixValid ? (
        <span className="inline-flex items-center gap-1 text-positive">
          <CheckIcon />
          Valid
        </span>
      ) : (
        'must equal 100%'
      )}
    </div>
  </div>
);
