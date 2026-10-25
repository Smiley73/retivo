/**
 * One-line disclosure row shared by the Roth-conversions and QCD editors. Not an `<AnchorCard>`: group state is keyed
 * by `label` and reaches nested anchor cards, so expansion is controlled by the caller.
 */
import React, { useId } from 'react';
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';
import { Badge } from './Badge';

export interface EntryDisclosureRowProps {
  label: string;
  summary: React.ReactNode;
  /** Right-aligned amount, hidden while expanded; omit for no amount column. */
  amount?: string;
  problem?: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: React.ReactNode;
}

export const EntryDisclosureRow: React.FC<EntryDisclosureRowProps> = ({
  label,
  summary,
  amount,
  problem,
  expanded,
  onExpandedChange,
  children,
}) => {
  const summaryId = useId();
  const amountId = useId();
  const problemId = useId();
  const describedBy = [
    summaryId,
    amount !== undefined ? amountId : null,
    problem ? problemId : null,
  ]
    .filter((id): id is string => id !== null)
    .join(' ');
  return (
    <Disclosure
      isExpanded={expanded}
      onExpandedChange={onExpandedChange}
      className="group/entry-row flex min-w-0 flex-col rounded-md border border-line bg-surface"
    >
      <Heading className="m-0">
        <Button
          slot="trigger"
          // The name is the label; summary, amount and problem chip are announced via
          // `aria-describedby`.
          aria-label={label}
          aria-describedby={describedBy}
          className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left outline-none hover:bg-ink/5 data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 text-sm font-medium text-ink">{label}</span>
            <span
              id={summaryId}
              className="truncate text-sm text-muted group-data-[expanded]/entry-row:hidden"
            >
              {summary}
            </span>
            {problem && (
              <span id={problemId}>
                <Badge tone="negative">{problem}</Badge>
              </span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-3">
            {amount !== undefined && (
              <span
                id={amountId}
                className="font-mono text-sm tabular-nums text-ink group-data-[expanded]/entry-row:hidden"
              >
                {amount}
              </span>
            )}
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className="h-5 w-5 shrink-0 text-muted transition-transform group-data-[expanded]/entry-row:rotate-180"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 7.5 10 12.5 15 7.5" />
            </svg>
          </span>
        </Button>
      </Heading>
      <DisclosurePanel className="px-3 pb-3 pt-1">{children}</DisclosurePanel>
    </Disclosure>
  );
};
