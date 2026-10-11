/**
 * MemberAgeInput — a11y smoke + dropdown-visibility coverage.
 *
 * Behavioural integration (kind-radio reveals/hides the input) lives in
 * the consuming pages' tests (ExpenseFormPage, IncomeFormPage). This
 * file's job is to lock the standalone contract: shows member dropdown
 * when a secondary exists, hides it otherwise, and surfaces years +
 * months inputs with the right aria labels.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemberAgeInput } from './MemberAgeInput';
import { expectNoA11yViolations } from '../test/a11y';
import type { Aggregate, HouseholdMemberPayload } from '../db/types';

const makeMember = (
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

describe('MemberAgeInput', () => {
  it('hides member dropdown when no secondary exists', () => {
    render(
      <MemberAgeInput
        members={[makeMember(true, 'Christopher')]}
        years={65}
        months={0}
        onChange={() => {}}
        ariaPrefix="Start age"
      />,
    );
    // The member picker is the shared React Aria <Select> —
    // its trigger is a button with aria-haspopup="listbox", not a
    // native combobox; it is absent for a single-member household.
    expect(
      screen.queryByRole('button', { name: /Start age member/ }),
    ).toBeNull();
    expect(screen.getByLabelText('Start age years')).toHaveValue('65');
    expect(screen.getByLabelText('Start age months')).toHaveValue('0');
  });

  it('shows member dropdown when a secondary exists', () => {
    render(
      <MemberAgeInput
        members={[makeMember(true, 'Christopher'), makeMember(false, 'Alexandria')]}
        memberId="secondary"
        years={67}
        months={6}
        onChange={() => {}}
        ariaPrefix="End age"
      />,
    );
    // React Aria's <Select> trigger is a button labelled
    // "<aria-label> <value>"; the selected member's name renders as the
    // trigger's value text (preserved frozen behavioral contract).
    const dropdown = screen.getByRole('button', { name: /End age member/ });
    expect(dropdown).toHaveTextContent('Alexandria');
    expect(screen.getByLabelText('End age years')).toHaveValue('67');
    expect(screen.getByLabelText('End age months')).toHaveValue('6');
  });

  it('has no a11y violations (single-member)', async () => {
    const { container } = render(
      <MemberAgeInput
        members={[makeMember(true, 'Christopher')]}
        years={65}
        months={0}
        onChange={() => {}}
        ariaPrefix="Start age"
      />,
    );
    await expectNoA11yViolations(container);
  });

  it('has no a11y violations (with secondary)', async () => {
    const { container } = render(
      <MemberAgeInput
        members={[makeMember(true, 'Christopher'), makeMember(false, 'Alexandria')]}
        memberId="primary"
        years={65}
        months={0}
        onChange={() => {}}
        ariaPrefix="Start age"
      />,
    );
    await expectNoA11yViolations(container);
  });
});
