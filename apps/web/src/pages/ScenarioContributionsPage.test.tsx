// ScenarioContributionsPage grid landmark, single-row header and a focusable in-row money input.
// Arrow-key navigation is not asserted: React Aria's grid focus-delegate fires browser-level focus-manager events jsdom cannot synthesize; it is covered by a manual keyboard check.
import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllStores, getAggregate, putAggregate } from '../db/store';
import { expectNoA11yViolations } from '../test/a11y';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { ScenarioContributionsPage } from './ScenarioContributionsPage';

const HH = 'hh-test';
const SCENARIO_ID = 'sc-1';

function setupContexts() {
  (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    householdId: HH,
    me: { email: 'me@example.test', displayName: 'Me', roles: [], userId: 'u-1' },
    isAuthenticated: true,
  });
  (useSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    notifyPending: vi.fn(),
    state: { kind: 'synced', lastSyncedAt: null },
  });
}

function renderPage(scenarioId: string = SCENARIO_ID) {
  return render(
    <MemoryRouter initialEntries={[`/scenarios/${scenarioId}/contributions`]}>
      <Routes>
        <Route
          path="/scenarios/:id/contributions"
          element={<ScenarioContributionsPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

async function seed(): Promise<void> {
  const m: Aggregate<HouseholdMemberPayload> = {
    id: 'hm-1',
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary: true,
      firstName: 'Alex',
      lastName: 'Primary',
      email: 'alex@example.test',
      birthdate: '1985-04-15',
    },
  };
  await putAggregate('householdMember', m);
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
      plannedContributionPreTax: 22500,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    },
  };
  await putAggregate('account', acc);
}

