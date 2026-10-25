/**
 * Collapsible card shared by the schedule-anchor pickers: collapsed it shows the label and a summary, expanded the
 * picker body. `AnchorCardGroup` makes siblings single-expand, keyed by `label`, so labels must be unique per group.
 */
import React, { createContext, useContext, useId, useState } from 'react';
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';

interface AnchorCardGroupValue {
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
}

const AnchorCardGroupContext = createContext<AnchorCardGroupValue | null>(null);

/** Single-expand coordinator: opening one descendant card collapses the previously open sibling. */
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
  label: string;
  summary: string;
  children: React.ReactNode;
  /** Disables the card: the trigger cannot expand and the card dims. */
  disabled?: boolean;
  className?: string;
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
  // Controlled so disabling a card also collapses it; otherwise a card left open when disabled
  // would be stuck open. Inside an `<AnchorCardGroup>` the open card is shared state keyed by
  // `label`.
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
        // The accessible name is the label; the selection is announced via `aria-describedby`.
        aria-label={label}
        aria-describedby={summaryId}
        // A low-opacity ink wash hovers correctly in both themes, where `surface-sunken` reads as a
        // near-black bar in dark mode.
        className="flex w-full items-center justify-between gap-2 rounded-xl px-4 py-3 text-left outline-none hover:bg-ink/5 data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring data-[disabled]:cursor-not-allowed data-[disabled]:hover:bg-transparent"
      >
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-semibold text-ink">{label}</span>
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
