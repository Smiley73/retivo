// ScenariosPage tree rows: the description sub-line, the removed override-count line and the NotesIndicator (an `<svg role="img" aria-label="Notes">`, the assertion target), plus Monte Carlo recalc wiring.
import 'fake-indexeddb/auto';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  clearSelectedScenario,
  putAggregate,
  readSelectedScenario,
  writeSelectedScenario,
} from '../db/store';
import * as store from '../db/store';
import { clearMonteCarloCache } from '../db/monte-carlo-cache';
import { SELECTED_SCENARIO_CHANGED_EVENT } from '../lib/scenario-mutations';
import type { Aggregate, ScenarioPayload } from '../db/types';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

// Shared mock state via `vi.hoisted` so the hoisted `vi.mock` factories can close over it.
const mocks = vi.hoisted(() => ({
  runCalls: [] as Array<{ pathCount: number }>,
  cancel: () => {},
  // An optional gate holds a per-card `runToCompletion` open to observe the mutual-exclusion guard.
  gateRunToCompletion: null as null | (() => Promise<void>),
  // The param is referenced via `void` to satisfy no-unused-vars, which doesn't honour the `_` prefix here.
  inputForScenario: (
    scenarioId: string,
  ): import('../lib/monte-carlo').MonteCarloInput | null => {
    void scenarioId;
    return null;
  },
  summary: (engineVersion: number): import('../lib/monte-carlo').MonteCarloSummary => ({
    engineVersion,
    seed: 1,
    pathCount: 10_000,
    computedAt: 0,
    firstYear: 2026,
    horizonYears: 1,
    percentilesNominal: { p10: [1], p25: [2], p50: [3] },
    percentilesReal: { p10: [1], p25: [2], p50: [3] },
    successProbability: 0.9,
    medianDepletionYear: null,
    p10DepletionYear: null,
    p25DepletionYear: null,
    medianEndingBalanceNominal: 100,
    medianEndingBalanceReal: 100,
    p10EndingBalanceNominal: 50,
    p10EndingBalanceReal: 50,
    p25EndingBalanceNominal: 70,
    p25EndingBalanceReal: 70,
    failureYearHistogram: [],
    endingBalanceHistogramNominal: [],
    endingBalanceHistogramReal: [],
    plannedOverlay: [],
  }),
}));

// Stub the provider hook used for the per-card recalc; the fake `runToCompletion` records its calls and writes the requested input into the real cache so `refreshPlanSuccess` re-reads a hit.
vi.mock('../monte-carlo/MonteCarloProvider', () => ({
  useMonteCarlo: () => ({
    status: 'idle' as const,
    progressDone: 0,
    progressTotal: 0,
    result: null,
    error: null,
    run: () => Promise.resolve(),
    runToCompletion: async (
      input: import('../lib/monte-carlo').MonteCarloInput,
    ) => {
      mocks.runCalls.push({ pathCount: input.pathCount });
      if (mocks.gateRunToCompletion) await mocks.gateRunToCompletion();
      const { mcCacheKey, putCached } = await import('../db/monte-carlo-cache');
      const { ENGINE_VERSION } = await import('../lib/monte-carlo');
      const key = await mcCacheKey(input);
      const summary = mocks.summary(ENGINE_VERSION);
      await putCached(key, summary);
      return summary;
    },
    cancel: () => mocks.cancel(),
    setResult: () => {},
  }),
}));

