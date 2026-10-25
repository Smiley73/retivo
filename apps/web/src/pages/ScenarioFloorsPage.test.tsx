// ScenarioFloorsPage render and save over fake-indexeddb. Most cases render the page directly at the floors route; one smoke case renders the full `<App>` to prove the route is registered.
import 'fake-indexeddb/auto';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllStores, getAggregate, putAggregate } from '../db/store';
import { expectNoA11yViolations } from '../test/a11y';
import type {
  AccountPayload,
  AccountTaxTreatment,
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
  ScenarioOverrides,
} from '../db/types';
import type { AccountType } from '../api/types';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));
// The full-App smoke test stubs the heavy shell chrome so the route table is reachable without the first-run/bootstrap machinery (mirrors App.test.tsx's stub set).
vi.mock('../layout/Sidebar', () => ({ Sidebar: () => <nav data-testid="sidebar" /> }));
vi.mock('../components/MobileNavDrawer', () => ({
  MobileNavDrawer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../monte-carlo/MonteCarloProvider', () => ({
  MonteCarloProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../monte-carlo/MonteCarloProgressChip', () => ({
  MonteCarloProgressChip: () => null,
}));
vi.mock('../components/VersionBanner', () => ({ VersionBanner: () => null }));
vi.mock('../components/FirstRunDemoModal', () => ({ FirstRunDemoModal: () => null }));
vi.mock('../components/HouseholdReadyBanner', () => ({
  HouseholdReadyBanner: () => null,
  bannerPendingKey: (hh: string) => `retivo:household-ready-banner-pending:${hh}`,
  shouldShowReadyBanner: () => false,
}));

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { ScenarioFloorsPage } from './ScenarioFloorsPage';
import { App } from '../App';

const HH = 'hh-test';

function setupContexts(): void {
  (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    householdId: HH,
    me: { email: 'me@example.test', displayName: 'Me', roles: [], userId: 'u-1' },
    isAuthenticated: true,
    isBooting: false,
    hasRole: () => true,
    logout: vi.fn(),
    // The shell's first-run check is never reached here (`lastSyncedAt` is null).
    fetchAccountRecord: vi.fn().mockResolvedValue({ email: 'me@example.test' }),
  });
  (useSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    notifyPending: vi.fn(),
    state: { kind: 'synced', lastSyncedAt: null },
    runDestructive: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  });
}

function renderAt(scenarioId: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/scenarios/${scenarioId}/floors`]}>
      <Routes>
        <Route path="/scenarios/:id/floors" element={<ScenarioFloorsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderApp(scenarioId: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/scenarios/${scenarioId}/floors`]}>
      <App />
    </MemoryRouter>,
  );
}

async function seedMember(id: string, firstName: string): Promise<void> {
  const m: Aggregate<HouseholdMemberPayload> = {
    id,
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary: true,
      firstName,
      lastName: 'Demo',
      email: `${firstName.toLowerCase()}@example.test`,
      birthdate: '1985-01-01',
    },
  };
  await putAggregate('householdMember', m);
}

async function seedAccount(
  id: string,
  name: string,
  type: AccountType,
  taxTreatment: AccountTaxTreatment,
): Promise<void> {
  const a: Aggregate<AccountPayload> = {
    id,
    householdId: HH,
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name,
      type,
      ownershipType: 'INDIVIDUAL',
      taxTreatment,
      ownerId: 'hm-1',
      institution: 'Test Bank',
      notes: '',
      planningReturnPct: 5,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
  await putAggregate('account', a);
}

async function seedScenario(
  id: string,
  name: string,
  overrides: ScenarioOverrides = {},
  opts: { parentScenarioId?: string | null; isPrimary?: boolean } = {},
): Promise<void> {
  const parentScenarioId = opts.parentScenarioId ?? null;
  const s: Aggregate<ScenarioPayload> = {
    id,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name,
      description: '',
      parentScenarioId,
      isPrimary: opts.isPrimary ?? parentScenarioId === null,
      notes: '',
      overrides,
    },
  };
  await putAggregate('scenario', s);
}

