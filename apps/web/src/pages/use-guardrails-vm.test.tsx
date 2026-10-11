/**
 * Tests for `useGuardrailsVm`.
 *
 * Covers the funded-ratio wiring off the engine baseline series, the
 * month-precise not-yet-retired scoping, the pre-gate crash guard,
 * the absent-guardrail-fields guard, and the bounded "Check now" MC
 * lifecycle + PoS-temper.
 *
 * The pipeline helpers are mocked so the hook's own orchestration is asserted
 * in isolation; `fundedRatio` (lib/guardrails.ts) stays REAL so the ratio is a
 * true hand-checkable value.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useGuardrailsVm,
  GUARDRAILS_LIVE_MC_TIMEOUT_MS,
  type GuardrailsVm,
} from './use-guardrails-vm';
import { GUARDRAILS_LIVE_MC_SEED } from '../lib/balance-projection-runner-mc';
import { fundedRatio } from '../lib/guardrails';

/** Call `checkNow` off a fresh `result.current` read (narrowing survives the
 *  helper's own scope, unlike an inline closure read). */
function clickCheckNow(vm: GuardrailsVm): void {
  if (vm.status === 'ready') vm.checkNow();
}

// --- Mocks -----------------------------------------------------------------

let mockData: {
  ready: boolean;
  selectedScenarioId: string | null;
  scenarios: Array<{ id: string; payload: { name: string } }>;
  members: Array<{ id: string; payload: { isPrimary: boolean; birthdate: string } }>;
  accounts: Array<{ id: string; payload: { active: boolean; currentBalance?: number } }>;
  balances: unknown[];
  expenses: unknown[];
  expenseCategories: unknown[];
  incomeStreams: unknown[];
  ssBenefits: unknown[];
  error: string | null;
};
vi.mock('./use-balance-projection-data', () => ({
  useBalanceProjectionData: () => mockData,
}));

let mockResolveScenario: () => { retirementAge?: unknown };
const resolveScenarioMock: Mock = vi.fn(() => mockResolveScenario());
let mockResolvedGuardrails: unknown = undefined;
vi.mock('../lib/scenario-resolution', () => ({
  resolveScenario: () => resolveScenarioMock(),
  resolveDownturnGuardrailsForScenario: () => mockResolvedGuardrails,
}));

let mockRetirementIso: string | null = '2020-01-01';
vi.mock('../lib/retirement-date-math', () => ({
  resolveMemberRetirementDates: () => new Map([['m1', mockRetirementIso]]),
}));

// Sums a test-only `currentBalance` over whatever accounts the hook passes, so a
// test can assert the numerator reflects exactly the accounts the hook selected
// (active-only).
vi.mock('../lib/balance-calc', () => ({
  computePortfolioSummary: (
    accounts: Array<{ account: { payload: { currentBalance?: number } } }>,
  ) => ({
    summary: {
      totalCurrentBalance: accounts.reduce(
        (sum, { account }) => sum + (account.payload.currentBalance ?? 0),
        0,
      ),
    },
  }),
}));

// call(1) (override present) returns the funded-ratio baseline fields; call(2)
// (no override) returns the REAL-config input the PoS run consumes.
let mockNetNeed: number[] | undefined = [909_091];
let mockTaxRate: number | undefined = 0;
const buildMcMock: Mock = vi.fn(
  (opts: { guardrailOverrideConfig?: unknown }) => {
    if (opts.guardrailOverrideConfig) {
      return {
        __call: 1,
        downturnGuardrails: { enabled: true },
        guardrailBaselineRealNetNeedByYear: mockNetNeed,
        guardrailEffectiveTaxRate: mockTaxRate,
      };
    }
    return { __call: 2, downturnGuardrails: { enabled: false }, seed: 999, pathCount: 10_000 };
  },
);
vi.mock('../lib/monte-carlo-scenario-input', () => ({
  buildMonteCarloInputForScenario: (opts: unknown) => buildMcMock(opts),
}));

interface MockPool {
  run: Mock;
  dispose: Mock;
  size: number;
  signal?: AbortSignal;
  /** The `onProgress` callback passed to the most recent `run()` call, so a
   *  test can simulate the worker's `{ kind: 'progress' }` messages. */
  lastOnProgress: ((done: number, total: number) => void) | undefined;
}
const createdPools: MockPool[] = [];
let nextPoolReply:
  | { kind: 'result'; summary: { successProbability: number } }
  | { kind: 'error'; message: string }
  | { kind: 'aborted' } = { kind: 'result', summary: { successProbability: 0.7 } };
