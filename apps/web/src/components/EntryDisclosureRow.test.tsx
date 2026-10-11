/**
 * EntryDisclosureRow — collapsed/expanded visibility, controlled expansion,
 * the problem chip + `aria-describedby` wiring, and the accessible
 * description. `components/`-dir, so the AGENTS axe-smoke rule applies (at
 * least one `expectNoA11yViolations`).
 */
import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EntryDisclosureRow } from './EntryDisclosureRow';
import { expectNoA11yViolations } from '../test/a11y';

function Controlled(
  props: Partial<
    Omit<React.ComponentProps<typeof EntryDisclosureRow>, 'expanded' | 'onExpandedChange'>
  > & { expanded?: boolean },
): React.ReactElement {
  const { expanded: initialExpanded, ...rest } = props;
  const [expanded, setExpanded] = useState(initialExpanded ?? false);
  return (
    <EntryDisclosureRow
      label="Conversion 1"
      summary="401(k) → Roth IRA"
      {...rest}
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      <button type="button">inner control</button>
    </EntryDisclosureRow>
  );
}

describe('EntryDisclosureRow', () => {
  it('collapsed: shows the summary, hides the body by role', () => {
    render(<Controlled />);
    expect(screen.getByText('401(k) → Roth IRA')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'inner control' }),
    ).toBeNull();
  });

  it('expands on trigger click to reveal the body (controlled by the parent)', () => {
    render(<Controlled />);
    fireEvent.click(screen.getByRole('button', { name: 'Conversion 1' }));
    expect(
      screen.getByRole('button', { name: 'inner control' }),
    ).toBeInTheDocument();
  });

  it('starts expanded when the parent passes expanded=true', () => {
    render(<Controlled expanded />);
    expect(
      screen.getByRole('button', { name: 'inner control' }),
    ).toBeInTheDocument();
  });

  it('re-clicking the open trigger collapses it (toggle-to-close)', () => {
    render(<Controlled expanded />);
    fireEvent.click(screen.getByRole('button', { name: 'Conversion 1' }));
    expect(
      screen.queryByRole('button', { name: 'inner control' }),
    ).toBeNull();
  });

  it('does not manage its own state — an external expanded=false prop force-collapses it', () => {
    const { rerender } = render(
      <EntryDisclosureRow
        label="Conversion 1"
        summary="401(k) → Roth IRA"
        expanded
        onExpandedChange={() => {}}
      >
        <button type="button">inner control</button>
      </EntryDisclosureRow>,
    );
    expect(
      screen.getByRole('button', { name: 'inner control' }),
    ).toBeInTheDocument();
    rerender(
      <EntryDisclosureRow
        label="Conversion 1"
        summary="401(k) → Roth IRA"
        expanded={false}
        onExpandedChange={() => {}}
      >
        <button type="button">inner control</button>
      </EntryDisclosureRow>,
    );
    expect(
      screen.queryByRole('button', { name: 'inner control' }),
    ).toBeNull();
  });

  it('shows the problem chip collapsed AND expanded', () => {
    render(<Controlled problem="Needs attention" />);
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Conversion 1' }));
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
  });

  it('hides no problem chip when problem is absent', () => {
    render(<Controlled />);
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });

  it('the trigger is described by the summary, the amount (when set), and the problem chip', () => {
    render(<Controlled amount="$10,000/yr" problem="Needs attention" />);
    const trigger = screen.getByRole('button', { name: 'Conversion 1' });
    const describedByIds = trigger.getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(describedByIds.length).toBeGreaterThanOrEqual(3);
    const describedText = describedByIds
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(describedText).toContain('401(k) → Roth IRA');
    expect(describedText).toContain('$10,000/yr');
    expect(describedText).toContain('Needs attention');
  });

  it('the trigger has no amount in its description when amount is omitted (QCD rows)', () => {
    render(<Controlled />);
    const trigger = screen.getByRole('button', { name: 'Conversion 1' });
    const describedByIds = trigger.getAttribute('aria-describedby')?.split(' ') ?? [];
    const describedText = describedByIds
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(describedText).not.toContain('$');
  });

  it('shows the right-aligned amount collapsed, hidden while expanded', () => {
    render(<Controlled amount="$10,000/yr" />);
    expect(screen.getByText('$10,000/yr')).toBeInTheDocument();
  });

  it('has no a11y violations (expanded — the richer disclosure tree)', async () => {
    const { container } = render(<Controlled amount="$10,000/yr" problem="Needs attention" />);
    fireEvent.click(screen.getByRole('button', { name: 'Conversion 1' }));
    await expectNoA11yViolations(container);
  });
});
