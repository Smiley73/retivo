// ScenarioAssetMixPage grid landmark, per-cell PercentInput pattern and sticky-top class wiring; full arrow-key navigation is covered by a manual keyboard check.
import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllStores, putAggregate } from '../db/store';
import { expectNoA11yViolations } from '../test/a11y';
import type {
  AccountPayload,
  Aggregate,
  ScenarioPayload,
} from '../db/types';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));

import { useAuth } from '../auth/AuthContext';
import { ScenarioAssetMixPage } from './ScenarioAssetMixPage';

const HH = 'hh-test';
const SCENARIO_ID = 'sc-1';

function setupContexts() {
  (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    householdId: HH,
    me: { email: 'me@example.test', displayName: 'Me', roles: [], userId: 'u-1' },
    isAuthenticated: true,
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/scenarios/${SCENARIO_ID}/asset-mix`]}>
      <Routes>
        <Route
          path="/scenarios/:id/asset-mix"
          element={<ScenarioAssetMixPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

async function seed(): Promise<void> {
  const sc: Aggregate<ScenarioPayload> = {
    id: SCENARIO_ID,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'Baseline',
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {},
    },
  };
  await putAggregate('scenario', sc);
  const acc: Aggregate<AccountPayload> = {
    id: 'acc-1',
    householdId: HH,
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'My 401k',
      type: 'RETIREMENT_401K',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'PRE_TAX',
      ownerId: 'hm-1',
      institution: 'Vanguard',
      notes: '',
      planningReturnPct: 7,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    },
  };
  await putAggregate('account', acc);
}

async function seedWithOverride(): Promise<void> {
  await seed();
  const sc: Aggregate<ScenarioPayload> = {
    id: SCENARIO_ID,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 2,
    updatedAt: '2026-05-02T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'Baseline',
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {
        accountAssetMix: {
          perAccount: {
            'acc-1': { stocksPct: 70, bondsPct: 25, cashPct: 5 },
          },
        },
      },
    },
  };
  await putAggregate('scenario', sc);
}

describe('ScenarioAssetMixPage', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders the RA grid landmark inside the TableScroll region without a11y violations', async () => {
    await seed();
    const { container } = renderPage();
    const region = await screen.findByRole(
      'region',
      { name: 'Per-account asset mix' },
      { timeout: 5000 },
    );
    expect(region).toBeInTheDocument();
    expect(
      await screen.findByRole(
        'grid',
        { name: 'Per-account asset mix' },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('renders a plain-English PageHeader subtitle with no "Monte Carlo" jargon', async () => {
    await seed();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Set a different stocks \/ bonds \/ cash split/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Monte Carlo/i)).not.toBeInTheDocument();
  });

  it('renders sticky-top Column class wiring', async () => {
    await seed();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    // jsdom-safe className check: paint behaviour is covered by the manual visual check.
    const accountHeader = screen.getByRole('columnheader', { name: 'Account' });
    expect(accountHeader.className).toContain('sticky');
    expect(accountHeader.className).toContain('top-0');
    const stocksHeader = screen.getByRole('columnheader', { name: 'Stocks %' });
    expect(stocksHeader.className).toContain('sticky');
    expect(stocksHeader.className).toContain('top-0');
  });

  it('renders editable in-row PercentInput cells', async () => {
    await seed();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('My 401k stocks')).toBeInTheDocument();
    expect(screen.getByLabelText('My 401k bonds')).toBeInTheDocument();
    expect(screen.getByLabelText('My 401k cash')).toBeInTheDocument();
  });

  it('keeps the editable in-row PercentInput cell mounted across consecutive edits (no-remount proxy)', async () => {
    // Typing into the PercentInput cell must not remount mid-edit and evict the pending keystroke. jsdom-stable proxy: consecutive input events reach the controlled value and the queried element is the same object across edits.
    // Seed an existing override so the cell starts enabled; a disabled input would let synthetic events bypass the real editable state machine.
    await seedWithOverride();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    const firstRef = screen.getByLabelText('My 401k stocks') as HTMLInputElement;
    expect(firstRef.disabled).toBe(false);
    act(() => {
      fireEvent.input(firstRef, { target: { value: '7' } });
    });
    // PercentInput normalises display to one decimal (`7` → `7.0`); assert the prefix so the test survives the display-format helper.
    expect(firstRef.value).toMatch(/^7/);
    const secondRef = screen.getByLabelText('My 401k stocks') as HTMLInputElement;
    act(() => {
      fireEvent.input(secondRef, { target: { value: '7.5' } });
    });
    expect(secondRef.value).toMatch(/^7\.5/);
    expect(firstRef === secondRef).toBe(true);
  });
});