let poolRunNeverSettles = false;
const createMcPoolMock: Mock = vi.fn((opts: { signal?: AbortSignal }) => {
  const pool: MockPool = {
    run: vi.fn((_input: unknown, onProgress?: (done: number, total: number) => void) => {
      pool.lastOnProgress = onProgress;
      return poolRunNeverSettles ? new Promise(() => {}) : Promise.resolve(nextPoolReply);
    }),
    dispose: vi.fn(),
    size: 1,
    signal: opts.signal,
    lastOnProgress: undefined,
  };
  createdPools.push(pool);
  return pool;
});
vi.mock('../monte-carlo/mc-worker-pool', () => ({
  createMcPool: (opts: unknown) => createMcPoolMock(opts),
}));
vi.mock('../workers/monte-carlo.worker.ts?worker', () => ({ default: class {} }));

// --- Fixtures --------------------------------------------------------------

function readyData(): typeof mockData {
  return {
    ready: true,
    selectedScenarioId: 's1',
    scenarios: [{ id: 's1', payload: { name: 'Base' } }],
    members: [{ id: 'm1', payload: { isPrimary: true, birthdate: '1955-01-01' } }],
    accounts: [{ id: 'a1', payload: { active: true, currentBalance: 1_000_000 } }],
    balances: [],
    expenses: [],
    expenseCategories: [],
    incomeStreams: [],
    ssBenefits: [],
    error: null,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-15T00:00:00')); // month index 5 (June).
  mockData = readyData();
  mockResolveScenario = () => ({ retirementAge: { primary: { ageYears: 65, ageMonths: 0 } } });
  resolveScenarioMock.mockClear();
  mockResolvedGuardrails = undefined;
  mockRetirementIso = '2020-01-01';
  mockNetNeed = [909_091];
  mockTaxRate = 0;
  buildMcMock.mockClear();
  createdPools.length = 0;
  createMcPoolMock.mockClear();
  nextPoolReply = { kind: 'result', summary: { successProbability: 0.7 } };
  poolRunNeverSettles = false;
});

afterEach(() => {
  vi.useRealTimers();
});

// --- Tests -----------------------------------------------------------------

