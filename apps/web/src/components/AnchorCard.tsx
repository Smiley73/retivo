/**
 * Collapsible "anchor card" — the shared chrome for every schedule-anchor
 * picker (expense Start / End and the discretionary-glide start / end /
 * floor). Collapsed it shows the anchor's label plus a plain-language
 * summary of the current selection ("At age 65"); expanded it reveals the
 * picker body (radios + inputs) with room to lay out without wrapping.
 *
 * Why this exists: the anchor pickers carry 3–5 long-labelled options
 * plus a member `<Select>` and number inputs. Side by side in the narrow
 * grid columns those rows wrap. Collapsing each picker to a one-line
 * summary keeps the overview compact, and `expandedClassName` lets a grid
 * parent hand the *open* card the full row (`md:col-span-2` / `-3`) so the
 * revealed controls always have the width they need. One card style for
 * all five anchors (consistency + a single place to fix the layout).
 *
 * Built on React Aria's `Disclosure`: the
 * trigger gets `aria-expanded` / `aria-controls` wiring, keyboard
 * operability, and focus handling for free, matching `Sidebar`'s sections.
 *
 * Wrap a set of these in `<AnchorCardGroup>` for one-open-at-a-time
 * behaviour: opening a card collapses whichever sibling was open. (We use
 * a small shared context rather than React Aria's `DisclosureGroup`
 * because `AnchorCard` keeps controlled expansion — disabling a card must
 * also collapse it — and the cards span two parent components.) Cards
 * outside a group keep independent local expansion. Each card's `label`
 * is its key within the group, so labels must be unique per group.
 */
import React, { createContext, useContext, useId, useState } from 'react';
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';

interface AnchorCardGroupValue {
  /** Label of the currently-open card, or `null` when all are collapsed. */
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
}

const AnchorCardGroupContext = createContext<AnchorCardGroupValue | null>(null);

/** Single-expand coordinator: only one descendant `<AnchorCard>` is open
 *  at a time. Opening one collapses the previously-open sibling. */
export const AnchorCardGroup: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <AnchorCardGroupContext.Provider value={{ expandedId, setExpandedId }}>
      {children}
    </AnchorCardGroupContext.Provider>
  );
};

interface Props {
  /** Card heading, e.g. "Start", "Glide starts". */
  label: string;
  /** Plain-language summary of the current selection, shown collapsed. */
  summary: string;
  /** Picker body, revealed when the card is expanded. */
  children: React.ReactNode;
  /** Whole card disabled (e.g. the glide / floor is off): the trigger
   *  can't expand and the card dims. Defaults to `false`. */
  disabled?: boolean;
  /** Tailwind class applied to the card root (e.g. grid-cell sizing). */
  className?: string;
  /** Start expanded. Defaults to `false` (collapsed summary). */
  defaultExpanded?: boolean;
}

export const AnchorCard: React.FC<Props> = ({
  label,
  summary,
  children,
  disabled = false,
  className,
  defaultExpanded = false,
}) => {
  const summaryId = useId();
  // Controlled expansion so disabling the card also collapses it. A
  // disabled trigger can't be clicked, so a card left open when it becomes
  // disabled (e.g. the floor toggled off) would otherwise be stuck open
  // with no way to close it. `open` forces collapsed whenever disabled;
  // re-enabling restores the prior expansion.
  //
  // Inside an `<AnchorCardGroup>` the open card is shared state keyed by
  // `label` (single-expand); standalone, each card owns local state.
  const group = useContext(AnchorCardGroupContext);
  const [localExpanded, setLocalExpanded] = useState(defaultExpanded);
  const expanded = group ? group.expandedId === label : localExpanded;
  const setExpanded = (next: boolean): void => {
    if (group) group.setExpandedId(next ? label : null);
    else setLocalExpanded(next);
  };
  const open = expanded && !disabled;
  return (
  <Disclosure
    isDisabled={disabled}
    isExpanded={open}
    onExpandedChange={setExpanded}
    className={
      `group flex min-w-0 flex-col rounded-xl border border-line${
        className ? ` ${className}` : ''
      }${disabled ? ' opacity-60' : ''}`
    }
  >
    <Heading className="m-0">
      <Button
        slot="trigger"
        // Accessible name is just the label (unique + stable for tests
        // and screen readers); the current selection is announced via
        // aria-describedby. Expanded/collapsed state comes from the
        // native disclosure `aria-expanded`; the rotating chevron is the
        // only visual affordance (it's an expander, not edit-navigation).
        aria-label={label}
        aria-describedby={summaryId}
        // Theme-aware hover: a low-opacity ink wash subtly darkens in
        // light mode and lightens in dark mode. (The `surface-sunken`
        // token is darker than the surrounding surfaces in dark mode, so
        // it read as a near-black bar on this full-width trigger.)
        className="flex w-full items-center justify-between gap-2 rounded-xl px-4 py-3 text-left outline-none hover:bg-ink/5 data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring data-[disabled]:cursor-not-allowed data-[disabled]:hover:bg-transparent"
      >
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-semibold text-ink">{label}</span>
          {/* Summary hides when open — the controls below say it instead. */}
          <span
            id={summaryId}
            className="truncate text-sm text-muted group-data-[expanded]:hidden"
          >
            {summary}
          </span>
        </span>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className="h-6 w-6 shrink-0 text-muted transition-transform group-data-[expanded]:rotate-180"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 7.5 10 12.5 15 7.5" />
        </svg>
      </Button>
    </Heading>
    <DisclosurePanel className="px-4 pb-4">{children}</DisclosurePanel>
  </Disclosure>
  );
};