// Stub the bulk-recompute pool hook behind "Recalculate all": the fake `recalcAll` records calls, patches the card from an in-hand summary via the page's `onResult` and write-caches it, mirroring the real hook without a worker. Mutual exclusion with a per-card recalc is enforced by the page, not the hook.
vi.mock('../monte-carlo/use-scenario-bulk-recompute', () => ({
  useScenarioBulkRecompute: (args: {
    buildMcInput: (id: string) => import('../lib/monte-carlo').MonteCarloInput | null;
    onResult: (id: string, summary: import('../lib/monte-carlo').MonteCarloSummary) => void;
  }) => ({
    coarse: null,
    progressById: new Map(),
    isRunning: false,
    recalcAll: (scenarioIds: ReadonlyArray<string>) => {
      void (async () => {
        const { mcCacheKey, putCached } = await import('../db/monte-carlo-cache');
        const { ENGINE_VERSION } = await import('../lib/monte-carlo');
        for (const id of scenarioIds) {
          const input = args.buildMcInput(id);
          if (!input) continue;
          mocks.runCalls.push({ pathCount: input.pathCount });
          const summary = mocks.summary(ENGINE_VERSION);
          args.onResult(id, summary);
          const key = await mcCacheKey(input);
          await putCached(key, summary);
        }
      })();
    },
    cancel: () => mocks.cancel(),
  }),
}));

// A deterministic, runnable `MonteCarloInput` per scenario so the cache-read and recompute path exercises real code; parity with the BPP page is structural (shared helper and MC_PATH_COUNT).
vi.mock('../lib/monte-carlo-scenario-input', async (orig) => {
  const actual = await orig<typeof import('../lib/monte-carlo-scenario-input')>();
  return {
    ...actual,
    buildMonteCarloInputForScenario: (opts: { scenarioId: string }) =>
      mocks.inputForScenario(opts.scenarioId),
  };
});

import { ENGINE_VERSION, type MonteCarloSummary } from '../lib/monte-carlo';
import { MC_PATH_COUNT } from '../lib/monte-carlo-scenario-input';
import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { ScenariosPage } from './ScenariosPage';

const HH = 'hh-test';

function fakeMcInput(scenarioId: string): import('../lib/monte-carlo').MonteCarloInput {
  return {
    portfolioToday: 100_000,
    accountMcLedger: [{ id: scenarioId } as never],
    annualContribution: 0,
    firstYear: 2026,
    retirementYear: 2046,
    horizonYear: 2086,
    monthlyExpenseBase: [],
    ssByYear: [0],
    incomeByYear: [0],
    pathCount: MC_PATH_COUNT,
    seed: 1,
    strategyKind: 'taxEfficient',
    events: [],
  };
}

function makeSummary(): MonteCarloSummary {
  return mocks.summary(ENGINE_VERSION);
}

function setupContexts(): void {
  // Default: no MC for any scenario, so plan-success shows "—" with no recalc control; MC tests override this.
  mocks.inputForScenario = () => null;
  mocks.gateRunToCompletion = null;
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

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <ScenariosPage />
    </MemoryRouter>,
  );
}

interface SeedScenarioOptions {
  id: string;
  name: string;
  isPrimary: boolean;
  parentScenarioId: string | null;
  description?: string;
  notes?: string;
  overrideKeys?: Array<keyof ScenarioPayload['overrides']>;
}

async function seedScenario(opts: SeedScenarioOptions): Promise<void> {
  const overrides: ScenarioPayload['overrides'] = {};
  for (const key of opts.overrideKeys ?? []) {
    if (key === 'socialSecurity') {
      overrides.socialSecurity = {
        primary: { ageYears: 67, ageMonths: 0 },
        benefitReductionPct: 0,
        colaPct: 2,
      };
    } else if (key === 'inflation') {
      overrides.inflation = { ratePct: 3 };
    } else if (key === 'discretionarySpending') {
      overrides.discretionarySpending = { bumpPct: 10, durationYears: null };
    } else {
      overrides[key] = {} as never;
    }
  }
  const s: Aggregate<ScenarioPayload> = {
    id: opts.id,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: opts.name,
      description: opts.description ?? '',
      parentScenarioId: opts.parentScenarioId,
      isPrimary: opts.isPrimary,
      notes: opts.notes ?? '',
      overrides,
    },
  };
  await putAggregate('scenario', s);
}

