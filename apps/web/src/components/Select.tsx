/**
 * Shared dropdown select — the typed React Aria replacement for every
 * native `<select>`. Consolidates the 21 native
 * `<select>` sites onto one AT-tested, design-system-consistent control
 * with a visible chevron-down affordance (native selects
 * render OS chrome that reads inconsistently across platforms).
 *
 * Public API is intentionally small and string-valued so it is a near
 * drop-in for the native element it replaces:
 *   - `value` / `onChange(value)` — controlled string value, exactly
 *     like `<select value onChange={e => …e.target.value}>`.
 *   - `options` — `{ value, label, disabled?, depth?, description?,
 *     unavailable? }[]` (flat — the 21 migrated form/filter sites). An
 *     optional `groups` prop adds the `<optgroup>` analogue (React Aria
 *     `ListBoxSection` + `Header`) for the one site that needs grouping
 *     — the Balance Projection page's "Basis" select. A grouped caller
 *     passes `groups` only (no flat `options`), and `groups` wins for
 *     rendering. `description` gives an option row an accessible
 *     description (announced only, and suppressed on the currently
 *     selected option so it can never reach the closed trigger);
 *     `unavailable` is a `text-muted` visual treatment, independent of
 *     `disabled` — the option stays focusable and selectable. See
 *     `SelectOption` below for the exact contracts.
 *   - `id` + `label` for a labelled field, OR `ariaLabel` for a bare
 *     control (filter bars, inline pickers). One of the two is required
 *     for an accessible name.
 *
 * The selected option's text is the trigger's accessible value; React
 * Aria owns the listbox keyboard pattern (typeahead, Up/Down/Home/End,
 * Esc, focus-restore) by construction. Visual identity is the Graphite
 * Spectrum semantic-token system (`input-line` boundary, lime
 * `ring` focus, lime `accent` focused option); every fg/bg pair used
 * here is registered in contrast.ts.
 */
import React from 'react';
import {
  Button,
  Collection,
  Header,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Popover,
  Select as RACSelect,
  SelectValue,
  Text,
} from 'react-aria-components';
import { ChevronIcon } from '../layout/sidebar-icons';
import { useExternalLabelledBy } from './use-external-label';

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /**
   * Visual indent depth for the option row in the open popover.
   * 0 = root (default when undefined); depth ≥ 5 collapses to pl-22.
   * Applies only to the ListBoxItem — the closed trigger stays unindented.
   * Mapping: 0→pl-2, 1→pl-6, 2→pl-10, 3→pl-14, 4→pl-18, 5+→pl-22.
   */
  depth?: number;
  /**
   * Accessible description for this option row. Announced by AT via
   * `aria-describedby`; never rendered visibly in the listbox (`sr-only`)
   * and never folded into the option's accessible *name* — the row's
   * label stays the name. **Rendered only when this option is not the
   * Select's current `value`**: `SelectValue` re-renders the selected
   * item's children inside the closed trigger, so a description on the
   * selected option would otherwise leak into the trigger's accessible
   * name/text. An option you already hold does not need its own reason
   * announced back at you, so this costs nothing in practice.
   */
  description?: string;
  /**
   * Visual-only "this option is unavailable" treatment: the row renders
   * `text-muted` instead of `text-ink`. **Not** `disabled` — the option
   * stays focusable, keyboard-reachable, and selectable, and `onChange`
   * still fires for it. Pair with `description` to explain *why*;
   * neither field implies the other.
   */
  unavailable?: boolean;
}

// Depth → padding-left class map. Every entry is a Tailwind v4
// default-scale token (calc(var(--spacing) * N)) — no eslint-disable needed.
const DEPTH_PL_CLASS: readonly string[] = [
  'pl-2',  // depth 0
  'pl-6',  // depth 1
  'pl-10', // depth 2
  'pl-14', // depth 3
  'pl-18', // depth 4
  'pl-22', // depth 5+
];

interface BaseProps {
  value: string;
  onChange: (next: string) => void;
  /** Flat option list (the 21 migrated form/filter sites). Optional only when
   *  `groups` is supplied — a grouped caller renders from `groups` and need not
   *  duplicate the flat list. */
  options?: SelectOption[];
  disabled?: boolean;
  /** Extra layout-only classes on the React Aria `Select` root. */
  className?: string;
  /** Placeholder shown when no option matches `value`. */
  placeholder?: string;
  /**
   * Optional grouped options — the AT-correct `<optgroup>` equivalent
   * (rendered as React Aria `ListBoxSection` + `Header`). A caller passes
   * either a flat `options` list (the 21 migrated sites) OR the `groups`
   * form (the Balance Projection basis selector); the two are
   * mutually-exclusive. When `groups` is present it wins for rendering and
   * the flat `options` prop is not needed.
   */
  groups?: ReadonlyArray<{ readonly label: string; readonly options: SelectOption[] }>;
}

interface LabelledProps extends BaseProps {
  id: string;
  /** Visible label rendered by the caller (via `htmlFor={id}`); this is
   *  the accessible name. */
  ariaLabel?: string;
}

interface AriaOnlyProps extends BaseProps {
  id?: string;
  /** Accessible name when there is no associated visible `<label>`. */
  ariaLabel: string;
}

export type SelectProps = LabelledProps | AriaOnlyProps;