async function seedEligibilityFixture(): Promise<void> {
  await seedMember('hm-1', 'Alex');
  await seedAccount('acc-bro', 'My Brokerage', 'BROKERAGE', 'POST_TAX');
  await seedAccount('acc-hsa', 'My HSA', 'HSA', 'HSA');
  await seedAccount('acc-401k', 'My 401k', 'RETIREMENT_401K', 'PRE_TAX');
  await seedAccount('acc-roth', 'My Roth IRA', 'RETIREMENT_ROTH_IRA', 'ROTH');
}

describe('ScenarioFloorsPage', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    cleanup();
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders only floor-eligible accounts and omits ineligible ones', async () => {
    await seedEligibilityFixture();
    await seedScenario('sc-1', 'Base');

    renderAt('sc-1');

    const grid = await screen.findByRole('grid', {
      name: 'Per-account minimum-balance floors',
    });
    expect(await within(grid).findByText('My Brokerage')).toBeInTheDocument();
    expect(within(grid).getByText('My HSA')).toBeInTheDocument();
    expect(within(grid).queryByText('My 401k')).not.toBeInTheDocument();
    expect(within(grid).queryByText('My Roth IRA')).not.toBeInTheDocument();
    expect(
      screen.getByText('0 of 2 eligible accounts overridden here.'),
    ).toBeInTheDocument();
  });

  it('lets the user set a floor value, surfacing the Save action', async () => {
    await seedEligibilityFixture();
    await seedScenario('sc-1', 'Base');

    renderAt('sc-1');

    await screen.findByRole('grid', { name: 'Per-account minimum-balance floors' });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    // findBy, not getBy: the grid resolving does not guarantee its rows have rendered, and a synchronous get has no retry.
    const setBtn = await screen.findByRole('button', {
      name: 'My Brokerage minimum balance — no floor (set one)',
    });
    await userEvent.click(setBtn);
    const input = (await screen.findByLabelText(
      'My Brokerage minimum balance',
    )) as HTMLInputElement;
    act(() => {
      fireEvent.input(input, { target: { value: '10000' } });
    });
    expect(
      await screen.findByRole('button', { name: 'Save' }),
    ).toBeInTheDocument();
  });

  it('resets a row to the inherited baseline (clears the local override)', async () => {
    await seedEligibilityFixture();
    await seedScenario('sc-1', 'Base', {
      accountFloors: { perAccount: { 'acc-bro': { floorDollars: 25000 } } },
    });

    renderAt('sc-1');

    await screen.findByRole('grid', { name: 'Per-account minimum-balance floors' });
    expect(
      await screen.findByLabelText('My Brokerage minimum balance'),
    ).toBeInTheDocument();
    const resetBtn = screen.getByRole('button', {
      name: 'Reset My Brokerage floor override',
    });
    await userEvent.click(resetBtn);
    expect(
      await screen.findByRole('button', {
        name: 'My Brokerage minimum balance — no floor (set one)',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save' }),
    ).toBeInTheDocument();
  });

  it('shows the HSA mode toggle for an HSA row and not for a POST_TAX row', async () => {
    await seedEligibilityFixture();
    await seedScenario('sc-1', 'Base', {
      accountFloors: {
        perAccount: {
          'acc-bro': { floorDollars: 5000 },
          'acc-hsa': { floorDollars: 8000 },
        },
      },
    });

    renderAt('sc-1');

    await screen.findByRole('grid', { name: 'Per-account minimum-balance floors' });
    expect(
      await screen.findByRole('radiogroup', { name: 'My HSA HSA floor mode' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('radiogroup', { name: 'My Brokerage HSA floor mode' }),
    ).toBeNull();
  });

  it('switches the HSA floor mode, surfacing Save', async () => {
    await seedEligibilityFixture();
    await seedScenario('sc-1', 'Base', {
      accountFloors: { perAccount: { 'acc-hsa': { floorDollars: 8000 } } },
    });

    renderAt('sc-1');

    await screen.findByRole('grid', { name: 'Per-account minimum-balance floors' });
    const strict = await screen.findByRole('radio', { name: 'Strict' });
    await userEvent.click(strict);
    expect(
      await screen.findByRole('button', { name: 'Save' }),
    ).toBeInTheDocument();
  });

  it('renders no floor-ineffective warning under a named withdrawal strategy', async () => {
    await seedEligibilityFixture();
    await seedScenario('sc-1', 'Base', {
      withdrawalStrategy: { kind: 'taxEfficient' },
    });

    renderAt('sc-1');

    await screen.findByRole('grid', { name: 'Per-account minimum-balance floors' });
    expect(
      screen.queryByText(/Floors have no effect/i),
    ).not.toBeInTheDocument();
  });

  it('exposes the floor input to the keyboard (tab reaches the editable cell)', async () => {
    const user = userEvent.setup();
    await seedEligibilityFixture();
    await seedScenario('sc-1', 'Base', {
      accountFloors: { perAccount: { 'acc-bro': { floorDollars: 12000 } } },
    });

    renderAt('sc-1');

    const input = (await screen.findByLabelText(
      'My Brokerage minimum balance',
    )) as HTMLInputElement;
    await waitFor(() => expect(input).toBeInTheDocument());
    input.focus();
    expect(input).toHaveFocus();
    await user.keyboard('15000');
    expect(
      await screen.findByRole('button', { name: 'Save' }),
    ).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    await seedEligibilityFixture();
    await seedScenario('sc-1', 'Base', {
      accountFloors: { perAccount: { 'acc-hsa': { floorDollars: 8000 } } },
    });

    const { container } = renderAt('sc-1');
    await screen.findByRole('grid', { name: 'Per-account minimum-balance floors' });
    await expectNoA11yViolations(container);
  });

  describe('save', () => {
    it('saves a numeric floor on a POST_TAX account', async () => {
      await seedEligibilityFixture();
      await seedScenario('sc-1', 'Base');

      renderAt('sc-1');
      await screen.findByRole('grid', { name: 'Per-account minimum-balance floors' });

      // findBy: the grid resolving does not guarantee its rows are drawn.
      await userEvent.click(
        await screen.findByRole('button', {
          name: 'My Brokerage minimum balance — no floor (set one)',
        }),
      );
      const input = (await screen.findByLabelText(
        'My Brokerage minimum balance',
      )) as HTMLInputElement;
      act(() => {
        fireEvent.input(input, { target: { value: '50000' } });
      });

      const save = await screen.findByRole('button', { name: 'Save' });
      await act(async () => {
        fireEvent.click(save);
      });

      await waitFor(async () => {
        const saved = (await getAggregate('scenario', 'sc-1')) as
          | Aggregate<ScenarioPayload>
          | null;
        expect(
          saved?.payload.overrides.accountFloors?.perAccount['acc-bro']
            ?.floorDollars,
        ).toBe(50000);
      });
    });

    it('saves a null floor (clears an inherited floor)', async () => {
      await seedEligibilityFixture();
      // Clearing the child's floor must persist an explicit `null` (not an absent key) so the inherited floor is overridden off.
      await seedScenario('parent', 'Parent', {
        accountFloors: { perAccount: { 'acc-bro': { floorDollars: 30000 } } },
      });
      await seedScenario('sc-1', 'Child', {}, { parentScenarioId: 'parent' });

      renderAt('sc-1');
      await screen.findByRole('grid', { name: 'Per-account minimum-balance floors' });

      await screen.findByLabelText('My Brokerage minimum balance');
      await userEvent.click(
        screen.getByRole('button', { name: 'Clear My Brokerage minimum balance' }),
      );

      const save = await screen.findByRole('button', { name: 'Save' });
      await act(async () => {
        fireEvent.click(save);
      });

      await waitFor(async () => {
        const saved = (await getAggregate('scenario', 'sc-1')) as
          | Aggregate<ScenarioPayload>
          | null;
        const entry = saved?.payload.overrides.accountFloors?.perAccount['acc-bro'];
        expect(entry).toBeDefined();
        expect('floorDollars' in (entry ?? {})).toBe(true);
        expect(entry?.floorDollars).toBeNull();
      });
    });

    it('trims sparse — removes accountFloors when a row is set back to the inherited baseline', async () => {
      await seedEligibilityFixture();
      // Setting the child back to exactly the inherited value must drop the whole accountFloors key.
      await seedScenario('parent', 'Parent', {
        accountFloors: { perAccount: { 'acc-bro': { floorDollars: 30000 } } },
      });
      await seedScenario('sc-1', 'Child', {
        accountFloors: { perAccount: { 'acc-bro': { floorDollars: 50000 } } },
      }, { parentScenarioId: 'parent' });

      renderAt('sc-1');
      await screen.findByRole('grid', { name: 'Per-account minimum-balance floors' });

      const input = (await screen.findByLabelText(
        'My Brokerage minimum balance',
      )) as HTMLInputElement;
      act(() => {
        fireEvent.input(input, { target: { value: '30000' } });
      });

      const save = await screen.findByRole('button', { name: 'Save' });
      await act(async () => {
        fireEvent.click(save);
      });

      await waitFor(async () => {
        const saved = (await getAggregate('scenario', 'sc-1')) as
          | Aggregate<ScenarioPayload>
          | null;
        expect(saved?.payload.overrides.accountFloors).toBeUndefined();
      });
    });
  });

  it('Reset all removes the accountFloors override', async () => {
    await seedEligibilityFixture();
    await seedScenario('sc-1', 'Base', {
      accountFloors: { perAccount: { 'acc-bro': { floorDollars: 25000 } } },
    });

    renderAt('sc-1');
    await screen.findByRole('grid', { name: 'Per-account minimum-balance floors' });

    const resetAll = await screen.findByRole('button', {
      name: 'Reset all account floor overrides',
    });
    await act(async () => {
      fireEvent.click(resetAll);
    });

    await waitFor(async () => {
      const saved = (await getAggregate('scenario', 'sc-1')) as
        | Aggregate<ScenarioPayload>
        | null;
      expect(saved?.payload.overrides.accountFloors).toBeUndefined();
    });
  });

  it('shows the empty state when no eligible accounts exist', async () => {
    await seedMember('hm-1', 'Alex');
    await seedAccount('acc-401k', 'My 401k', 'RETIREMENT_401K', 'PRE_TAX');
    await seedAccount('acc-roth', 'My Roth IRA', 'RETIREMENT_ROTH_IRA', 'ROTH');
    await seedScenario('sc-1', 'Base');

    renderAt('sc-1');

    expect(
      await screen.findByText(/No eligible accounts\./i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('grid', { name: 'Per-account minimum-balance floors' }),
    ).toBeNull();
  });

  it('shows an error and an All-scenarios link when the scenario is not found', async () => {
    await seedEligibilityFixture();

    renderAt('nonexistent-id');

    expect(
      await screen.findByText(/Scenario nonexistent-id not found\./i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /All scenarios/i }),
    ).toBeInTheDocument();
  });

  it('disables the HSA mode radiogroup when no floor is set', async () => {
    await seedEligibilityFixture();
    await seedScenario('sc-1', 'Base');

    renderAt('sc-1');
    await screen.findByRole('grid', { name: 'Per-account minimum-balance floors' });

    const group = await screen.findByRole('radiogroup', {
      name: 'My HSA HSA floor mode',
    });
    for (const radio of within(group).getAllByRole('radio')) {
      expect(radio).toBeDisabled();
    }
  });

  it('inherits hsaMode from parent even when parent has no floorDollars (regression)', async () => {
    // The parent sets hsaMode:strict without floorDollars; `buildInheritedFloors` must walk the parent chain independently for hsaMode so the page shows 'strict', not the emergencyOnly default a naive resolver returns.
    await seedEligibilityFixture();
    await seedScenario('sc-parent', 'Base', {
      accountFloors: { perAccount: { 'acc-hsa': { hsaMode: 'strict' } } },
    });
    await seedScenario(
      'sc-child',
      'Child',
      { accountFloors: { perAccount: { 'acc-hsa': { floorDollars: 5000 } } } },
      { parentScenarioId: 'sc-parent', isPrimary: false },
    );

    renderAt('sc-child');
    await screen.findByRole('grid', { name: 'Per-account minimum-balance floors' });

    const strictRadio = await screen.findByRole('radio', { name: 'Strict' });
    expect(strictRadio).toBeChecked();
  });

  it('route /scenarios/:id/floors is registered in App.tsx and reachable', { timeout: 20_000 }, async () => {
    await seedEligibilityFixture();
    await seedScenario('sc-1', 'Base');

    renderApp('sc-1');

    // Re-query inside waitFor rather than asserting on a node captured by findBy: mounting the real `<App/>` resolves the lazy route and re-renders, so a captured node can be detached.
    // The generous timeout covers the cold route table and lazy-route resolve, which occasionally overran the 1 s default; a genuine route break still fails because the page never appears.
    await waitFor(
      () => {
        expect(
          screen.getByRole('heading', { name: /Account limits/i }),
        ).toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
  });
});
