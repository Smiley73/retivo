/**
 * ScheduleAnchorPicker — a11y smoke + per-kind render / switch /
 * payload-shape coverage. `components/`-dir, so the AGENTS axe-smoke
 * rule applies (at least one `expectNoA11yViolations`).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ScheduleAnchorPicker } from './ScheduleAnchorPicker';
import { expectNoA11yViolations } from '../test/a11y';
import type { Aggregate, GlideAnchor, HouseholdMemberPayload } from '../db/types';

const member = (
  isPrimary: boolean,
  firstName: string,
): Aggregate<HouseholdMemberPayload> => ({
  id: isPrimary ? 'p' : 's',
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-01-01T00:00:00Z',
  deviceId: 'd',
  aggregateType: 'householdMember',
  payload: {
    isPrimary,
    firstName,
    lastName: '',
    email: '',
    birthdate: '1965-01-01',
  },
});

const members = [member(true, 'John'), member(false, 'Jane')];

// The picker now renders inside a collapsible `AnchorCard` (collapsed
// shows a summary, the radios live behind the disclosure). Expand it so
// the per-kind controls are queryable. The trigger's accessible name is
// exactly the picker label. Disclosure state survives `rerender`, so one
// open per render is enough.
function openCard(label = 'Glide starts') {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

function renderPicker(value: GlideAnchor, relativeKind = true) {
  const onChange = vi.fn();
  const utils = render(
    <ScheduleAnchorPicker
      value={value}
      onChange={onChange}
      members={members}
      relativeKind={relativeKind}
      label="Glide starts"
    />,
  );
  openCard('Glide starts');
  return { onChange, ...utils };
}

describe('ScheduleAnchorPicker', () => {
  it('renders the radio group and the retirement-start option selected', () => {
    renderPicker({ kind: 'retirementStart' });
    expect(
      screen.getByRole('radiogroup', { name: 'Glide starts' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /start of retirement/i }),
    ).toBeChecked();
  });

  it('collapsed card summarises the current selection', () => {
    const onChange = vi.fn();
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'age', memberId: 'primary', years: 65, months: 0 }}
        onChange={onChange}
        members={members}
        relativeKind
        label="Glide starts"
      />,
    );
    // Collapsed: the radios are hidden behind the disclosure; the trigger
    // describes the current anchor in plain language.
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText('John age 65')).toBeInTheDocument();
  });

  it('keeps the age sub-input visible but disabled until the age kind is selected', () => {
    // Show-but-disable: every radio's input stays in the DOM; the ones
    // whose radio isn't selected are disabled, not hidden.
    const { rerender } = renderPicker({ kind: 'retirementStart' });
    expect(screen.getByLabelText('Glide starts age years')).toBeDisabled();
    rerender(
      <ScheduleAnchorPicker
        value={{ kind: 'age', memberId: 'primary', years: 65, months: 0 }}
        onChange={() => {}}
        members={members}
        relativeKind
        label="Glide starts"
      />,
    );
    const input = screen.getByLabelText('Glide starts age years');
    expect(input).toBeEnabled();
    expect(input).toHaveValue('65');
  });

  it('switching kind emits a sensible default for that kind', () => {
    const { onChange } = renderPicker({ kind: 'retirementStart' });
    fireEvent.click(screen.getByRole('radio', { name: /in year/i }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'year' }),
    );
  });

  it('year slider emits a year payload', () => {
    const { onChange } = renderPicker({ kind: 'year', year: 2040 });
    const slider = screen.getByRole('slider', { name: 'Glide starts year' });
    fireEvent.change(slider, { target: { value: '2045' } });
    expect(onChange).toHaveBeenCalledWith({ kind: 'year', year: 2045 });
  });

  it('relativeKind prop gates the 4th durationFromExpenseStart option', () => {
    const { rerender } = renderPicker({ kind: 'retirementStart' }, false);
    expect(
      screen.queryByRole('radio', { name: 'After' }),
    ).toBeNull();
    rerender(
      <ScheduleAnchorPicker
        value={{ kind: 'retirementStart' }}
        onChange={() => {}}
        members={members}
        relativeKind
        label="Glide starts"
      />,
    );
    expect(
      screen.getByRole('radio', { name: 'After' }),
    ).toBeInTheDocument();
  });

  it('durationFromExpenseStart years input combines into the stored total months', () => {
    // value carries 14 months (1y 2m); editing years to 3 ⇒ 3*12 + 2 = 38.
    const { onChange } = renderPicker({
      kind: 'durationFromExpenseStart',
      months: 14,
    });
    const years = screen.getByLabelText(
      'Glide starts years after expense start',
    );
    expect(years).toHaveValue('1');
    expect(
      screen.getByLabelText('Glide starts months after expense start'),
    ).toHaveValue('2');
    fireEvent.change(years, { target: { value: '3x' } });
    expect(onChange).toHaveBeenCalledWith({
      kind: 'durationFromExpenseStart',
      months: 38,
    });
  });

  it('durationFromExpenseStart months input clamps to 0-11 and combines', () => {
    const { onChange } = renderPicker({
      kind: 'durationFromExpenseStart',
      months: 24, // 2y 0m
    });
    const monthsInput = screen.getByLabelText(
      'Glide starts months after expense start',
    );
    // 99 clamps to 11; combined = 2*12 + 11 = 35.
    fireEvent.change(monthsInput, { target: { value: '99' } });
    expect(onChange).toHaveBeenCalledWith({
      kind: 'durationFromExpenseStart',
      months: 35,
    });
  });

  it('age kind is years-only and always writes months: 0', () => {
    const { onChange } = renderPicker({
      kind: 'age',
      memberId: 'primary',
      years: 65,
      months: 0,
    });
    // No months sub-input for the age kind.
    expect(screen.queryByLabelText('Glide starts age months')).toBeNull();
    const slider = screen.getByRole('slider', { name: 'Glide starts age years' });
    fireEvent.change(slider, { target: { value: '70' } });
    expect(onChange).toHaveBeenCalledWith({
      kind: 'age',
      memberId: 'primary',
      years: 70,
      months: 0,
    });
  });

  it('age member select renders only when a secondary member exists', async () => {
    const user = userEvent.setup();
    const { onChange, rerender } = renderPicker({
      kind: 'age',
      memberId: 'primary',
      years: 65,
      months: 0,
    });
    // The member picker is the shared React Aria <Select>;
    // open it and pick the secondary option (the native-select
    // fireEvent.change path no longer applies).
    const select = screen.getByLabelText('Glide starts age member');
    expect(select).toBeInTheDocument();
    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'Jane' }));
    expect(onChange).toHaveBeenCalledWith({
      kind: 'age',
      memberId: 'secondary',
      years: 65,
      months: 0,
    });
    // Single-member household ⇒ no select, role stays implicit primary.
    rerender(
      <ScheduleAnchorPicker
        value={{ kind: 'age', memberId: 'primary', years: 65, months: 0 }}
        onChange={() => {}}
        members={[member(true, 'John')]}
        relativeKind
        label="Glide starts"
      />,
    );
    expect(screen.queryByLabelText('Glide starts age member')).toBeNull();
  });

  it('expenseEndKind prop gates the 5th "When this expense ends" option (glide-end only)', () => {
    // Default render (no expenseEndKind) — the option is absent, so the
    // start/floor picker instances never offer it.
    const { rerender } = renderPicker({ kind: 'retirementStart' });
    expect(
      screen.queryByRole('radio', { name: /when this expense ends/i }),
    ).toBeNull();
    rerender(
      <ScheduleAnchorPicker
        value={{ kind: 'retirementStart' }}
        onChange={() => {}}
        members={members}
        relativeKind
        expenseEndKind
        label="Glide ends"
      />,
    );
    expect(
      screen.getByRole('radio', { name: /when this expense ends/i }),
    ).toBeInTheDocument();
  });

  it('selecting "When this expense ends" emits { kind: "expenseEnd" } with no sub-input', () => {
    const onChange = vi.fn();
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'retirementStart' }}
        onChange={onChange}
        members={members}
        relativeKind
        expenseEndKind
        label="Glide ends"
      />,
    );
    openCard('Glide ends');
    fireEvent.click(
      screen.getByRole('radio', { name: /when this expense ends/i }),
    );
    expect(onChange).toHaveBeenCalledWith({ kind: 'expenseEnd' });
  });

  it('renders the expenseEnd radio checked when the value is expenseEnd (no sub-input)', () => {
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'expenseEnd' }}
        onChange={() => {}}
        members={members}
        relativeKind
        expenseEndKind
        label="Glide ends"
      />,
    );
    openCard('Glide ends');
    expect(
      screen.getByRole('radio', { name: /when this expense ends/i }),
    ).toBeChecked();
    // `expenseEnd` has no sub-input of its own; the other rows' inputs
    // stay visible but disabled (show-but-disable pattern).
    expect(screen.getByLabelText('Glide ends age years')).toBeDisabled();
    expect(screen.getByLabelText('Glide ends year')).toBeDisabled();
  });

  it('has no a11y violations', async () => {
    // One representative scan of the age-kind radio group + sub-inputs (the
    // richest interactive variant). The picker is interactive, so the
    // a11y-smoke rule applies (AGENTS *Testing setup*); per-variant scans of
    // the other kinds are redundant.
    const { container } = renderPicker({
      kind: 'age',
      memberId: 'primary',
      years: 65,
      months: 0,
    });
    await expectNoA11yViolations(container);
  });

  it('keyboard: arrow keys move-and-select across the radio options (React Aria pattern)', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ kind: 'retirementStart' });
    // Tab order: the card's disclosure trigger first, then the RadioGroup
    // (a roving tabIndex landing on the currently-checked option).
    await user.tab();
    expect(screen.getByRole('button', { name: 'Glide starts' })).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole('radio', { name: /start of retirement/i }),
    ).toHaveFocus();
    // Selection-follows-focus: ArrowDown moves AND selects the next.
    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'age' }),
    );
  });

  it('disabled prop disables the card trigger so the picker cannot open', () => {
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'age', memberId: 'primary', years: 65, months: 0 }}
        onChange={() => {}}
        members={members}
        relativeKind
        label="Glide starts"
        disabled
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Glide starts' });
    expect(trigger).toBeDisabled();
    // Disabled ⇒ the disclosure stays collapsed; the radios never mount.
    fireEvent.click(trigger);
    expect(
      screen.queryByRole('radio', { name: /start of retirement/i }),
    ).toBeNull();
  });

  it('disabled prop defaults to false (existing callers unaffected)', () => {
    renderPicker({
      kind: 'age',
      memberId: 'primary',
      years: 65,
      months: 0,
    });
    expect(
      screen.getByRole('radio', { name: /start of retirement/i }),
    ).not.toBeDisabled();
    expect(screen.getByLabelText('Glide starts age years')).not.toBeDisabled();
  });

  it('memberSelectable={false} hides the member <select> even with a secondary member', () => {
    // Visibility only — the component still emits `memberId ?? primary`;
    // the keep/omit policy is the bridge's. With a secondary present
    // the select would normally render; gating it off hides it.
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'age', memberId: 'primary', years: 65, months: 0 }}
        onChange={() => {}}
        members={members}
        relativeKind
        memberSelectable={false}
        label="Glide starts"
      />,
    );
    openCard('Glide starts');
    expect(screen.queryByLabelText('Glide starts age member')).toBeNull();
    // The age slider still renders (slider bounds need `members`).
    expect(screen.getByLabelText('Glide starts age years')).toBeInTheDocument();
  });

  it('memberSelectable defaults to true (select shows with a secondary member)', () => {
    renderPicker({ kind: 'age', memberId: 'primary', years: 65, months: 0 });
    expect(screen.getByLabelText('Glide starts age member')).toBeInTheDocument();
  });

  it('collapsible={false} renders the always-expanded LabelledGroup (no disclosure)', () => {
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'retirementStart' }}
        onChange={() => {}}
        members={members}
        collapsible={false}
        label="Start"
      />,
    );
    // No collapsible trigger — the body is always visible.
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    // The body lives in a labelled group (role=group + aria-labelledby).
    const group = screen.getByRole('group', { name: 'Start' });
    expect(group).toBeInTheDocument();
    // The radiogroup is immediately queryable (not behind a disclosure)
    // and self-labelled by the group heading.
    expect(
      screen.getByRole('radiogroup', { name: 'Start' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /start of retirement/i }),
    ).toBeChecked();
  });

  it('collapsible defaults to true (renders the collapsible AnchorCard)', () => {
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'retirementStart' }}
        onChange={() => {}}
        members={members}
        label="Start"
      />,
    );
    // Default path: the disclosure trigger exists and the radios start
    // hidden behind it.
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('ageLabel overrides the age radio text (defaults to "At age")', () => {
    // Default: "At age".
    const { unmount } = render(
      <ScheduleAnchorPicker
        value={{ kind: 'retirementStart' }}
        onChange={() => {}}
        members={members}
        collapsible={false}
        label="Start"
      />,
    );
    expect(screen.getByRole('radio', { name: 'At age' })).toBeInTheDocument();
    unmount();
    // Override: Expense's personalized single-member label.
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'retirementStart' }}
        onChange={() => {}}
        members={members}
        collapsible={false}
        ageLabel="At Alex's age"
        label="Start"
      />,
    );
    expect(
      screen.getByRole('radio', { name: "At Alex's age" }),
    ).toBeInTheDocument();
  });

  it('defaultMemberId overrides the age-kind default member (defaults to primary)', () => {
    // Regression: switching to the `age` kind on a secondary-owned
    // stream must default the new anchor's memberId to the override, not a
    // hardcoded 'primary' (which the bridge's omit rule would silently keep
    // on a secondary stream, mis-anchoring to the wrong member).
    const onChange = vi.fn();
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'retirementStart' }}
        onChange={onChange}
        members={members}
        collapsible={false}
        defaultMemberId="secondary"
        label="Start"
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'At age' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'age', memberId: 'secondary' }),
    );
  });

  it('defaultMemberId defaults to primary when not provided', () => {
    const onChange = vi.fn();
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'retirementStart' }}
        onChange={onChange}
        members={members}
        collapsible={false}
        label="Start"
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'At age' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'age', memberId: 'primary' }),
    );
  });

  it('defaultYear overrides the year-kind default (defaults to current year)', () => {
    // Regression: switching to the `year` kind must honor the
    // caller's default (income uses currentYear + 5), not a bare
    // new Date().getFullYear().
    const onChange = vi.fn();
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'retirementStart' }}
        onChange={onChange}
        members={members}
        collapsible={false}
        defaultYear={2099}
        label="Start"
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: /in year/i }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'year', year: 2099 });
  });

  it('has no a11y violations in the non-collapsible LabelledGroup variant', async () => {
    // The newly-shared LabelledGroup wraps the always-expanded body; scan
    // it (role=group + aria-labelledby) to cover the new render path.
    const { container } = render(
      <ScheduleAnchorPicker
        value={{ kind: 'age', memberId: 'primary', years: 65, months: 0 }}
        onChange={() => {}}
        members={members}
        collapsible={false}
        label="Start"
      />,
    );
    await expectNoA11yViolations(container);
  });
});

// ---------------------------------------------------------------------------
// hideRetirementStart — END-anchor mode hides the retirementStart radio
// so a cap window's END only offers `age | year`.
// ---------------------------------------------------------------------------

describe('ScheduleAnchorPicker — hideRetirementStart (END-anchor mode)', () => {
  function renderEnd(hideRetirementStart: boolean | undefined) {
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'age', memberId: 'primary', years: 65, months: 0 }}
        onChange={() => {}}
        members={members}
        hideRetirementStart={hideRetirementStart}
        label="Cap ends"
      />,
    );
    openCard('Cap ends');
  }

  it('renders the retirementStart option when hideRetirementStart is false', () => {
    renderEnd(false);
    expect(
      screen.getByRole('radio', { name: /start of retirement/i }),
    ).toBeInTheDocument();
  });

  it('renders the retirementStart option when hideRetirementStart is undefined', () => {
    renderEnd(undefined);
    expect(
      screen.getByRole('radio', { name: /start of retirement/i }),
    ).toBeInTheDocument();
  });

  it('omits the retirementStart option when hideRetirementStart is true', () => {
    renderEnd(true);
    expect(
      screen.queryByRole('radio', { name: /start of retirement/i }),
    ).toBeNull();
    // The age + year kinds are still offered.
    expect(screen.getByRole('radio', { name: /age/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /in year/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// floor (lower-bound) — the mirror of `cap`. Raises the age/year slider MIN
// (e.g. the QCD editor floors the window at the giver's 70½ eligibility).
// ---------------------------------------------------------------------------

describe('ScheduleAnchorPicker — floor (lower-bound)', () => {
  // Member born 1965 ⇒ well under 70 at any plausible test clock, so a 70 age
  // floor genuinely raises the slider min above the member's current age.
  it('floor.age raises the age slider min above the current age', () => {
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'age', memberId: 'primary', years: 75, months: 0 }}
        onChange={() => {}}
        members={members}
        collapsible={false}
        floor={{ age: 70 }}
        label="Start"
      />,
    );
    const slider = screen.getByRole('slider', { name: 'Start age years' });
    expect(slider).toHaveAttribute('min', '70');
  });

  it('floor.year raises the year slider min to the floor year', () => {
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'year', year: 2040 }}
        onChange={() => {}}
        members={members}
        collapsible={false}
        floor={{ year: 2035 }}
        label="Start"
      />,
    );
    const slider = screen.getByRole('slider', { name: 'Start year' });
    expect(slider).toHaveAttribute('min', '2035');
  });

  it('omitted floor leaves the existing (current-age / current-year) min', () => {
    // No floor ⇒ the age slider min falls back to the member's current age
    // (well below 70), proving the new param defaults to no-floor.
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'age', memberId: 'primary', years: 75, months: 0 }}
        onChange={() => {}}
        members={members}
        collapsible={false}
        label="Start"
      />,
    );
    const slider = screen.getByRole('slider', { name: 'Start age years' });
    expect(Number(slider.getAttribute('min'))).toBeLessThan(70);
  });

  it('floor.age raises the year→age kind-switch seed to the floor (not 65)', () => {
    // Switching kind seeds a fresh anchor via defaultForKind; with a 70 floor
    // the seeded age must be >= 70, not the bare 65 default (which the
    // never-clamp guard would then preserve as a sub-floor slider min).
    const onChange = vi.fn();
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'year', year: 2040 }}
        onChange={onChange}
        members={members}
        collapsible={false}
        floor={{ age: 70 }}
        label="Start"
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'At age' }));
    expect(onChange).toHaveBeenCalledWith({
      kind: 'age',
      memberId: 'primary',
      years: 70,
      months: 0,
    });
  });

  it('floor.year raises the age→year kind-switch seed to the floor', () => {
    // defaultYear (current year) sits below the 2040 floor, so the seeded
    // year must be raised to the floor.
    const onChange = vi.fn();
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'age', memberId: 'primary', years: 75, months: 0 }}
        onChange={onChange}
        members={members}
        collapsible={false}
        floor={{ year: 2040 }}
        label="Start"
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: /in year/i }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'year', year: 2040 });
  });

  it('no floor ⇒ year→age kind switch still seeds 65 (existing callers unchanged)', () => {
    // Regression: callers that pass no `floor` (glide / Expense / income) must
    // keep seeding the bare 65 default on a kind switch.
    const onChange = vi.fn();
    render(
      <ScheduleAnchorPicker
        value={{ kind: 'year', year: 2040 }}
        onChange={onChange}
        members={members}
        collapsible={false}
        label="Start"
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'At age' }));
    expect(onChange).toHaveBeenCalledWith({
      kind: 'age',
      memberId: 'primary',
      years: 65,
      months: 0,
    });
  });
});
