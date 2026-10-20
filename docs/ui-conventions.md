# UI conventions

Read this before you change UI code or review a UI diff. It covers the rules
that are not obvious from a single component. The look of the app is in
[DESIGN.md](DESIGN.md). The product goals are in [PRODUCT.md](PRODUCT.md).

This page is written from the code. If the code and the page disagree, fix the
page.

## Semantic tokens

All colour comes from the tokens in [styles.css](../apps/web/src/styles.css).
Tailwind turns each token into a utility such as `bg-surface`.

| Family | Tokens |
|---|---|
| Surfaces and lines | `surface`, `surface-raised`, `surface-sunken`, `overlay`, `line`, `line-strong`, `input-line` |
| Text | `ink`, `ink-faint`, `muted` |
| Accent | `accent` (a fill), `accent-ink` (the label on it), `accent-link` (link, secondary-button and active-nav text), `accent-subtle` (a wash) |
| States | `positive`, `negative`, `warning`, `info` |
| Account buckets | `pretax`, `roth`, `taxable`, `cash`, `tax_free`, each with a `-subtle` tint |
| Account category | `hsa`, `hsa-subtle`: only the dashboard by-account-type card |
| Focus ring | `ring`, `ring-offset` |
| Fonts | `font-sans` (Hanken Grotesk), `font-mono` (JetBrains Mono) |

`tax_free` is the teal bucket hue that tints HSA rows in the account tables.
`hsa` is a separate green for the dashboard card. Do not swap them.

- **Dark mode is a variable swap.** The `.dark` class on `<html>` re-points the
  tokens. Colour utilities have no `dark:` twin. Do not add one.
- **Raw `slate-*` and `indigo-*` are retired.** Use a token.
- **No inline `style`, arbitrary-value utility or arbitrary-property utility.**
  ESLint enforces it with `no-restricted-syntax`. `…-[var(--*)]` is allowed. A
  value that cannot be a token or a default-scale utility, such as a portal
  z-index, gets a per-line `eslint-disable-next-line` with a reason. Off-token
  colours need a rationale on the line too. Never disable a whole file.
- **The SVG chart engine has one exception.** It places the tooltip and the
  crosshair at positions it works out while drawing. Those few inline styles in
  `components/charts/` are allowed, and each still carries a per-line disable.
- **Do not add a bespoke component class to `styles.css`.** Use the shared
  components, utilities and the `@layer base` globals already there.

## Contrast

[contrast.ts](../apps/web/src/lib/contrast.ts) holds two registries.
`contrast.test.ts` checks every pair in both themes.

- **`UI_CONTRAST_PAIRS`** lists the foreground and background pairs the UI
  paints, for `light` and `dark`. An entry has `name`, `fg`, `bg` and `kind`.
  The hex values are the sRGB rendering of the matching token. The kind sets the
  threshold: `normal-text` 4.5, `large-text` 3.0, `non-text` 3.0 (borders, focus
  rings, icons).
- **`CHART_CONTRAST_PAIRS`** is built from the chart colour map. Every opaque
  chart colour is checked against the page and card surface, both themes, as
  `non-text` at 3.0. A new opaque chart colour is gated with no extra work. The
  translucent Monte Carlo band fills are `rgba()` and are left out on purpose.
  A new translucent fill must stay `rgba()`.

**A new colour pair lands in `UI_CONTRAST_PAIRS` in the same PR.**

**Decorative borders are exempt.** Card, panel, dialog and divider hairlines use
`border-line`. The container is clear from its fill, shadow and spacing, so
WCAG 1.4.11 does not apply and `line` is not registered. A border that is the
only sign of an interactive boundary must use a registered 3.0 token. Control
borders use `input-line` for this reason.

**Buttons register their label on the fill.** Primary is `accent-ink` on
`accent`. Danger and success use the `surface` token as the label, so one
utility reads in both themes.

## Chart colours

Charts never read CSS variables at run time.

