/**
 * Shared on/off `role="switch"` on React Aria `Switch`; pass a visible `label` or an `ariaLabel` for a bare switch.
 * See "Form controls" in docs/ui-conventions.md.
 */
import React from 'react';
import { Switch } from 'react-aria-components';

interface BaseProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  id?: string;
  disabled?: boolean;
  className?: string;
  ariaDescribedBy?: string;
}

interface LabelledProps extends BaseProps {
  label: React.ReactNode;
  ariaLabel?: string;
  ariaDescribedBy?: string;
}

interface AriaOnlyProps extends BaseProps {
  label?: undefined;
  ariaLabel: string;
}

type ToggleSwitchProps = LabelledProps | AriaOnlyProps;

// Non-text control: the off and on states and the thumb must stay distinguishable at 3:1 (WCAG
// 1.4.11). The track and thumb are children of the RA wrapper, whose `data-selected` they read via
// `group-data-[selected]:`.
const TRACK_CLASS =
  'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full ' +
  'border border-input-line bg-input-line transition-colors ' +
  'group-data-[focus-visible]:outline-none group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-ring group-data-[focus-visible]:ring-offset-2 ' +
  'group-data-[selected]:border-positive group-data-[selected]:bg-positive ' +
  'group-data-[disabled]:cursor-not-allowed group-data-[disabled]:opacity-50';

const THUMB_CLASS =
  'pointer-events-none absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-surface ' +
  'shadow transition-transform';

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

  // Visible label only: its text is the accessible name.
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

  // `ariaLabel` plus a visible label: `aria-label` is the accessible name, e.g. for a visible
  // dynamic state word.
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

  // Bare switch with no adjacent text.
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