// Control boundary uses the dedicated `input-line` token — a
// load-bearing boundary, AA-safe non-text (WCAG 1.4.11 ≥ 3.0);
// registered in contrast.ts. Mirrors the shared input control.
const TRIGGER_CLASS =
  'flex w-full min-w-0 items-center justify-between gap-2 rounded-md ' +
  // `text-sm` matches the 14px page baseline and the listbox options
  // (LISTBOX_CLASS), so the trigger no longer jumps size on open.
  'border border-input-line bg-surface px-3 py-2 text-left text-sm text-ink ' +
  'data-[focus-visible]:border-accent data-[focus-visible]:outline-none ' +
  'data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring ' +
  'data-[disabled]:cursor-not-allowed data-[disabled]:bg-surface-sunken data-[disabled]:text-muted';

// Popover sizes to its widest option (w-max), but never narrower than the
// trigger (min-width var bridge) and capped at max-w-md so a long scenario
// name does not blow up the popover on narrow sidebars. The trigger keeps
// its own width — only the open popover grows when content needs the room.
const LISTBOX_CLASS =
  'max-h-60 w-max [min-width:var(--trigger-width)] max-w-md overflow-auto ' +
  'rounded-md border border-line bg-surface-raised p-1 text-sm shadow-lg ' +
  'outline-none';

// Focused option = the lime `accent` fill with the dark `accent-ink`
// label (7.97:1 light / 10.68:1 dark — the bright lime is too light for
// white text); registered "primary button label on accent" in
// contrast.ts. Dark mode rides the `.dark` variable swap.
// Base class intentionally omits left-padding so each option row can apply
// the depth-specific pl-N from DEPTH_PL_CLASS (pr-2 stays for right side).
// It also omits the ink/muted colour — that is composed per option below —
// because appending `text-muted` on top of a hard-coded `text-ink` here
// would leave both classes present, and which one wins would depend on
// Tailwind's generated source order rather than the option's own state.
const OPTION_BASE_CLASS =
  'cursor-pointer select-none rounded pr-2 py-1.5 outline-none ' +
  'data-[focused]:bg-accent data-[focused]:text-accent-ink ' +
  'data-[selected]:font-semibold ' +
  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50';

/** Return the depth-locked pl-N class for an option row. */
function depthClass(depth: number | undefined): string {
  const clamped = Math.min(depth ?? 0, DEPTH_PL_CLASS.length - 1);
  return DEPTH_PL_CLASS[clamped];
}

// Section header for a grouped select — the `<optgroup label>` analogue.
// Muted mono micro-label matching the page's other group/eyebrow labels;
// non-interactive (React Aria `Header` is not a focusable option).
const SECTION_HEADER_CLASS =
  'px-2 pb-1 pt-2 font-mono text-xs font-semibold uppercase tracking-wide text-muted';

export const Select: React.FC<SelectProps> = ({
  value,
  onChange,
  options,
  disabled,
  className,
  placeholder,
  id,
  ariaLabel,
  groups,
}) => {
  // An `id`+external-`<label htmlFor>` field with no `ariaLabel` would
  // otherwise be named by RA's own `aria-labelledby` (the selected
  // value text), not the visible label — wire the external label
  // explicitly (no-op when `ariaLabel` is supplied; existing call
  // sites pass `ariaLabel` so they are unchanged).
  const labelledBy = useExternalLabelledBy(id, ariaLabel);
  // Closure over `value` — a description must never render on the
  // currently-selected option, because `SelectValue` re-renders that
  // option's children inside the closed trigger (see the SelectOption
  // `description` docblock). Both render paths below (the flat `<ListBox
  // items>` path and the grouped `<Collection items>` path) call this
  // same function, so the suppression applies to both.
  const renderOption = (opt: SelectOption): React.ReactElement => {
    const showDescription = Boolean(opt.description) && opt.value !== value;
    return (
      <ListBoxItem
        id={opt.value}
        textValue={opt.label}
        isDisabled={opt.disabled}
        className={`${OPTION_BASE_CLASS} ${depthClass(opt.depth)} ${
          opt.unavailable ? 'text-muted' : 'text-ink'
        }`}
      >
        {showDescription ? (
          <>
            <Text slot="label">{opt.label}</Text>
            <Text slot="description" className="sr-only">
              {opt.description}
            </Text>
          </>
        ) : (
          opt.label
        )}
      </ListBoxItem>
    );
  };
  return (
    <RACSelect
      id={id}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      selectedKey={value}
      isDisabled={disabled}
      onSelectionChange={(key) => onChange(String(key))}
      placeholder={placeholder}
      className={className ? `group ${className}` : 'group'}
    >
      <Button className={TRIGGER_CLASS}>
        <SelectValue className="block min-w-0 flex-1 truncate data-[placeholder]:text-muted" />
        {/* Reused nav chevron, rotated to point down — the visible
            "this is a dropdown" affordance the native control lacked
            consistently. Default-scale `rotate-90` only. */}
        <ChevronIcon className="size-4 shrink-0 rotate-90 text-muted" />
      </Button>
      <Popover className="rounded-md">
        {groups ? (
          <ListBox className={LISTBOX_CLASS}>
            {groups.map((group) => (
              <ListBoxSection key={group.label} id={group.label}>
                <Header className={SECTION_HEADER_CLASS}>{group.label}</Header>
                <Collection items={group.options} dependencies={[value]}>
                  {renderOption}
                </Collection>
              </ListBoxSection>
            ))}
          </ListBox>
        ) : (
          <ListBox className={LISTBOX_CLASS} items={options ?? []} dependencies={[value]}>
            {renderOption}
          </ListBox>
        )}
      </Popover>
    </RACSelect>
  );
};