- [tokens.ts](../apps/web/src/lib/tokens.ts) holds `CHART_COLORS` and
  `CHART_CHROME`, each with a `light` and a `dark` map. This is the JS mirror of
  the tokens. Add every new chart colour to both maps.
- [use-chart-tokens.ts](../apps/web/src/lib/use-chart-tokens.ts) holds the
  hooks `useChartColors()` and `useChartChrome()`. They read `useTheme()`, so a
  chart redraws on a theme change.
- **Pure builders cannot call hooks.** The marker builders run inside
  `useMemo`. They take the resolved theme as an explicit argument, for example
  `lifeMarkerColors(theme)`. The component passes `resolvedTheme` and lists it in
  the `useMemo` dependencies, so colours flip on a live toggle. The expense
  category palette, `categoryPaletteFor(theme)`, works the same way.
- **PDF export is always light.** The off-screen render host wraps its charts in
  `ForcedThemeProvider resolvedTheme="light"` from
  [ThemeContext.tsx](../apps/web/src/contexts/ThemeContext.tsx). That provider
  leaves `<html>` and local storage alone. Print neutrals, such as table
  borders, are in `PDF_LIGHT_COLORS` in `lib/pdf-export/pdf-colors.ts`.

**Gotcha: `tokens.ts` must not import a `.tsx` file.** The optimiser worker
bundle reaches `tokens.ts`. A `.tsx` import such as `ThemeContext.tsx` pulls the
React Refresh runtime into the worker, which then fails at start with a `window`
error. That is why the hooks live in their own file. Chart code imports hooks
from `use-chart-tokens`. Worker-safe code imports values and types from
`tokens`.

## Theme

- The choice is `light`, `dark` or `system`. The default is `system`.
- It is stored per device in local storage under `retivo.theme.<userId>`, or
  `retivo.theme.anonymous` before sign-in. There is no API call. The provider
  re-keys on sign-in and reads the stored choice synchronously on first render.
- `useTheme()` returns `theme` (the choice), `resolvedTheme` (what is applied)
  and `setTheme`.
- `system` is resolved with `matchMedia('(prefers-color-scheme: dark)')`. The
  provider listens for changes only while the choice is `system`. CSS never uses
  that query to change colours.
- The picker is in the Appearance card on the Preferences page: a
  `SegmentedRadioGroup` with `ariaLabel="Theme"`.
- One global `prefers-reduced-motion` rule in `styles.css` cuts motion. Do not
  gate single components on it.

## Typography

- The page baseline is `text-sm`: labels, table text, `Muted` copy, card text,
  alerts and every shared control.
- Exceptions: page titles from `PageHeader` and subheadings, deliberate `text-xs`
  helper copy through `Muted`, fine print in a `role="note"` disclaimer card, and
  compact toolbar buttons.
- Never use `text-base` or larger on body copy. Text with no size falls back to
  16px and looks too big.
- **Numbers that people compare use `font-mono tabular-nums`**: balances,
  percentages, ages and timestamps in a column. `tdNumClass` and
  `inputNumericClass` already include it. A lone number may use `tabular-nums`
  alone.

## Components

- Use the shared components in [components/](../apps/web/src/components/) before
  you write markup: `Card`, `Field`, `PageHeader`, `Alert`, `Badge`, `Muted`,
  `TableScroll`, `Modal`, `ToggleSwitch` and the inputs below. `TextLink` is the
  one source for inline links. It underlines them, because colour alone is not
  enough.
- **React Aria first.** Every interactive control is built on a React Aria
  primitive, so keyboard, focus and screen-reader behaviour come with it. There
  is no raw `<input type="radio">` in product code. A group of options with
  nested controls uses a React Aria `RadioGroup`. Flat options use
  `SegmentedRadioGroup`. A raw control needs a stated reason.
- A new interactive or complex shared component ships a test with an axe check.
  The rule is in [AGENTS.md](../AGENTS.md), under "Testing setup
  (project-specific)".

