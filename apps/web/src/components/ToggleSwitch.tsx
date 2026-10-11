/**
 * Shared boolean on/off toggle — a real `role="switch"` control,
 * built on React Aria's `Switch`.
 *
 * Use for any setting that flips an immediate state (visibility,
 * behaviour, opt-in / opt-out) — the project's toggle-vs-checkbox rule
 * ("Form controls" in docs/ui-conventions.md): `<input type="checkbox">`
 * stays only for list-selection / agreement semantics. This component is
 * the Switch half of that rule; the behavioral
 * contract (`role="switch"`, `aria-checked`, keyboard Space toggles,
 * accessible name) holds.
 *
 * Accessible name: pass a visible `label` (becomes the React Aria
 * `Switch`'s accessible name via its child text) OR an `ariaLabel` for
 * a bare switch with no adjacent text (e.g. a per-row override cell).
 * One of the two is required.
 *
 * Visual style is the Graphite Spectrum semantic-token system:
 * the `input-line` graphite track for OFF, the `positive` green
 * for ON (the universal on-off convention — green = on). Focus ring is
 * the lime `ring` token. Dark mode is the `.dark` variable swap.
 */
import React from 'react';
import { Switch } from 'react-aria-components';

interface BaseProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Forwarded to the underlying switch button. */
  id?: string;
  disabled?: boolean;
  /** Extra classes on the outer wrapper (layout only). */
  className?: string;
  /** Associates supporting guidance with the switch. */
  ariaDescribedBy?: string;
}

interface LabelledProps extends BaseProps {
  /** Visible label, also the accessible name. */
  label: React.ReactNode;
  ariaLabel?: string;
  ariaDescribedBy?: string;
}

interface AriaOnlyProps extends BaseProps {
  label?: undefined;
  /** Accessible name when there is no visible label. */
  ariaLabel: string;
}

type ToggleSwitchProps = LabelledProps | AriaOnlyProps;

// A switch is a non-text UI control: WCAG 1.4.11 requires the off/on
// state and the thumb to be distinguishable at >= 3.0:1. Unchecked track
// is the `input-line` graphite so the `surface` thumb reads against it
// (thumb-on-input-line = 3.49 light / 4.11 dark) and the track boundary
// clears its surface. Checked track is the `positive` green — green is
// the universal on convention and the hue-shift makes on vs off
// perceptible at a glance. The `surface` thumb swaps near-white (light)
// → near-black (dark) with the `.dark` variable change, so a single
// token reads on both tracks in both themes (positive thumb = 4.94
// light / 10.56 dark). All pairs registered in contrast.ts.
// The track + thumb are CHILDREN of the React Aria <Switch> wrapper.
// `data-selected` is set on the wrapper (not the child spans), so the
// child track responds to its parent's state via `group-data-[selected]:`
// (the wrapper carries the `group` class in `rowClass` below).
// `group-data-[focus-visible]:` mirrors the same indirection for focus
// keyboard ring.
const TRACK_CLASS =
  'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full ' +
  'border border-input-line bg-input-line transition-colors ' +
  'group-data-[focus-visible]:outline-none group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-ring group-data-[focus-visible]:ring-offset-2 ' +
  'group-data-[selected]:border-positive group-data-[selected]:bg-positive ' +
  'group-data-[disabled]:cursor-not-allowed group-data-[disabled]:opacity-50';

const THUMB_CLASS =
  'pointer-events-none absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-surface ' +
  'shadow transition-transform';

// React Aria's <Switch> root is a <label> carrying role="switch". The
// track + thumb are rendered as its children; `isSelected` from the
// render-prop drives the thumb position (no Tailwind group needed since
// the label is the role host, not a wrapping element).
function SwitchControl(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  id?: string;
  disabled?: boolean;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  children?: React.ReactNode;
  rowClass: string;
}): React.ReactElement {
  const { checked, onChange, id, disabled, ariaLabel, ariaDescribedBy, children, rowClass } =
    props;
  return (
    <Switch
      id={id}
      isSelected={checked}
      onChange={onChange}
      isDisabled={disabled}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      className={rowClass}
    >
      {({ isSelected }) => (
        <>
          <span className={TRACK_CLASS}>
            <span
              aria-hidden="true"
              className={`${THUMB_CLASS}${isSelected ? ' translate-x-4' : ''}`}
            />
          </span>
          {children}
        </>
      )}
    </Switch>
  );
}

export function ToggleSwitch(props: ToggleSwitchProps): React.ReactElement {
  const { checked, onChange, id, disabled, className, ariaLabel, ariaDescribedBy } = props;
  const rowClass = `group inline-flex cursor-pointer select-none items-center gap-2${
    className ? ` ${className}` : ''
  }`;

  // (1) Visible label only → the label text is the React Aria Switch's
  // accessible name (resolvable by getByRole('switch', { name }) and
  // getByLabelText).
  if (props.label !== undefined && ariaLabel === undefined) {
    return (
      <SwitchControl
        checked={checked}
        onChange={onChange}
        id={id}
        disabled={disabled}
        ariaDescribedBy={ariaDescribedBy}
        rowClass={rowClass}
      >
        <span>{props.label}</span>
      </SwitchControl>
    );
  }

  // (2) Explicit ariaLabel + a visible label → the ariaLabel is the
  // stable accessible name (e.g. a switch whose visible text is a
  // dynamic state word). The visible text renders as a child but, with
  // aria-label set, React Aria uses aria-label for the accessible name.
  if (props.label !== undefined) {
    return (
      <SwitchControl
        checked={checked}
        onChange={onChange}
        id={id}
        disabled={disabled}
        ariaLabel={ariaLabel}
        ariaDescribedBy={ariaDescribedBy}
        rowClass={rowClass}
      >
        <span>{props.label}</span>
      </SwitchControl>
    );
  }

  // (3) Bare aria-only switch (no adjacent text — e.g. a per-row
  // override cell).
  return (
    <SwitchControl
      checked={checked}
      onChange={onChange}
      id={id}
      disabled={disabled}
      ariaLabel={ariaLabel}
      ariaDescribedBy={ariaDescribedBy}
      rowClass={
        className ? `group inline-flex items-center ${className}` : 'group inline-flex items-center'
      }
    />
  );
}