describe('ScenariosPage — row description / override-count / notes', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    // clearAllStores preserves the selectedScenario pointer (production keeps it across a force-bootstrap), so reset it too or an activate in one test leaks the active scenario into the next.
    await clearSelectedScenario();
    await clearMonteCarloCache();
    mocks.runCalls.length = 0;
    vi.clearAllMocks();
  });

  it('non-base scenario with description + notes → description sub-line + NotesIndicator (no override-count line)', async () => {
    await seedScenario({
      id: 'sc-base',
      name: 'Base',
      isPrimary: true,
      parentScenarioId: null,
    });
    await seedScenario({
      id: 'sc-both',
      name: 'Aggressive',
      isPrimary: false,
      parentScenarioId: 'sc-base',
      description: 'Aggressive return assumptions',
      notes: 'Modeled after 1990s bull run',
      overrideKeys: ['socialSecurity', 'inflation'],
    });
    renderPage();
    const row = (await screen.findByText('Aggressive')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).getByText('Aggressive return assumptions')).toBeInTheDocument();
    // The override-count sub-line was removed from the cards.
    expect(within(row).queryByText(/override/i)).toBeNull();
    expect(within(row).getByRole('img', { name: 'Notes' })).toBeInTheDocument();
  });

  it('non-base scenario with description only → description sub-line, no override-count line', async () => {
    await seedScenario({
      id: 'sc-base',
      name: 'Base',
      isPrimary: true,
      parentScenarioId: null,
    });
    await seedScenario({
      id: 'sc-desc',
      name: 'Conservative',
      isPrimary: false,
      parentScenarioId: 'sc-base',
      description: 'Lower returns, claim SS at 70',
    });
    renderPage();
    const row = (await screen.findByText('Conservative')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    expect(row).not.toBeNull();
    expect(
      within(row).getByText('Lower returns, claim SS at 70'),
    ).toBeInTheDocument();
    expect(within(row).queryByText(/override/i)).toBeNull();
    expect(within(row).queryByRole('img', { name: 'Notes' })).toBeNull();
  });

  it('non-base scenario with overrides but no description/notes → no override-count line, no sub-lines', async () => {
    await seedScenario({
      id: 'sc-base',
      name: 'Base',
      isPrimary: true,
      parentScenarioId: null,
    });
    await seedScenario({
      id: 'sc-overrides',
      name: 'Inflation hedge',
      isPrimary: false,
      parentScenarioId: 'sc-base',
      overrideKeys: ['inflation'],
    });
    renderPage();
    const row = (await screen.findByText('Inflation hedge')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).queryByText(/override/i)).toBeNull();
    expect(within(row).queryByRole('img', { name: 'Notes' })).toBeNull();
  });

  it('base scenario with no description and no notes → no extra sub-line, no notes indicator', async () => {
    await seedScenario({
      id: 'sc-base',
      name: 'Base',
      isPrimary: true,
      parentScenarioId: null,
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Base')).toBeInTheDocument());
    const row = screen.getByText('Base').closest('.scenario-tree__row') as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).queryByText(/override/i)).toBeNull();
    expect(within(row).queryByRole('img', { name: 'Notes' })).toBeNull();
  });

  it('base scenario with notes set still surfaces the NotesIndicator', async () => {
    await seedScenario({
      id: 'sc-base',
      name: 'Base',
      isPrimary: true,
      parentScenarioId: null,
      notes: 'Starting assumptions reviewed 2026-Q1',
    });
    renderPage();
    const row = (await screen.findByText('Base')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).getByRole('img', { name: 'Notes' })).toBeInTheDocument();
    expect(within(row).queryByText(/override/i)).toBeNull();
  });

  it('Create modal parent-picker renders a 3-level Base→A→B chain with depth classes', async () => {
    const user = userEvent.setup();
    await seedScenario({ id: 'base', name: 'Base', isPrimary: true, parentScenarioId: null });
    await seedScenario({ id: 'a', name: 'A', isPrimary: false, parentScenarioId: 'base' });
    await seedScenario({ id: 'b', name: 'B', isPrimary: false, parentScenarioId: 'a' });
    renderPage();
    await screen.findByText('Base');
    const createBtn = screen.getByRole('button', { name: /Create scenario/ });
    await user.click(createBtn);
    const parentBtn = await screen.findByRole('button', { name: /Parent scenario/ });
    await user.click(parentBtn);
    const rows = await screen.findAllByRole('option');
    // Tree order: Base at depth 0 gets pl-2, A at depth 1 pl-6, B at depth 2 pl-10.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]).toHaveClass('pl-2');  // Base at depth 0
    expect(rows[1]).toHaveClass('pl-6');  // A at depth 1
    expect(rows[2]).toHaveClass('pl-10'); // B at depth 2
  });
});

