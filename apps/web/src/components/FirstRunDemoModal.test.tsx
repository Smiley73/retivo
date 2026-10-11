/**
 * FirstRunDemoModal — render + interaction tests.
 *
 * Drives the modal through fake-indexeddb so the real
 * `loadDemoData` path runs end-to-end. Asserts the loader
 * actually populates IndexedDB on confirm and that Skip closes
 * without writing anything.
 */
import 'fake-indexeddb/auto';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllStores, listAggregates, listPendingMutations, putAggregate } from '../db/store';
import type { Aggregate, HouseholdMemberPayload } from '../db/types';
import { FirstRunDemoModal } from './FirstRunDemoModal';
import { expectNoA11yViolations } from '../test/a11y';

const HH = 'hh-test';

function renderModal(overrides: Partial<React.ComponentProps<typeof FirstRunDemoModal>> = {}) {
  const onLoaded = vi.fn();
  const onSkip = vi.fn();
  const utils = render(
    <FirstRunDemoModal
      open
      householdId={HH}
      email="me@example.test"
      displayName="Me Demo"
      onLoaded={onLoaded}
      onSkip={onSkip}
      {...overrides}
    />,
  );
  return { ...utils, onLoaded, onSkip };
}

describe('FirstRunDemoModal', () => {
  beforeEach(async () => {
    await clearAllStores();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders the prompt when open', () => {
    renderModal();
    expect(
      screen.getByRole('heading', { name: /Try the demo dataset\?/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load demo data' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
  });

  it('Skip fires onSkip without writing IndexedDB', async () => {
    const { onSkip, onLoaded } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onSkip).toHaveBeenCalled();
    expect(onLoaded).not.toHaveBeenCalled();
    const accounts = await listAggregates('account');
    expect(accounts).toHaveLength(0);
  });

  it('Load demo data populates IndexedDB and calls onLoaded', async () => {
    const { onLoaded } = renderModal();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load demo data' }));
    });
    await waitFor(() => expect(onLoaded).toHaveBeenCalled());
    const accounts = await listAggregates('account');
    const members = await listAggregates('householdMember');
    expect(accounts.length).toBeGreaterThan(0);
    expect(members.length).toBeGreaterThanOrEqual(2);
    const pending = await listPendingMutations();
    // 1 primary + 1 secondary + 14 accounts + 140 balances + 2 SS + 4 scenarios
    // (Base + Retire early at 62 + Delay — work to 70 + Funds Run Out) + 8
    // expense categories + 24 expenses + 1 income stream (CBP-payout-to-IRA
    // lump sum) = 195 mutations.
    expect(pending.length).toBe(195);
  });

  it('has no a11y violations when open', async () => {
    const { container } = renderModal();
    await expectNoA11yViolations(container);
  });

  it('shows DEMO_DATA_EXISTS error when workspace is not empty', async () => {
    const accountRow: Aggregate<HouseholdMemberPayload> = {
      id: 'hm-secondary',
      householdId: HH,
      aggregateType: 'householdMember',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        isPrimary: false,
        firstName: 'Existing',
        lastName: 'Secondary',
        email: 'sec@example.test',
        birthdate: '1985-01-01',
      },
    };
    await putAggregate('householdMember', accountRow);
    const { onLoaded } = renderModal();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load demo data' }));
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/already has household or account data/i);
    });
    expect(onLoaded).not.toHaveBeenCalled();
  });
});
