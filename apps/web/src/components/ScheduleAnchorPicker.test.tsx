/** ScheduleAnchorPicker: per-kind render, kind switching and anchor payload shape. */
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

// Expand the collapsible AnchorCard so the per-kind controls are queryable; its trigger is named by the picker label.
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
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText('John age 65')).toBeInTheDocument();
  });

  it('keeps the age sub-input visible but disabled until the age kind is selected', () => {
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
    expect(screen.getByLabelText('Glide ends age years')).toBeDisabled();
    expect(screen.getByLabelText('Glide ends year')).toBeDisabled();
  });

  it('has no a11y violations', async () => {
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
    await user.tab();
    expect(screen.getByRole('button', { name: 'Glide starts' })).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole('radio', { name: /start of retirement/i }),
    ).toHaveFocus();
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
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    const group = screen.getByRole('group', { name: 'Start' });
    expect(group).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('ageLabel overrides the age radio text (defaults to "At age")', () => {
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
});

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
    expect(screen.getByRole('radio', { name: /age/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /in year/i })).toBeInTheDocument();
  });
});

describe('ScheduleAnchorPicker — floor (lower-bound)', () => {
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