## Buttons and destructive actions

The class strings are in
[dialog-chrome.ts](../apps/web/src/components/dialog-chrome.ts) and
[accounts-page-chrome.tsx](../apps/web/src/pages/accounts-page-chrome.tsx).

| Variant | Look |
|---|---|
| Primary (`btnPrimaryClass`) | `accent` fill, `accent-ink` label |
| Secondary (`btnSecondaryClass`) | `surface-raised` fill, `line-strong` border, `accent-link` label |
| Danger (`btnDangerClass`) | `negative` fill |
| Success (`btnSuccessSmClass`, in `scenarios-page-chrome.tsx`) | `positive` fill |

- **Compact variants are standalone strings**: `btnPrimarySmClass`,
  `btnSecondarySmClass`, `btnDangerSmClass`. Never add a size class to a role
  class. Tailwind v4 emits equal-weight utilities in source order, so the role
  class's padding wins and the size class does nothing.
- **A button beside a compact control uses the toolbar variant**:
  `btnPrimaryToolbarClass` or `btnDangerToolbarClass`. Their outer height matches
  a small `SegmentedRadioGroup`.
- **A page-header primary action is a `<button>`, never a `<Link>`.** `PageHeader`
  takes `action` as `{ label, onClick }`, so a link cannot be passed. To change
  route, call `useNavigate()` in `onClick`. `actionIcon` adds a leading glyph.

**Every control that erases data follows four rules.**

1. **The verb is "Delete"** on the button, in the confirm title and message, on
   the confirm label ("Yes, delete" for a second gate) and in failure messages.
   Never "Remove". "Reset" and "Disable" are not deletes and keep their own verbs.
2. **Use the danger colour.** An icon-only delete control has an `aria-label`
   that starts with "Delete ".
3. **Always confirm** with `useConfirm()`. It returns `{ confirm, dialog }`.
   `confirm(title, message, options?)` returns a promise of a boolean. The
   default confirm label is "Delete".
4. **Confirm twice when the record owns other data.** First say what else goes
   ("This account has balance data that will also be deleted."), then ask "Are
   you sure?". `AccountsPage` and `HouseholdPage` do this.

One narrow exception: a confirmed action that discards local data and then
re-fetches the server copy may use a neutral trigger. "Reload from server" on
the Workspace page is the only one. Red stays for the confirm step and for
actions with no server copy to fall back on.

## Modals

Use `Modal`, `ConfirmDialog` (through `useConfirm()`) or `PasswordManagerModal`.
Do not build a dialog from scratch.

- **Size** is a Tailwind `max-w-*` token from `sm` to `4xl`. `Modal` defaults to
  `xl`, `ConfirmDialog` to `sm`. Match the size to the content.
- **Placement.** The panel is centred. The overlay scrolls when the panel is
  taller than the screen.
- **Viewport fit.** A dense dialog can pass `scrollBodyLabel`. The panel is capped
  to the viewport, the title stays pinned, and the body becomes a
  keyboard-focusable scroll region. These dialogs are top-anchored so they do not
  jump when fields appear, and their overlay never scrolls, because a focus
  scroll could drag the dialog off the screen.
- **Action row.** Left-aligned, primary action first, Cancel after it.
- **Keys.** Esc and a scrim click close the dialog. `onEnter` runs on Enter in a
  plain text field, and is skipped for date segments, spin buttons, buttons and
  text areas. A modal that wraps a real `<form>` must not also pass `onEnter`.
- **Dismissal.** `dismissable={false}` blocks scrim clicks and, by default, Esc.
  `keyboardDismissable` controls Esc by itself. The recovery-key regeneration
  flow passes `dismissable={false}` to `RecoveryKeyModal`, because the new key
  cannot be shown again.
- **Unsaved changes.** Wrap `onClose` with `useDirtyModalClose(isDirty,
  realClose)`. It returns `guardedClose`, `immediateClose` and `confirmModal`.
  Scrim and Esc use `guardedClose`. An explicit Cancel calls `immediateClose`,
  because that discard is intended.
