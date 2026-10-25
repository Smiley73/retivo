/**
 * React Aria Radio wrapper with a visible circle indicator, shared by the schedule and expense forms.
 */
import React from 'react';
import { Radio } from 'react-aria-components';
import type { RadioProps } from 'react-aria-components';
import type { ReactNode } from 'react';

export interface RadioOptionProps extends Omit<RadioProps, 'className' | 'children'> {
  children: ReactNode;
  className?: string;
}

const BASE_CLASS =
  'flex cursor-pointer items-center gap-2 text-sm text-ink ' +
  'data-[focus-visible]:outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring data-[focus-visible]:ring-offset-1 ' +
  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60';

// `border` (inside the box), not `ring-1` (outside it), so selected and unselected circles share
// one outer diameter.
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
