import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunBalanceProjectionPageResult } from '../lib/balance-projection-runner';

// Mock the deterministic batch-load entry point so the reactive
// re-read tests can assert the BATCH LOAD re-ran (not just the inflated
// `listAggregates` total that every `useAggregates` subscription also
// bumps). The stub returns a fixed `pageResult` so each card resolves a
// known `endingBalance`, and the spy's call count is the re-run signal.
const PAGE_RESULT = {
  planned: { years: [{ year: 2027, balance: 200 }], atHorizonTodayDollars: 123 },
  twr: null,
  sharedCtx: {
    ctx: {
      asOfYear: 2026,
      asOfMonthIndex: 11,
      asOfMonth: 2026 * 12 + 11,
      firstProjectionMonth: 2026 * 12 + 11,
      primaryRetirementMonth: 2026 * 12 + 11,
      horizonMonth: 2027 * 12 + 11,
      inflationPct: 0,
    },
  },
} as unknown as RunBalanceProjectionPageResult;
const mockLoadPageData = vi.fn(() => ({ pageResult: PAGE_RESULT }));
vi.mock('./balance-projection-page-data', () => ({
  loadPageData: () => mockLoadPageData(),
}));

import {
  deriveScenarioDeterministicMetrics,
  useScenarioCardMetrics,
} from './scenarios-page-metrics';
import * as store from '../db/store';
import { clearAllStores, putAggregate } from '../db/store';
import { notifyWorkspaceChanged } from '../lib/workspace-events';
import type { Aggregate, AccountPayload } from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

const HH = 'hh-scenarios-metrics';

function scenarioAgg(id: string): ScenarioAggregate {
  return {
    id,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: id,
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {},
    },
  } as unknown as ScenarioAggregate;
}