- **Focus** is trapped in the dialog and returns to the opener on close. React
  Aria does this for `Modal` and `ConfirmDialog`.
- **`ConfirmDialog`** takes `destructive` (default `true`), `confirmIcon`, `size`
  and `extraContent`. A benign prompt passes `destructive={false}` and gets the
  primary button. `extraContent` sits outside the described message, so an
  interactive control is not part of the accessible description.
- **Password entry uses `PasswordManagerModal`.** Props: `open`, `onClose`,
  `title`, `size`, `keyboardDismissDisabled`, `children`.

## Password managers

Every password surface must work with browser and extension password managers:
sign-in, sign-up, unlock, encryption setup, password reset, change password and
the shared `PasswordPromptModal`.

- **Use a real `<form>` and a `type="submit"` button**, even inside a modal.
  Managers key on form submission, not on click handlers. Guard `onSubmit` with
  the same disabled test as the button.
- **Set `name` and the right `autocomplete` token**: `current-password`,
  `new-password`, `username`, or `one-time-code` for a code. The sign-in and
  sign-up email field uses `username`, even with `type="email"`.
- **Add `HiddenUsernameField`** from
  [password-manager.tsx](../apps/web/src/components/password-manager.tsx) to a
  password form with no visible identifier. It is `sr-only`, not `display: none`,
  because managers skip fields hidden by display.
- **Secrets that are not credentials opt out.** The recovery key and
  type-to-confirm phrases use `autocomplete="off"` and spread `PM_IGNORE_ATTRS`.
- **`PasswordManagerModal` is not a normal modal, on purpose.** A manager draws
  its fill popup outside the dialog. A React Aria `Modal` marks everything outside
  as inert and traps focus, which freezes that popup. `PasswordManagerModal` uses
  the React Aria `Dialog` alone, with its own scrim that swallows outside clicks.
  It does not make the background inert, trap focus or set `aria-modal`, so
  screen-reader users get no background suppression there, and the page does not
  claim any. Autofocus, focus restore, scroll lock and Esc are handled by hand.
  Do not add a focus trap. `keyboardDismissDisabled` turns Esc off, for example
  during a check.
- **Check it again on a react-aria upgrade.** The design relies on the standalone
  `Dialog` never reaching the inert or focus-contain code.
  `PasswordManagerModal.test.tsx` checks the DOM. Only a real extension shows that
  the popup stays clickable.

## Form controls

- **Money and percent.** `MoneyInput` and `PercentInput` are text inputs with
  `inputMode="decimal"`. Never use `type="number"`: the spinner changes the field
  height. Each has a `form` variant (needs `id` and a label) and a `cell` variant
  for table cells (needs `ariaLabel`). They show the raw number on focus, format
  on blur, and use `font-mono`.
- **Select.** The shared `Select` replaces the native element. An option is
  `{ value, label, disabled?, depth?, description?, unavailable? }`. `depth`
  indents an option in the open list. `description` is read by assistive tech and
  never shown. `unavailable` only mutes the row; the option stays selectable.
- **External labels.** When a `Select` or `DatePicker` has an `id` and a visible
  `<label htmlFor>` but no `ariaLabel`, `useExternalLabelledBy` wires the label in
  as the accessible name. A control with neither is a real gap.
- **Dates.** `DatePicker` takes and returns a `YYYY-MM-DD` string. `min` and `max`
  are inclusive bounds in the same form. Show a date as text with `formatDate`
  from [format-date.ts](../apps/web/src/lib/format-date.ts), as `May 20, 2026`. A
  bare `YYYY-MM-DD` is read as a calendar day, so it never slips a day west of
  UTC. A log timestamp may print ISO, or add the clock time, where the time
  matters more than the date.
