/**
 * Typed React Aria replacement for native `<input type="date">`; `value` / `onChange` stay `YYYY-MM-DD` strings
 * (empty means none). Named by `id` + external `<label htmlFor>`, or `ariaLabel`.
 */
import React from 'react';
import { CalendarDate, parseDate } from '@internationalized/date';
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  DateInput,
  DatePicker as RACDatePicker,
  DateSegment,
  Dialog,
  Group,
  Heading,
  Popover,
} from 'react-aria-components';
import { ChevronIcon } from '../layout/sidebar-icons';
import { useExternalLabelledBy } from './use-external-label';

interface BaseProps {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  min?: string;
  max?: string;
  required?: boolean;
  className?: string;
  /** Wires the group to an external error or hint element so AT announces the association. */
  'aria-describedby'?: string;
  /** Marks the group invalid for AT while a validation error is showing. */
  isInvalid?: boolean;
}

interface LabelledProps extends BaseProps {
  id: string;
  ariaLabel?: string;
}

interface AriaOnlyProps extends BaseProps {
  id?: string;
  ariaLabel: string;
}

export type DatePickerProps = LabelledProps | AriaOnlyProps;

// An unparseable or empty string maps to `null`, so a malformed stored value never throws the
// render.
function toCalendarDate(v: string): CalendarDate | null {
  if (!v) return null;
  try {
    return parseDate(v.slice(0, 10));
  } catch {
    return null;
  }
}

const GROUP_CLASS =
  'flex w-full min-w-0 items-center justify-between gap-2 rounded-md ' +
  'border border-input-line bg-surface px-3 py-2 text-ink ' +
  'data-[focus-within]:border-accent data-[focus-within]:outline-none ' +
  'data-[focus-within]:ring-2 data-[focus-within]:ring-ring ' +
  'data-[disabled]:cursor-not-allowed data-[disabled]:bg-surface-sunken data-[disabled]:text-muted';

// Segments do not inherit font-size from GROUP_CLASS.
const SEGMENT_CLASS =
  'rounded px-0.5 text-sm tabular-nums outline-none ' +
  'data-[placeholder]:text-muted ' +
  'data-[focused]:bg-accent data-[focused]:text-accent-ink';

const POPOVER_CLASS =
  'rounded-md border border-line bg-surface-raised p-3 shadow-lg';

const CAL_CELL_CLASS =
  'flex size-9 cursor-pointer items-center justify-center rounded text-sm ' +
  'text-ink outline-none ' +
  'data-[hovered]:bg-surface-sunken data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring ' +
  'data-[selected]:bg-accent data-[selected]:text-accent-ink ' +
  'data-[disabled]:cursor-not-allowed data-[disabled]:text-muted';

const NAV_BTN_CLASS =
  'flex size-7 items-center justify-center rounded text-ink outline-none ' +
  'data-[hovered]:bg-surface-sunken data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring';

export const DatePicker: React.FC<DatePickerProps> = ({
  value,
  onChange,
  disabled,
  min,
  max,
  required,
  className,
  id,
  ariaLabel,
  'aria-describedby': ariaDescribedBy,
  isInvalid,
}) => {
  // RA points the date-field group's `aria-labelledby` at itself, which overrides the external
  // `<label htmlFor>`; wire that label explicitly.
  const labelledBy = useExternalLabelledBy(id, ariaLabel);
  return (
    <RACDatePicker
      id={id}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      aria-describedby={ariaDescribedBy}
      value={toCalendarDate(value)}
      isDisabled={disabled}
      isRequired={required}
      isInvalid={isInvalid}
      minValue={min ? toCalendarDate(min) ?? undefined : undefined}
      maxValue={max ? toCalendarDate(max) ?? undefined : undefined}
      onChange={(d) => onChange(d ? d.toString() : '')}
      className={className ? `group ${className}` : 'group'}
    >
      <Group className={GROUP_CLASS}>
        <DateInput className="flex min-w-0 flex-1">
          {(segment) => (
            <DateSegment segment={segment} className={SEGMENT_CLASS} />
          )}
        </DateInput>
        <Button
          className="shrink-0 text-muted outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring"
          aria-label="Open calendar"
        >
          <ChevronIcon className="size-4 rotate-90" />
        </Button>
      </Group>
      <Popover className={POPOVER_CLASS}>
        <Dialog className="outline-none">
          <Calendar>
            <header className="mb-2 flex items-center justify-between gap-2">
              <Button slot="previous" className={NAV_BTN_CLASS} aria-label="Previous month">
                <ChevronIcon className="size-4 rotate-180" />
              </Button>
              <Heading className="text-sm font-semibold text-ink" />
              <Button slot="next" className={NAV_BTN_CLASS} aria-label="Next month">
                <ChevronIcon className="size-4" />
              </Button>
            </header>
            <CalendarGrid className="border-collapse">
              {(date) => (
                <CalendarCell date={date} className={CAL_CELL_CLASS} />
              )}
            </CalendarGrid>
          </Calendar>
        </Dialog>
      </Popover>
    </RACDatePicker>
  );
};
