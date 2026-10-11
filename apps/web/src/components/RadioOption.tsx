/**
 * RadioOption — React Aria Radio wrapper with a visible circle indicator.
 * Replaces the duplicated RADIO_OPTION_CLASS / EXPENSE_RADIO_OPTION_CLASS /
 * OPTION_CLASS constants across ScheduleAnchorPicker, ExpenseFormPage,
 * IncomeSchedulePickers. Selected state via render-prop isSelected.
 */
import React from 'react';
import { Radio } from 'react-aria-components';
import type { RadioProps } from 'react-aria-components';
import type { ReactNode } from 'react';

export interface RadioOptionProps extends Omit<RadioProps, 'className' | 'children'> {
  children: ReactNode;
  className?: string;
}

// Shared label layout. data-[disabled] classes preserved from
// ScheduleAnchorPicker's RADIO_OPTION_CLASS so disabled-state visual
// doesn't regress when that constant is deleted.
const BASE_CLASS =
  'flex cursor-pointer items-center gap-2 text-sm text-ink ' +
  'data-[focus-visible]:outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring data-[focus-visible]:ring-offset-1 ' +
  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60';

// `border` (inside the box), NOT `ring-1` (a box-shadow drawn outside the
// box): a ring made the unselected circle ~1px larger than the filled
// selected circle, so the selected one looked smaller. A border keeps
// both at the same `size-4` outer diameter.
const INDICATOR_UNSELECTED = 'size-4 rounded-full border border-input-line';
const INDICATOR_SELECTED =
  'size-4 rounded-full bg-accent flex items-center justify-center';

export const RadioOption: React.FC<RadioOptionProps> = ({
  children,
  className,
  ...rest
}) => (
  <Radio {...rest} className={[BASE_CLASS, className].filter(Boolean).join(' ')}>
    {({ isSelected }) => (
      <>
        <span
          aria-hidden
          className={isSelected ? INDICATOR_SELECTED : INDICATOR_UNSELECTED}
        >
          {isSelected && (
            <span className="size-2 rounded-full bg-accent-ink" />
          )}
        </span>
        {children}
      </>
    )}
  </Radio>
);
