/**
 * Compact single-line disclosure row — a one-line collapsed summary that
 * expands in place to reveal the full field body. Shared row chrome for the
 * Roth-conversions and QCD editors' per-entry rows.
 *
 * Deliberately NOT an `<AnchorCard>` (see AnchorCard.tsx) — a new, simpler
 * shell built directly on React Aria `Disclosure`:
 *   1. `AnchorCardGroup` keys the open card by `label` — row labels renumber
 *      on removal, silently transferring open state to the wrong row.
 *   2. The group context reaches EVERY descendant `AnchorCard`, including
 *      the two `ScheduleAnchorPicker` anchor cards nested inside each row's
 *      body — opening "Convert starting" would collapse the parent row.
 *   3. `defaultExpanded` is bypassed inside a group, so "a new row starts
 *      expanded" can't be expressed.
 *   4. `summary: string` is too narrow — this header needs JSX (a problem
 *      badge, a right-aligned mono amount).
 * So expansion here is fully CONTROLLED by the caller (`expanded` /
 * `onExpandedChange`), keyed by the row's stable `draftId` — no internal
 * state, no shared group context.
 *
 * A11y wiring mirrors `AnchorCard`: the trigger's accessible name is just
 * `label` ("Conversion 1" / "QCD 2"); the summary, amount (when present),
 * and problem chip are all announced via `aria-describedby` (which reads a
 * node's text even while it is visually `hidden`) — otherwise they would be
 * programmatically undiscoverable once the trigger's name is just `label`.
 * The problem chip stays visible + in the description in BOTH collapsed and
 * expanded states; the summary and amount hide once expanded (the expanded
 * body says the same thing more richly).
 *
 * Deliberately flatter/smaller chrome than `AnchorCard` (`rounded-md` row +
 * a small chevron, vs `AnchorCard`'s `rounded-xl` card) so this outer
 * disclosure reads clearly above the `AnchorCard`-based `ScheduleAnchorPicker`s
 * nested one level down inside its own body.
 */
import React, { useId } from 'react';
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';
import { Badge } from './Badge';

export interface EntryDisclosureRowProps {
  /** "Conversion 1" / "QCD 2" — the trigger's accessible name. */
  label: string;
  /** One-line plain-English summary cluster. Hidden while expanded. */
  summary: React.ReactNode;
  /** Right-aligned "$10,000/yr" (font-mono tabular-nums). Hidden while
   *  expanded. Omit entirely to render no amount column (QCD rows). */
  amount?: string;
  /** "Needs attention" chip text. Visible collapsed AND expanded. */
  problem?: string;
  /** Controlled expansion — single-open-at-a-time state lives in the caller. */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Field body + relocated Remove button, revealed when expanded. */
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
          // Accessible name is just the label (unique + stable); the
          // summary/amount/problem are announced via aria-describedby.
          // Expanded/collapsed state comes from the native aria-expanded.
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