- **Toggle or checkbox.** A setting that flips something right away is a
  `ToggleSwitch`, a real `role="switch"`. It needs a visible `label` or an
  `ariaLabel`. A checkbox is only for choosing items from a group or agreeing to
  terms. Tests use `getByRole('switch')` and `getByRole('checkbox')`.
- **Segmented choices.** `SegmentedRadioGroup` takes `ariaLabel`, `options`,
  `value`, `onChange`, and optional `disabled` and `size` (`md` or `sm`). An option
  may carry a decorative `icon`. Use `size="sm"` beside small buttons.
- **Text and notes.** Use `TextInput`, and `NotesField` for free-text notes.
- **Unsaved changes on a page.** `useUnsavedChangesGuard(isDirty)` guards tab close
  and in-app navigation. It returns `pendingNavModal` to render and
  `navigateUnguarded(to)` for an explicit Cancel. `useDirtyDiscardAction` guards
  one action that would drop a draft, through `runGuarded`.
- **Member labels.** Show a household member by first name. When it is blank, fall
  back to the slot name, `primary` or `secondary`. `memberLabel` in
  `lib/expense-format.ts` does this.
- **Age copy.** Print ages with `formatAgeYearsMonths` from `lib/format-age.ts`. A
  whole number of years is just the number (`65`). With months, spell both units
  out (`65 years 6 months`, `1 year 1 month`). Never use `y` or `m`.

## Tables

Every data table sits in one bordered card. The question that picks the family is
whether rows have hover-revealed actions.

| | Row-action list tables | Read-only and inline-edit tables |
|---|---|---|
| Examples | Accounts, household balance list, per-account balances, Social Security | Annual contributions, projection tables, stress test, scenario asset mix |
| Row actions | Edit and Delete icons in `.row-actions` on a `group/row` row | None, or always-visible inline editors |
| Wrapper | `<TableScroll scroll={false}>` | `<TableScroll>` |
| Header cells | `thClass`, `thNumClass` | `thStickyClass`, `thStickyNumClass` |
| Totals row | not applicable | `rowTotalsClass` and `rowStickyBottomClass` |

- **Do not put hover-action rows in a scroll container.** Safari and WebKit leave
  `:hover` stuck on a row inside an overflow context, so the actions on every row
  you passed stay lit. It does not show up in Chromium or in automated tests.
  `scroll={false}` keeps the card border and drops the overflow. The cost is no
  horizontal scroll on a narrow screen. A wide table should use always-visible
  actions instead.
- **`.row-actions` hide until hover or focus on pointer devices** and are always
  visible on touch. They stay visible while a row holds focus, so a keyboard user
  never has a hidden focused control. Each icon button has an `aria-label`.
- **A table that is already a card on the page** is framed by that card. Do not
  wrap it in `TableScroll`, which would nest a card in a card.
- `TableScroll` requires `label`, which must say what the table contains, not
  "scrollable table". A scrolling wrapper is a `role="region"` with `tabIndex={0}`,
  capped at 60% of the viewport height. `busy` sets `aria-busy`.
- **Sticky headers belong to the columns.** Put `thStickyClass` on each
  `<Column>`; `TableScroll` does not do it.
- **A totals row is the last `<Row>`** with `data-totals="true"`, because React
  Aria has no footer. Pin it with `rowStickyBottomClass` only inside a scrolling
  wrapper.
- **Use one header row.** Fold a grouped header into compound names such as
  `Remaining — Pre-tax`.
- Tables are React Aria `Table` with an `aria-label` on the grid. The class
  strings `tableClass`, `thClass`, `tdClass` and `tdNumClass` are in
  `accounts-page-chrome.tsx`.

## Charts and navigation

**Drag to zoom.** `useChartZoom` in
[use-chart-zoom.ts](../apps/web/src/lib/use-chart-zoom.ts) manages the x and y
domain, the selection box and `reset()`. Call it in the section component, not in
the lazy chart, so the Reset button can show while the chart loads.
`ChartZoomReset` shows a "Reset view" button only while zoomed. Zoom resets when
the full range changes. A chart where zoom makes no sense, such as the form
preview, turns it off.