describe('useGuardrailsVm — funded-ratio wiring', () => {
  it('should_compute_the_ratio_from_the_engine_baseline_series_and_classify_hold', () => {
    // netNeed 909,091 @ 0 tax, portfolio 1,000,000 → ratio ≈ 1.10 → pct 110 →
    // HOLD (between the 85 / 115 default bands). A raw un-converted comparison
    // would misread 1.10 as ≤ 85 and say "cut". January so the
    // current-year proration is a no-op and the round number holds.
    vi.setSystemTime(new Date('2026-01-15T00:00:00'));
    const { result } = renderHook(() => useGuardrailsVm());
    expect(result.current.status).toBe('ready');
    if (result.current.status !== 'ready') return;
    expect(result.current.ratio).toBeCloseTo(1.1, 2);
    expect(result.current.verdict).toBe('hold');
    expect(result.current.config.usingDefaults).toBe(true);
  });

  it('should_classify_cut_on_the_inclusive_lower_edge', () => {
    // 850,000 / 1,000,000 = 0.85 exactly → pct 85 → CUT on the inclusive lower
    // edge (the EDGE_EPS absorbs the `ratio * 100` fp error, mirroring
    // applyGuardrailStep's own edge behavior). January so the current-year
    // proration is a no-op and the exact 0.85 edge holds.
    vi.setSystemTime(new Date('2026-01-15T00:00:00'));
    mockData.accounts = [{ id: 'a1', payload: { active: true, currentBalance: 850_000 } }];
    mockNetNeed = [1_000_000];
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.verdict).toBe('cut');
  });

  it('should_render_covered_when_net_need_is_zero_suppressed', () => {
    mockNetNeed = [0];
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.ratio).toBeNull();
    expect(result.current.verdict).toBe('covered');
  });

  it('should_prorate_only_the_current_drawdown_year_when_checked_mid_year', () => {
    // Retired for years, checked in November (month index 10). Only index 0 (the
    // current, partially-elapsed year) is prorated by the fraction of the year
    // remaining — (12 − 10) / 12 = 2/12 — so the Jan→Oct already-spent net need is
    // not counted as still owed. Year 1's liability is untouched.
    vi.setSystemTime(new Date('2026-11-15T00:00:00'));
    mockNetNeed = [1_200_000, 990_000];
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');

    const prorated = fundedRatio({
      portfolioNominal: 1_000_000,
      portfolioCumCpi: 1,
      netNeedNominalByYear: [1_200_000 * (2 / 12), 990_000],
      cumCpiByYear: [1, 1],
      effectiveTaxRate: 0,
    });
    const unprorated = fundedRatio({
      portfolioNominal: 1_000_000,
      portfolioCumCpi: 1,
      netNeedNominalByYear: [1_200_000, 990_000],
      cumCpiByYear: [1, 1],
      effectiveTaxRate: 0,
    });
    expect(result.current.ratio).toBeCloseTo(prorated as number, 6);
    // Proration is load-bearing: without it the mid-year ratio is materially lower
    // (the false-"cut" the fix prevents).
    expect(prorated as number).not.toBeCloseTo(unprorated as number, 6);
  });

  it('should_be_a_no_op_in_january_when_no_month_has_elapsed', () => {
    // Control: in January (month index 0) the proration factor is (12 − 0)/12 = 1,
    // so the ratio matches the full, un-prorated net-need series — the prior
    // behavior is not regressed.
    vi.setSystemTime(new Date('2026-01-15T00:00:00'));
    mockNetNeed = [1_200_000, 990_000];
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');

    const expected = fundedRatio({
      portfolioNominal: 1_000_000,
      portfolioCumCpi: 1,
      netNeedNominalByYear: [1_200_000, 990_000],
      cumCpiByYear: [1, 1],
      effectiveTaxRate: 0,
    });
    expect(result.current.ratio).toBeCloseTo(expected as number, 6);
  });

  it('should_exclude_inactive_account_balances_from_the_funded_ratio_numerator', () => {
    // One active ($700k) + one inactive ($300k). The projection + "Check now" MC
    // both use ACTIVE accounts only, so the numerator must too: the inactive $300k
    // is excluded. netNeed 700,000 @ 0 tax → ratio = 700k / 700k = 1.0 (active-only),
    // NOT 1,000,000 / 700,000 ≈ 1.43 (incl-inactive). January so no proration.
    vi.setSystemTime(new Date('2026-01-15T00:00:00'));
    mockData.accounts = [
      { id: 'a1', payload: { active: true, currentBalance: 700_000 } },
      { id: 'a2', payload: { active: false, currentBalance: 300_000 } },
    ];
    mockNetNeed = [700_000];
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.portfolioNominal).toBe(700_000);
    expect(result.current.ratio).toBeCloseTo(1, 6);
  });
});

describe('useGuardrailsVm — scoping + empty states', () => {
  it('should_render_not_yet_retired_for_a_later_month_in_the_current_year_month_precise', () => {
    // Today is June (month 5) 2026; retirement is November 2026 — same year, later
    // month. A year-only check would wrongly proceed.
    mockRetirementIso = '2026-11-01';
    const { result } = renderHook(() => useGuardrailsVm());
    expect(result.current.status).toBe('not-yet-retired');
    // No MC assembly attempted while gated out.
    expect(buildMcMock).not.toHaveBeenCalled();
  });

  it('should_proceed_when_retiring_exactly_this_month', () => {
    mockRetirementIso = '2026-06-01';
    const { result } = renderHook(() => useGuardrailsVm());
    expect(result.current.status).toBe('ready');
    expect(buildMcMock).toHaveBeenCalled();
  });

  it('should_render_not_yet_retired_for_a_future_year', () => {
    mockRetirementIso = '2028-01-01';
    const { result } = renderHook(() => useGuardrailsVm());
    expect(result.current.status).toBe('not-yet-retired');
    expect(buildMcMock).not.toHaveBeenCalled();
  });

  it('should_render_scenario_not_configured_without_crashing_when_the_primary_iso_is_null', () => {
    mockRetirementIso = null;
    const { result } = renderHook(() => useGuardrailsVm());
    expect(result.current.status).toBe('scenario-not-configured');
    expect(buildMcMock).not.toHaveBeenCalled();
  });

  it('should_render_scenario_not_configured_when_retirement_age_is_unset', () => {
    mockResolveScenario = () => ({});
    const { result } = renderHook(() => useGuardrailsVm());
    expect(result.current.status).toBe('scenario-not-configured');
    expect(buildMcMock).not.toHaveBeenCalled();
  });

  it('should_render_no_accounts_when_no_active_account_exists', () => {
    mockData.accounts = [{ id: 'a1', payload: { active: false } }];
    const { result } = renderHook(() => useGuardrailsVm());
    expect(result.current.status).toBe('no-accounts');
  });

  it('should_render_scenario_not_configured_when_guardrail_fields_are_absent', () => {
    mockNetNeed = undefined; // exhausted horizon → non-null input, flat fields absent.
    const { result } = renderHook(() => useGuardrailsVm());
    expect(result.current.status).toBe('scenario-not-configured');
  });
});

