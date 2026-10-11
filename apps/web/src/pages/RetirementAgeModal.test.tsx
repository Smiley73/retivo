/**
 * RetirementAgeModal — intro-copy contract.
 *
 * Pins the scenario-modal copy convention: the modal opens with a plain-English
 * `<p className="m-0 text-sm">` intro paragraph before any form control, at the
 * page-baseline body-copy size (`text-sm` pinned-size rule).
 */
import 'fake-indexeddb/auto';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetirementAgeModal } from './RetirementAgeModal';
import { clearAllStores } from '../db/store';
import type {
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

const HH = 'hh-test';

function makeMember(
  id: string,
  isPrimary: boolean,
  firstName: string,
): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary,
      firstName,
      lastName: 'Demo',
      email: `${id}@example.test`,
      birthdate: '1960-04-15',
    },
  };
}

function makeScenario(): ScenarioAggregate {
  return {
    id: 'sc-base',
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'Base',
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {},
    },
  };
}

afterEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
});

describe('RetirementAgeModal — intro copy', () => {
  it('renders a plain-English intro paragraph at text-sm before the controls', () => {
    const scenario = makeScenario();
    const primary = makeMember('hm-primary', true, 'Alex');
    render(
      <MemoryRouter>
        <RetirementAgeModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          primaryMember={primary}
          secondaryMember={null}
          householdId={HH}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    const intro = screen.getByText(/Set the age each household member stops working/i);
    expect(intro.tagName).toBe('P');
    expect(intro).toHaveClass('text-sm');
  });
});