**Legend show and hide.** `useSeriesVisibility` keeps the hidden series. From the
all-visible state a click shows only that series. After that a click toggles one
series. Clicking the only visible series shows all again. `ChartLegend` draws
each entry as a `<button aria-pressed>` when `onToggle` is set, and as plain text
when it is not. Series that share a `legendId` hide together. The state is not
saved, and the chart rescales to the visible series.

**Sidebar.** An item can list `matchWhen` path patterns, and the sidebar sets
`aria-current="page"` from them. Use it when a route belongs to an item that is
not a prefix of its path: `/accounts/:id/balances` belongs to Account Balances,
not Accounts. When you add a route, check `matchWhen` in
[Sidebar.tsx](../apps/web/src/layout/Sidebar.tsx).

**Breakpoint.** The switch between the fixed sidebar and the menu drawer is
Tailwind's `lg` (1024 px). Its one JavaScript copy is `DESKTOP_QUERY` in
[MobileNavDrawer.tsx](../apps/web/src/components/MobileNavDrawer.tsx). Do not
write the number anywhere else. The drawer is not mounted at desktop width,
because an open React Aria modal traps focus and locks scrolling even when CSS
hides it.

**Global status indicators.** An indicator that must show on every page, such
as "Assistant connected", mounts in the sidebar status slot beside `SyncBadge`
and in the mobile banner between the Menu button and the stress-test chip. It
never mounts in the drawer, so no width shows two. It returns `null` when idle,
like `MonteCarloProgressChip`, and its screen-reader announcement comes from one
permanently mounted `sr-only` `role="status"` region in the shell, not from the
indicator, because the indicator exists twice. A control that unmounts while
focused, such as Disconnect, moves focus to the Menu button (banner) or the
first navigation button (sidebar) before the state changes.

## Scenario copy

Each scenario setting modal opens with a short intro paragraph: Retirement age,
Social Security, Life expectancy, Discretionary adjustment, Asset allocation and
Tax assumptions. It is a `<p className="m-0 text-sm">` of one or two sentences,
before any control. On the tabbed Tax assumptions modal it sits above the tabs.

- Say in everyday words what the setting is and how it changes the projection.
- Do not use jargon without a short explanation. "Monte Carlo", "MAGI", "IRMAA"
  and "COLA" never appear bare. Product nouns such as "Social Security" and "Roth
  conversion" are fine.
- Keep any per-tab or per-strategy descriptions that are already there.
- `PageHeader` subtitles on scenario sub-screens follow the same plain-English rule.

Several page tests pin this, so a change to an intro means a change to its test.

## Accessibility

WCAG 2.2 AA is the locked target for every screen. A change that adds a
violation does not ship. The baseline:

- Semantic HTML and correct landmarks.
- Everything works from the keyboard. Focus is visible. Nothing traps focus,
  except the dialogs that are meant to.
- Every interactive element has an accessible name. Colour never says something
  alone: pair a bucket hue with a label.
- Contrast meets AA. See [Contrast](#contrast).
- `prefers-reduced-motion` is honoured, and reduced motion still gets a working
  alternative.
- Forms label inputs and tie error messages to the field. `Field` shows an error
  as `role="alert"`.
- Dynamic updates use live regions. `Alert` uses `role="alert"` for error and
  warning and `role="status"` for the rest. A loading region uses `aria-busy`.
- Text zooms to 200 percent without losing content or function.

Check every new flow by hand with the keyboard only. The automated rule for shared
components is in [AGENTS.md](../AGENTS.md), under "Testing setup
(project-specific)".

**Known gap: drag to zoom.** WCAG 2.5.7 asks for a single-pointer alternative to a
dragging gesture. Chart zoom works only by dragging, and the chart engine ignores
touch for it. There is no range input or other alternative yet. The charts stay
fully readable without zooming. When you build the alternative, update this
section.