describe('useGuardrailsVm — Check now MC lifecycle', () => {
  it('should_run_the_real_config_input_with_the_fixed_seed_and_surface_the_pos', async () => {
    nextPoolReply = { kind: 'result', summary: { successProbability: 0.72 } };
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');

    await act(async () => {
      clickCheckNow(result.current);
    });

    // The PoS run consumes the NO-override (call 2) input, spread with the
    // fixed live seed — NOT the forced-on ratio-calc input.
    const pool = createdPools[0];
    expect(pool.run).toHaveBeenCalledTimes(1);
    const runInput = pool.run.mock.calls[0][0] as { __call: number; seed: number };
    expect(runInput.__call).toBe(2);
    expect(runInput.seed).toBe(GUARDRAILS_LIVE_MC_SEED);
    // AbortController wired through to the pool.
    expect(pool.signal).toBeInstanceOf(AbortSignal);

    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.pos).toEqual({ kind: 'ready', successProbabilityPct: 72 });
  });

  it('should_show_pending_while_the_run_is_in_flight', () => {
    poolRunNeverSettles = true;
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    act(() => {
      clickCheckNow(result.current);
    });
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.pos.kind).toBe('pending');
  });

  it('should_seed_progress_total_from_the_input_path_count_immediately_on_click', () => {
    poolRunNeverSettles = true;
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    act(() => {
      clickCheckNow(result.current);
    });
    if (result.current.status !== 'ready') throw new Error('expected ready');
    // Known synchronously from the built input (pathCount: 10_000, __call 2) —
    // seeded before any worker `progress` message arrives so the bar renders
    // determinate from the first paint instead of starting indeterminate.
    expect(result.current.posProgressDone).toBe(0);
    expect(result.current.posProgressTotal).toBe(10_000);
  });

  it('should_update_progress_as_the_pool_reports_done_of_total', () => {
    poolRunNeverSettles = true;
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    act(() => {
      clickCheckNow(result.current);
    });
    act(() => {
      createdPools[0].lastOnProgress?.(2_500, 10_000);
    });
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.posProgressDone).toBe(2_500);
    expect(result.current.posProgressTotal).toBe(10_000);
  });

  it('should_reset_progress_to_zero_once_the_run_settles', async () => {
    nextPoolReply = { kind: 'result', summary: { successProbability: 0.7 } };
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    await act(async () => {
      clickCheckNow(result.current);
    });
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.pos.kind).toBe('ready');
    expect(result.current.posProgressDone).toBe(0);
    expect(result.current.posProgressTotal).toBe(0);
  });

  it('should_ignore_a_stale_progress_report_from_a_superseded_run', () => {
    poolRunNeverSettles = true;
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    act(() => {
      clickCheckNow(result.current); // run 1
    });
    const staleOnProgress = createdPools[0].lastOnProgress;
    act(() => {
      clickCheckNow(result.current); // supersedes run 1 with run 2
    });
    act(() => {
      staleOnProgress?.(9_999, 10_000); // late report from the disposed run 1
    });
    if (result.current.status !== 'ready') throw new Error('expected ready');
    // Run 2 has not reported anything yet — the stale run-1 report must not
    // leak through and show a misleadingly near-complete bar for run 2.
    expect(result.current.posProgressDone).toBe(0);
    expect(result.current.posProgressTotal).toBe(10_000);
  });

  it('should_surface_timed_out_when_the_pool_resolves_aborted', async () => {
    nextPoolReply = { kind: 'aborted' };
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    await act(async () => {
      clickCheckNow(result.current);
    });
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.pos.kind).toBe('timed-out');
  });

  it('should_surface_error_when_the_pool_resolves_error', async () => {
    nextPoolReply = { kind: 'error', message: 'boom' };
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    await act(async () => {
      clickCheckNow(result.current);
    });
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.pos.kind).toBe('error');
  });

  it('should_dispose_the_pool_on_unmount_no_leaked_worker', () => {
    poolRunNeverSettles = true;
    const { result, unmount } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    act(() => {
      clickCheckNow(result.current);
    });
    unmount();
    expect(createdPools[0].dispose).toHaveBeenCalled();
  });

  it('should_supersede_a_prior_in_flight_run_cleanly', () => {
    poolRunNeverSettles = true;
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    act(() => {
      clickCheckNow(result.current);
    });
    act(() => {
      clickCheckNow(result.current);
    });
    expect(createdPools.length).toBe(2);
    expect(createdPools[0].dispose).toHaveBeenCalled();
  });

  it('should_run_fresh_and_uncached_each_click_with_a_stable_pos_fixed_seed', async () => {
    nextPoolReply = { kind: 'result', summary: { successProbability: 0.5 } };
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    await act(async () => {
      clickCheckNow(result.current);
    });
    await act(async () => {
      clickCheckNow(result.current);
    });
    // Two fresh pools (no cache short-circuit), both seeded identically.
    expect(createdPools.length).toBe(2);
    expect((createdPools[0].run.mock.calls[0][0] as { seed: number }).seed).toBe(
      GUARDRAILS_LIVE_MC_SEED,
    );
    expect((createdPools[1].run.mock.calls[0][0] as { seed: number }).seed).toBe(
      GUARDRAILS_LIVE_MC_SEED,
    );
  });

  it('should_temper_a_raise_to_hold_when_the_pos_is_thin', async () => {
    // ratio far above the upper band → raise; PoS 60% < 80% → tempered to hold.
    mockNetNeed = [100_000];
    nextPoolReply = { kind: 'result', summary: { successProbability: 0.6 } };
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.verdict).toBe('raise');
    expect(result.current.temperedVerdict).toBe('raise'); // no PoS yet.
    await act(async () => {
      clickCheckNow(result.current);
    });
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.verdict).toBe('raise'); // raw funded-ratio verdict unchanged.
    expect(result.current.temperedVerdict).toBe('hold');
  });

  it('should_leave_a_raise_standing_when_the_pos_is_healthy', async () => {
    mockNetNeed = [100_000];
    nextPoolReply = { kind: 'result', summary: { successProbability: 0.95 } };
    const { result } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    await act(async () => {
      clickCheckNow(result.current);
    });
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.temperedVerdict).toBe('raise');
  });

  it('should_reset_a_settled_pos_to_idle_when_a_same_scenario_reactive_input_changes', async () => {
    // Settle a "Check now" run to `ready`, then change a same-scenario reactive
    // input that is NOT `selectedScenarioId` (an account balance — a NEW accounts
    // array reference, exactly what a store write produces). The funded-ratio core
    // recomputes off that same data, so the stale PoS must not linger and temper
    // the freshly recomputed verdict — it returns to `idle`.
    nextPoolReply = { kind: 'result', summary: { successProbability: 0.72 } };
    const { result, rerender } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    await act(async () => {
      clickCheckNow(result.current);
    });
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.pos).toEqual({ kind: 'ready', successProbabilityPct: 72 });

    act(() => {
      mockData.accounts = [
        { id: 'a1', payload: { active: true, currentBalance: 500_000 } },
      ];
      rerender();
    });
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.pos).toEqual({ kind: 'idle' });
  });

  it('should_dispose_an_in_flight_run_and_reset_pos_when_a_same_scenario_input_changes', () => {
    // An in-flight run is torn down (pool.dispose) and the PoS reset when the
    // underlying reactive inputs change mid-run — the run is now based on stale
    // inputs, so it must not settle against the recomputed verdict.
    poolRunNeverSettles = true;
    const { result, rerender } = renderHook(() => useGuardrailsVm());
    if (result.current.status !== 'ready') throw new Error('expected ready');
    act(() => {
      clickCheckNow(result.current);
    });
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.pos.kind).toBe('pending');

    act(() => {
      mockData.accounts = [
        { id: 'a1', payload: { active: true, currentBalance: 500_000 } },
      ];
      rerender();
    });
    expect(createdPools[0].dispose).toHaveBeenCalled();
    if (result.current.status !== 'ready') throw new Error('expected ready');
    expect(result.current.pos).toEqual({ kind: 'idle' });
  });

  it('exposes a timeout bound above the path budget', () => {
    // Sanity pin so the constant can't be trimmed to 0 without a failing test.
    expect(GUARDRAILS_LIVE_MC_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});
