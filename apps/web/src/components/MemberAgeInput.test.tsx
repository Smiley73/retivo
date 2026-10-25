/** MemberAgeInput: member dropdown only with a secondary member, and years and months inputs with their aria labels. */
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
    // The member picker is the shared Select: a button with aria-haspopup="listbox", absent for a single-member household.
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
    const dropdown = screen.getByRole('button', { name: /End age member/ });
    expect(dropdown).toHaveTextContent('Alexandria');
    expect(screen.getByLabelText('End age years')).toHaveValue('67');
    expect(screen.getByLabelText('End age months')).toHaveValue('6');
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