describe('ScenarioContributionsPage', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders the RA grid landmark with the migrated header without a11y violations', async () => {
    await seed();
    const { container } = renderPage();
    const grid = await screen.findByRole(
      'grid',
      { name: 'Per-account contribution overrides' },
      { timeout: 5000 },
    );
    expect(grid).toBeInTheDocument();
    // The grid landmark can mount a tick before its columnheaders under parallel load.
    expect(
      await screen.findByRole('columnheader', { name: 'Account' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('columnheader', { name: 'Baseline pre-tax' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('columnheader', { name: 'Scenario pre-tax' }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('renders the foot-note overridden-account summary', async () => {
    await seed();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    expect(
      screen.getByText('0 of 1 accounts overridden.'),
    ).toBeInTheDocument();
  });

  it('renders the editable in-row MoneyInput cell', async () => {
    await seed();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    expect(
      screen.getByLabelText('My 401k scenario pre-tax'),
    ).toBeInTheDocument();
  });

  it('no longer shows the stale flat-nominal contribution hint (contributions now track inflation)', async () => {
    // Contributions are inflation-indexed by default, so the override surface drops the old flat-nominal hint.
    await seed();
    renderPage();
    await screen.findByRole('columnheader', { name: 'Account' });
    expect(
      screen.queryByText(/projected as a flat amount/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/keep pace with inflation/i),
    ).not.toBeInTheDocument();
  });

  it('keeps the editable in-row MoneyInput cell mounted across consecutive edits (no-remount proxy)', async () => {
    // Typing into the MoneyInput cell must not remount mid-edit and evict the pending keystroke; the same element instance must survive consecutive input events.
    await seed();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    const firstRef = screen.getByLabelText(
      'My 401k scenario pre-tax',
    ) as HTMLInputElement;
    act(() => {
      fireEvent.input(firstRef, { target: { value: '1000' } });
    });
    // MoneyInput normalises display to two decimals (`1000` → `1000.00`); assert the prefix so the test survives the display-format helper.
    expect(firstRef.value).toMatch(/^1000/);
    const secondRef = screen.getByLabelText(
      'My 401k scenario pre-tax',
    ) as HTMLInputElement;
    act(() => {
      fireEvent.input(secondRef, { target: { value: '1500' } });
    });
    expect(secondRef.value).toMatch(/^1500/);
    expect(firstRef === secondRef).toBe(true);
  });

  it('renders <NotesIndicator> next to the account name when notes are set (parity with Accounts + AccountBalances pages)', async () => {
    await seed();
    const accWithNotes: Aggregate<AccountPayload> = {
      id: 'acc-1',
      householdId: HH,
      aggregateType: 'account',
      schemaVersion: 1,
      version: 2,
      updatedAt: '2026-05-02T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'My 401k',
        type: 'RETIREMENT_401K',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'PRE_TAX',
        ownerId: 'hm-1',
        institution: 'Vanguard',
        notes: 'Maxed out for the year',
        planningReturnPct: 7,
        active: true,
        plannedContributionPreTax: 22500,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      },
    };
    await putAggregate('account', accWithNotes);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    const indicators = screen.getAllByRole('img', { name: 'Notes' });
    expect(indicators).toHaveLength(1);
  });

  it('shows the "Match inflation (X%)" placeholder with the resolved rate (scenario)', async () => {
    // This page has scenario context, so the inherited-growth placeholder carries the scenario's resolved inflation rate.
    await seed();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    const placeholder = screen.getByRole('button', {
      name: /My 401k annual increase — match inflation \(\d+(\.\d+)?%\) \(set a rate\)/i,
    });
    expect(placeholder).toHaveTextContent(/Match inflation \(\d+(\.\d+)?%\)/);
  });

  it('persists a scenario annual-increase override (scenario)', async () => {
    await seed();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: /My 401k annual increase — match inflation .* \(set a rate\)/i,
        }),
      );
    });
    const input = (await screen.findByLabelText(
      'My 401k scenario annual increase',
    )) as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '6' } });
      fireEvent.blur(input);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(async () => {
      const stored = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      expect(
        stored?.payload.overrides.accountContributions?.perAccount?.['acc-1']
          ?.contributionGrowthPct,
      ).toBe(6);
    });
  });

  it('clears a scenario annual-increase override back to inherited (scenario)', async () => {
    await seed();
    const scWithGrowth: Aggregate<ScenarioPayload> = {
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
          accountContributions: {
            perAccount: { 'acc-1': { contributionGrowthPct: 6 } },
          },
        },
      },
    };
    await putAggregate('scenario', scWithGrowth);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    expect(
      await screen.findByLabelText('My 401k scenario annual increase'),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: /Clear My 401k annual increase override/i,
        }),
      );
    });
    await screen.findByRole('button', {
      name: /My 401k annual increase — match inflation .* \(set a rate\)/i,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(async () => {
      const stored = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      expect(stored?.payload.overrides.accountContributions).toBeUndefined();
    });
  });

  it('persists an explicit 0% scenario override as flat-nominal (scenario)', async () => {
    await seed();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', {
          name: /My 401k annual increase — match inflation .* \(set a rate\)/i,
        }),
      );
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(async () => {
      const stored = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      expect(
        stored?.payload.overrides.accountContributions?.perAccount?.['acc-1']
          ?.contributionGrowthPct,
      ).toBe(0);
    });
  });

  it('preserves a pre-existing contributionGrowthPct override when an amount is edited', async () => {
    // Regression: an imported or demo scenario can carry a per-account `contributionGrowthPct` override that this amounts-only screen never edits; saving an amount change must not drop it, including for a growth-only account whose amounts match the baseline (acc-2).
    await seed();
    const acc2: Aggregate<AccountPayload> = {
      id: 'acc-2',
      householdId: HH,
      aggregateType: 'account',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'My IRA',
        type: 'RETIREMENT_IRA',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'PRE_TAX',
        ownerId: 'hm-1',
        institution: 'Fidelity',
        notes: '',
        planningReturnPct: 7,
        active: true,
        plannedContributionPreTax: 7000,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      },
    };
    await putAggregate('account', acc2);
    const scWithGrowth: Aggregate<ScenarioPayload> = {
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
          accountContributions: {
            perAccount: {
              'acc-1': { contributionGrowthPct: 4 },
              'acc-2': { contributionGrowthPct: 2 },
            },
          },
        },
      },
    };
    await putAggregate('scenario', scWithGrowth);

    renderPage();
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    const acc1Pre = screen.getByLabelText(
      'My 401k scenario pre-tax',
    ) as HTMLInputElement;
    act(() => {
      fireEvent.input(acc1Pre, { target: { value: '25000' } });
    });
    fireEvent.blur(acc1Pre);

    const saveBtn = screen.getByRole('button', { name: 'Save' });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(async () => {
      const stored = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      const per = stored?.payload.overrides.accountContributions?.perAccount;
      expect(per).toBeDefined();
      expect(per?.['acc-1']?.plannedContributionPreTax).toBe(25000);
      expect(per?.['acc-1']?.contributionGrowthPct).toBe(4);
      expect(per?.['acc-2']?.contributionGrowthPct).toBe(2);
    });
  });

  it('shows the inherited explicit rate placeholder on a CHILD scenario (S4a — buildInheritedGrowthMap child branch)', async () => {
    // A child scenario with no growth override resolves the parent chain via `resolveContributionGrowth(parentScenarioId, …)`; with a fixed 6% account baseline the placeholder must read "Inherited (6%)", the child branch no other test reaches.
    const m: Aggregate<HouseholdMemberPayload> = {
      id: 'hm-1',
      householdId: HH,
      aggregateType: 'householdMember',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        isPrimary: true,
        firstName: 'Alex',
        lastName: 'Primary',
        email: 'alex@example.test',
        birthdate: '1985-04-15',
      },
    };
    await putAggregate('householdMember', m);
    const base: Aggregate<ScenarioPayload> = {
      id: 'base-1',
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
    await putAggregate('scenario', base);
    const child: Aggregate<ScenarioPayload> = {
      id: 'child-1',
      householdId: HH,
      aggregateType: 'scenario',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Child',
        description: '',
        parentScenarioId: 'base-1',
        isPrimary: false,
        notes: '',
        overrides: {},
      },
    };
    await putAggregate('scenario', child);
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
        plannedContributionPreTax: 22500,
        plannedContributionPostTax: 0,
        contributionGrowthPct: 6,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      },
    };
    await putAggregate('account', acc);

    renderPage('child-1');
    await waitFor(() =>
      expect(screen.getByText('My 401k')).toBeInTheDocument(),
    );
    const placeholder = await screen.findByRole('button', {
      name: /My 401k annual increase — Inherited \(.*%\) \(set a rate\)/i,
    });
    expect(placeholder).toHaveTextContent(/Inherited \(6(\.\d+)?%\)/);
  });
});
