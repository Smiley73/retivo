/**
 * Generic `(i)` trigger opening a React Aria Popover/Dialog with arbitrary content; self-contained. Not print-scoped,
 * unlike `ChartInfoPopover`.
 */
import React from 'react';
import { Button, Dialog, DialogTrigger, Popover } from 'react-aria-components';
import { InfoCircleIcon } from './InfoCircleIcon';

export interface InfoPopoverProps {
  readonly label: string;
  readonly children: React.ReactNode;
}

const TRIGGER_CLASS =
  'inline-flex cursor-pointer items-center rounded text-muted hover:text-ink ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

export const InfoPopover: React.FC<InfoPopoverProps> = ({ label, children }) => (
  <DialogTrigger>
    <Button aria-label={label} className={TRIGGER_CLASS}>
      <InfoCircleIcon width={16} height={16} />
    </Button>
    <Popover offset={6} className="z-40 outline-none">
      <Dialog
        aria-label={label}
        className={
          'max-w-sm rounded-lg border border-line bg-surface-raised p-3 ' +
          'text-xs text-muted shadow-lg outline-none'
        }
      >
        {children}
      </Dialog>
    </Popover>
  </DialogTrigger>
);