describe('ScenariosPage — Graphite Spectrum card (chip + actions + metrics)', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    // clearAllStores preserves the selectedScenario pointer, so reset it too.
    await clearSelectedScenario();
    await clearMonteCarloCache();
    mocks.runCalls.length = 0;
    vi.clearAllMocks();
  });

  it('shows the Active chip + the icon-action cluster per card, with the active/base affordances hidden', async () => {
    await seedScenario({
      id: 'sc-base',
      name: 'Base',
      isPrimary: true,
      parentScenarioId: null,
    });
    await seedScenario({
      id: 'sc-child',
      name: 'Retire at 67',
      isPrimary: false,
      parentScenarioId: 'sc-base',
    });
    renderPage();

    // The active-scenario highlight resolves from an async pointer read, so poll for the chip rather than asserting on the first paint.
    const baseRow = (await screen.findByText('Base')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    await waitFor(() =>
      expect(within(baseRow).getByText('Active')).toBeInTheDocument(),
    );
    expect(within(baseRow).getByRole('button', { name: 'Edit Base' })).toBeInTheDocument();
    expect(within(baseRow).queryByRole('button', { name: 'Delete Base' })).toBeNull();

    const childRow = (await screen.findByText('Retire at 67')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    expect(within(childRow).queryByText('Active')).toBeNull();
    expect(
      within(childRow).getByRole('button', { name: 'Edit Retire at 67' }),
    ).toBeInTheDocument();
    expect(
      within(childRow).getByRole('button', { name: 'Delete Retire at 67' }),
    ).toBeInTheDocument();
  });

  it('renders the Planned metric block with a placeholder when no projection resolves', async () => {
    // With no members or accounts the deterministic projection can't build a primary-retirement context, so the lazy metric resolves to "—" rather than a fabricated number.
    await seedScenario({
      id: 'sc-base',
      name: 'Base',
      isPrimary: true,
      parentScenarioId: null,
    });
    renderPage();
    const baseRow = (await screen.findByText('Base')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    expect(within(baseRow).getByText('Planned')).toBeInTheDocument();
  });

  it('Delete confirms then removes the scenario via the cascade flow', async () => {
    const user = userEvent.setup();
    await seedScenario({
      id: 'sc-base',
      name: 'Base',
      isPrimary: true,
      parentScenarioId: null,
    });
    await seedScenario({
      id: 'sc-child',
      name: 'Retire at 67',
      isPrimary: false,
      parentScenarioId: 'sc-base',
    });
    renderPage();

    const deleteBtn = await screen.findByRole('button', {
      name: 'Delete Retire at 67',
    });
    await user.click(deleteBtn);

    const confirmBtn = await screen.findByRole('button', { name: 'Delete' });
    await user.click(confirmBtn);

    await waitFor(() =>
      expect(screen.queryByText('Retire at 67')).toBeNull(),
    );
  });
});

describe('ScenariosPage — Monte Carlo plan success (cache-read + recompute)', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    await clearSelectedScenario();
    await clearMonteCarloCache();
    mocks.runCalls.length = 0;
    vi.clearAllMocks();
  });

  it('renders the MC metric labels on every card', async () => {
    await seedScenario({ id: 'sc-base', name: 'Base', isPrimary: true, parentScenarioId: null });
    renderPage();
    const baseRow = (await screen.findByText('Base')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    expect(within(baseRow).getByText('Typical')).toBeInTheDocument();
    expect(within(baseRow).getByText('Pessimistic')).toBeInTheDocument();
    expect(within(baseRow).getByText('Plan success')).toBeInTheDocument();
  });

  it('renders the Historical metric label on every card', async () => {
    await seedScenario({
      id: 'sc-base',
      name: 'Base',
      isPrimary: true,
      parentScenarioId: null,
    });
    renderPage();
    const baseRow = (await screen.findByText('Base')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    expect(within(baseRow).getByText('Historical')).toBeInTheDocument();
  });

  it('shows cached MC metrics on a cache hit (read-only, no worker run)', async () => {
    // Seed the cache entry under the same key the page derives (input minus seed/onProgress, via computeCacheKey).
    mocks.inputForScenario = (id: string) => fakeMcInput(id);
    const { computeCacheKey, putCached } = await import('../db/monte-carlo-cache');
    const key = await computeCacheKey({
      ...fakeMcInput('sc-base'),
      onProgress: undefined,
      seed: undefined,
    });
    await putCached(key, makeSummary()); // successProbability 0.9 → 90%

    await seedScenario({ id: 'sc-base', name: 'Base', isPrimary: true, parentScenarioId: null });
    renderPage();
    const baseRow = (await screen.findByText('Base')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    await waitFor(() =>
      expect(within(baseRow).getByText('90%')).toBeInTheDocument(),
    );
    expect(within(baseRow).getByText('$100')).toBeInTheDocument();
    expect(within(baseRow).getByText('$70')).toBeInTheDocument();
    expect(
      within(baseRow).queryByRole('button', { name: /Recalculate plan success/ }),
    ).toBeNull();
    expect(mocks.runCalls).toHaveLength(0);
  });

  it('on a cache miss shows "—" plus a per-card Recalculate that runs MC then fills the percent', async () => {
    mocks.inputForScenario = (id: string) => fakeMcInput(id);
    const user = userEvent.setup();
    await seedScenario({ id: 'sc-base', name: 'Base', isPrimary: true, parentScenarioId: null });
    renderPage();
    const baseRow = (await screen.findByText('Base')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    const recalcBtn = await within(baseRow).findByRole('button', {
      name: 'Recalculate plan success for Base',
    });
    await user.click(recalcBtn);
    await waitFor(() => expect(mocks.runCalls).toHaveLength(1));
    expect(mocks.runCalls[0].pathCount).toBe(MC_PATH_COUNT);
    await waitFor(() =>
      expect(within(baseRow).getByText('90%')).toBeInTheDocument(),
    );
    expect(within(baseRow).getByText('$100')).toBeInTheDocument();
    expect(within(baseRow).getByText('$70')).toBeInTheDocument();
  });

  it('Recalculate all runs every runnable scenario through the pool then fills each card', async () => {
    mocks.inputForScenario = (id: string) => fakeMcInput(id);
    const user = userEvent.setup();
    await seedScenario({ id: 'sc-base', name: 'Base', isPrimary: true, parentScenarioId: null });
    await seedScenario({
      id: 'sc-child',
      name: 'Retire at 67',
      isPrimary: false,
      parentScenarioId: 'sc-base',
    });
    renderPage();
    await screen.findByText('Base');
    // Wait for the child row too: clicking before it loads runs only the scenarios present at click time, so the pool would see one run, not two.
    await screen.findByText('Retire at 67');

    const recalcAll = await screen.findByRole('button', {
      name: 'Recalculate plan success for all scenarios',
    });
    await user.click(recalcAll);

    await waitFor(() => expect(mocks.runCalls).toHaveLength(2));
    const baseRow = (await screen.findByText('Base')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    const childRow = (await screen.findByText('Retire at 67')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    await waitFor(() => {
      expect(within(baseRow).getByText('90%')).toBeInTheDocument();
      expect(within(childRow).getByText('90%')).toBeInTheDocument();
    });
    expect(within(baseRow).getByText('$100')).toBeInTheDocument();
    expect(within(baseRow).getByText('$70')).toBeInTheDocument();
    expect(within(childRow).getByText('$100')).toBeInTheDocument();
    expect(within(childRow).getByText('$70')).toBeInTheDocument();
  });

  it('disables Recalculate all while a per-card recalc is in flight (mutual exclusion)', async () => {
    // The page sets `activeRecalcId` for the duration of a per-card `runToCompletion`, and "Recalculate all" is disabled while it is non-null, so a per-card and a bulk run never contend. Gate the provider's run open to hold the per-card recalc in flight.
    mocks.inputForScenario = (id: string) => fakeMcInput(id);
    let releaseRun!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    mocks.gateRunToCompletion = () => gate;
    const user = userEvent.setup();
    await seedScenario({ id: 'sc-base', name: 'Base', isPrimary: true, parentScenarioId: null });
    renderPage();
    await screen.findByText('Base');

    const baseRow = (await screen.findByText('Base')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    const cardBtn = await within(baseRow).findByRole('button', {
      name: 'Recalculate plan success for Base',
    });
    const recalcAll = screen.getByRole('button', {
      name: 'Recalculate plan success for all scenarios',
    });
    expect(recalcAll).not.toBeDisabled();

    await user.click(cardBtn);
    await waitFor(() => expect(recalcAll).toBeDisabled());

    releaseRun();
    await waitFor(() => expect(recalcAll).not.toBeDisabled());
  });
});

describe('ScenariosPage — reactive reads', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    await clearSelectedScenario();
    await clearMonteCarloCache();
    mocks.runCalls.length = 0;
    vi.clearAllMocks();
  });

  it('re-derives on a fine store signal alone (putAggregate, no coarse event)', async () => {
    renderPage();
    expect(
      await screen.findByText(/No base scenario found/i),
    ).toBeInTheDocument();

    // A single-row scenario write fires only the per-store signal, no notifyWorkspaceChanged(); the useAggregates subscription must still wake.
    await act(async () => {
      await seedScenario({
        id: 'sc-base',
        name: 'Base',
        isPrimary: true,
        parentScenarioId: null,
      });
    });

    await waitFor(() => expect(screen.getByText('Base')).toBeInTheDocument());
  });

  it('moves the Active highlight on SELECTED_SCENARIO_CHANGED_EVENT', async () => {
    await seedScenario({
      id: 'sc-base',
      name: 'Base',
      isPrimary: true,
      parentScenarioId: null,
    });
    await seedScenario({
      id: 'sc-child',
      name: 'Retire at 67',
      isPrimary: false,
      parentScenarioId: 'sc-base',
    });
    renderPage();

    const baseRow = (await screen.findByText('Base')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    await waitFor(() =>
      expect(within(baseRow).getByText('Active')).toBeInTheDocument(),
    );

    // The sidebar writes the local pointer and dispatches SELECTED_SCENARIO_CHANGED_EVENT; the page re-reads it via useSelectedScenarioRevision and moves the highlight.
    await writeSelectedScenario({
      scenarioId: 'sc-child',
      updatedAt: new Date().toISOString(),
    });
    await act(async () => {
      window.dispatchEvent(new Event(SELECTED_SCENARIO_CHANGED_EVENT));
    });

    const childRow = (await screen.findByText('Retire at 67')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    await waitFor(() =>
      expect(within(childRow).getByText('Active')).toBeInTheDocument(),
    );
    expect(within(baseRow).queryByText('Active')).toBeNull();
  });
});

describe('ScenariosPage — Compare with parent', () => {
  let lastLocation = '';
  const LocationProbe: React.FC = () => {
    const loc = useLocation();
    lastLocation = loc.pathname + loc.search;
    return null;
  };

  function renderWithRoutes(): ReturnType<typeof render> {
    return render(
      <MemoryRouter initialEntries={['/scenarios']}>
        <LocationProbe />
        <Routes>
          <Route path="/scenarios" element={<ScenariosPage />} />
          <Route path="/balance-projection" element={<div>projection page</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  async function seedPair(): Promise<void> {
    await seedScenario({ id: 'sc-base', name: 'Base', isPrimary: true, parentScenarioId: null });
    await seedScenario({
      id: 'sc-child',
      name: 'Retire at 67',
      isPrimary: false,
      parentScenarioId: 'sc-base',
    });
  }

  const childLink = (): Promise<HTMLElement> =>
    screen.findByRole('button', { name: 'Compare with parent: Retire at 67 with Base' });

  beforeEach(() => {
    setupContexts();
    lastLocation = '';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearAllStores();
    await clearSelectedScenario();
    await clearMonteCarloCache();
    mocks.runCalls.length = 0;
    vi.clearAllMocks();
  });

  it('switches the active scenario then opens the Compare tab against the parent', async () => {
    await seedPair();
    const user = userEvent.setup();
    renderWithRoutes();

    const link = await childLink();
    expect(link).toHaveTextContent('Compare with parent');
    await user.click(link);

    await screen.findByText('projection page');
    expect(lastLocation).toBe('/balance-projection?view=compare&with=sc-base');
    expect((await readSelectedScenario())?.scenarioId).toBe('sc-child');
  });

  it('moves the Active chip to the card (the changed event fires)', async () => {
    await seedPair();
    const user = userEvent.setup();
    // No <Routes>: the page stays mounted through the navigation, so the chip can only move through the changed event.
    renderPage();
    await user.click(await childLink());
    const childRow = (await screen.findByText('Retire at 67')).closest(
      '.scenario-tree__row',
    ) as HTMLElement;
    await waitFor(() =>
      expect(within(childRow).getByText('Active')).toBeInTheDocument(),
    );
  });

  it('does not navigate until the pointer write has resolved', async () => {
    await seedPair();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realWrite = store.writeSelectedScenario;
    const spy = vi
      .spyOn(store, 'writeSelectedScenario')
      .mockImplementation(async (selected) => {
        await gate;
        await realWrite(selected);
      });
    const user = userEvent.setup();
    renderWithRoutes();

    await user.click(await childLink());
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(lastLocation).toBe('/scenarios');
    expect(screen.queryByText('projection page')).toBeNull();

    await act(async () => {
      release();
    });
    await screen.findByText('projection page');
    expect(lastLocation).toBe('/balance-projection?view=compare&with=sc-base');
  });

  it('stays put and shows the error when the pointer write rejects', async () => {
    await seedPair();
    vi.spyOn(store, 'writeSelectedScenario').mockRejectedValue(new Error('IDB is down'));
    const user = userEvent.setup();
    renderWithRoutes();

    await user.click(await childLink());

    expect(await screen.findByText('IDB is down')).toBeInTheDocument();
    expect(lastLocation).toBe('/scenarios');
    expect(screen.queryByText('projection page')).toBeNull();
  });

  it('renders no control on Base or on a card whose parent is missing', async () => {
    await seedScenario({ id: 'sc-base', name: 'Base', isPrimary: true, parentScenarioId: null });
    await seedScenario({
      id: 'sc-orphan',
      name: 'Orphan',
      isPrimary: false,
      parentScenarioId: 'sc-gone',
    });
    renderWithRoutes();

    await screen.findByText('Base');
    expect(screen.queryByText('Compare with parent')).toBeNull();
    expect(screen.queryByRole('button', { name: /Compare with parent/ })).toBeNull();
  });
});