function accountAgg(id: string): Aggregate<AccountPayload> {
  return {
    id,
    householdId: HH,
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'Brokerage',
      type: 'BROKERAGE',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'POST_TAX',
      ownerId: 'm1',
      institution: 'Vanguard',
      notes: '',
      planningReturnPct: 5,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}

describe('deriveScenarioDeterministicMetrics', () => {
  it('uses the runner at-horizon today-dollar value for the card metric', () => {
    const pageResult = {
      planned: {
        years: [{ year: 2027, balance: 200 }],
        atHorizonTodayDollars: 123,
      },
      sharedCtx: {
        ctx: {
          asOfYear: 2026,
          asOfMonthIndex: 11,
          asOfMonth: 2026 * 12 + 11,
          firstProjectionMonth: 2026 * 12 + 11,
          primaryRetirementMonth: 2026 * 12 + 11,
          horizonMonth: 2027 * 12 + 11,
          inflationPct: 100,
        },
      },
    } as unknown as RunBalanceProjectionPageResult;

    const result = deriveScenarioDeterministicMetrics(pageResult);

    expect(result.endingBalance).toBe(123);
    expect(result.series).toEqual([100]);
  });

  it('returns empty metrics when no planned drawdown exists', () => {
    expect(deriveScenarioDeterministicMetrics(null)).toEqual({
      endingBalance: null,
      series: [],
      historicalEndingBalance: null,
      historicalSeries: [],
    });
  });

  it('includes the TWR at-horizon and series when twr is populated', () => {
    const pageResult = {
      planned: {
        years: [{ year: 2027, balance: 200 }],
        atHorizonTodayDollars: 123,
      },
      twr: {
        years: [{ year: 2027, balance: 300 }],
        atHorizonTodayDollars: 456,
      },
      sharedCtx: {
        ctx: {
          asOfYear: 2026,
          asOfMonthIndex: 11,
          asOfMonth: 2026 * 12 + 11,
          firstProjectionMonth: 2026 * 12 + 11,
          primaryRetirementMonth: 2026 * 12 + 11,
          horizonMonth: 2027 * 12 + 11,
          inflationPct: 100,
        },
      },
    } as unknown as RunBalanceProjectionPageResult;

    const result = deriveScenarioDeterministicMetrics(pageResult);

    expect(result.historicalEndingBalance).toBe(456);
    // balance 300 at 2027 with inflationPct 100 deflates to today's dollars
    // by realDeflatorAt = 2^-1 = 0.5 → 150.
    expect(result.historicalSeries).toEqual([150]);
  });

  it('blanks the Historical value + series when twr is non-null but years is empty', () => {
    // The `horizon <= retirement` edge: twr is populated with a synthetic
    // at-horizon number but no per-year slice. Historical must blank the
    // value AND the sparkline together (mirrors the planned guard), rather
    // than showing a dollar value with no line.
    const pageResult = {
      planned: {
        years: [{ year: 2027, balance: 200 }],
        atHorizonTodayDollars: 123,
      },
      twr: {
        years: [],
        atHorizonTodayDollars: 456,
      },
      sharedCtx: {
        ctx: {
          asOfYear: 2026,
          asOfMonthIndex: 11,
          asOfMonth: 2026 * 12 + 11,
          firstProjectionMonth: 2026 * 12 + 11,
          primaryRetirementMonth: 2026 * 12 + 11,
          horizonMonth: 2027 * 12 + 11,
          inflationPct: 100,
        },
      },
    } as unknown as RunBalanceProjectionPageResult;

    const result = deriveScenarioDeterministicMetrics(pageResult);

    expect(result.historicalEndingBalance).toBeNull();
    expect(result.historicalSeries).toEqual([]);
  });

  it('returns historicalEndingBalance: null and historicalSeries: [] when twr is null', () => {
    const pageResult = {
      planned: {
        years: [{ year: 2027, balance: 200 }],
        atHorizonTodayDollars: 123,
      },
      twr: null,
      sharedCtx: {
        ctx: {
          asOfYear: 2026,
          asOfMonthIndex: 11,
          asOfMonth: 2026 * 12 + 11,
          firstProjectionMonth: 2026 * 12 + 11,
          primaryRetirementMonth: 2026 * 12 + 11,
          horizonMonth: 2027 * 12 + 11,
          inflationPct: 100,
        },
      },
    } as unknown as RunBalanceProjectionPageResult;

    const result = deriveScenarioDeterministicMetrics(pageResult);

    expect(result.historicalEndingBalance).toBeNull();
    expect(result.historicalSeries).toEqual([]);
  });

  it('returns historicalEndingBalance and historicalSeries even when planned is null', () => {
    const pageResult = {
      planned: null,
      twr: {
        years: [{ year: 2027, balance: 300 }],
        atHorizonTodayDollars: 456,
      },
      sharedCtx: {
        ctx: {
          asOfYear: 2026,
          asOfMonthIndex: 11,
          asOfMonth: 2026 * 12 + 11,
          firstProjectionMonth: 2026 * 12 + 11,
          primaryRetirementMonth: 2026 * 12 + 11,
          horizonMonth: 2027 * 12 + 11,
          inflationPct: 100,
        },
      },
    } as unknown as RunBalanceProjectionPageResult;

    const result = deriveScenarioDeterministicMetrics(pageResult);
    expect(result.endingBalance).toBeNull();
    expect(result.series).toEqual([]);
    expect(result.historicalEndingBalance).toBe(456);
    expect(result.historicalSeries).toHaveLength(1);
  });
});

describe('useScenarioCardMetrics reactive re-read (revision-signal substitution)', () => {
  // The hook keeps its imperative `loadProjectionInputs` batch load and uses
  // `useAggregates` over the 7 projection-input stores purely as a revision
  // signal. These tests prove a mid-session write to a NON-scenario subscribed
  // store re-runs the batch load — the channel the scenario-prop `signature`
  // dep does NOT cover — on both the per-store fine signal and the coarse
  // `WORKSPACE_CHANGED_EVENT`. Render with an empty scenarios array so the
  // CPU-bound deterministic engine never runs; the re-read itself is the
  // observable (spied on `listAggregates`).
  afterEach(async () => {
    mockLoadPageData.mockClear();
    vi.restoreAllMocks();
    await clearAllStores();
  });

  it('re-reads on a fine store signal alone (putAggregate account, no coarse event)', async () => {
    await clearAllStores();
    mockLoadPageData.mockClear();

    // Render with ONE scenario so the deterministic batch load + per-scenario
    // `loadPageData` actually run and the hook resolves a real metric. The
    // `loadPageData` spy count (not the `listAggregates` total, which every
    // `useAggregates` subscription also bumps) is the batch-load re-run signal.
    const { result } = renderHook(() =>
      useScenarioCardMetrics([scenarioAgg('sc-1')]),
    );
    // Mount pass: batch-load runs once and the card resolves its metric.
    await waitFor(() =>
      expect(result.current.metrics.get('sc-1')?.endingBalance).toBe(123),
    );
    const afterMount = mockLoadPageData.mock.calls.length;
    expect(afterMount).toBeGreaterThan(0);

    // A single `account` write fires ONLY that store's fine signal — no
    // notifyWorkspaceChanged(). The hook's `useAggregates('account')` revision
    // dep must wake the batch load again: the metric clears to pending then
    // re-resolves, AND `loadPageData` is called an additional time.
    await act(async () => {
      await putAggregate('account', accountAgg('a-1'));
    });

    await waitFor(() =>
      expect(mockLoadPageData.mock.calls.length).toBeGreaterThan(afterMount),
    );
    await waitFor(() =>
      expect(result.current.metrics.get('sc-1')?.endingBalance).toBe(123),
    );
  });

  it('re-reads on the coarse WORKSPACE_CHANGED_EVENT (bulk-fill path)', async () => {
    await clearAllStores();
    mockLoadPageData.mockClear();

    const { result } = renderHook(() =>
      useScenarioCardMetrics([scenarioAgg('sc-1')]),
    );
    await waitFor(() =>
      expect(result.current.metrics.get('sc-1')?.endingBalance).toBe(123),
    );
    const afterMount = mockLoadPageData.mock.calls.length;
    expect(afterMount).toBeGreaterThan(0);

    // A bulk fill writes through the raw IDB handle (no fine put-signal) then
    // dispatches the coarse event; the hook re-runs the batch load off that
    // channel alone.
    const handle = await store.db();
    await handle.put('accounts', accountAgg('a-1'));
    act(() => {
      notifyWorkspaceChanged();
    });

    await waitFor(() =>
      expect(mockLoadPageData.mock.calls.length).toBeGreaterThan(afterMount),
    );
    await waitFor(() =>
      expect(result.current.metrics.get('sc-1')?.endingBalance).toBe(123),
    );
  });

  it('does NOT clear + re-drip on a no-op re-read (same ids/versions)', async () => {
    await clearAllStores();
    mockLoadPageData.mockClear();

    // Seed one account through the raw IDB handle (no fine put-signal) so the
    // mount batch carries a real row whose id+version the signature captures,
    // without minting an extra revision settle before render.
    const seedHandle = await store.db();
    await seedHandle.put('accounts', accountAgg('a-1'));

    const { result } = renderHook(() =>
      useScenarioCardMetrics([scenarioAgg('sc-1')]),
    );
    await waitFor(() =>
      expect(result.current.metrics.get('sc-1')?.endingBalance).toBe(123),
    );
    const afterMount = mockLoadPageData.mock.calls.length;
    expect(afterMount).toBeGreaterThan(0);
    const mountedMetrics = result.current.metrics;

    // Fire the coarse channel WITHOUT changing any data. The batch re-read
    // runs but its content signature is unchanged, so the guard must skip the
    // card-clearing re-drip: `loadPageData` count stays flat and the metrics
    // map is never reset to placeholders.
    act(() => {
      notifyWorkspaceChanged();
    });
    // Give the async re-read (IDB batch load) + any drip a real window to
    // settle so a regression (clear + re-drip) would be observable here.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });

    expect(mockLoadPageData.mock.calls.length).toBe(afterMount);
    expect(result.current.metrics.get('sc-1')?.endingBalance).toBe(123);
    // The map reference is untouched — no `setMetrics(new Map())` ran.
    expect(result.current.metrics).toBe(mountedMetrics);
  });
});
