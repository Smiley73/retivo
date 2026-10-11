/**
 * Market-stress comparison tests: the card surface and the comparison hook, which share one mocked worker pool and MC cache.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PlanStressTestVm } from './PlanStressTestSection';
import { PlanStressTestMarketStress } from './PlanStressTestCards';
import { vm, summary as stressSummaryBase } from './__fixtures__/plan-stress-test-vm';
import { STRESS_CASE_TIMEOUT_MS, useMarketStressComparison } from './plan-market-stress-comparison';
import { STRESS_CASE_IDS, type StressCaseId } from '../lib/market-stress';
import type { MonteCarloSummary } from '../lib/monte-carlo-types';
import { getCached, putCached } from '../db/monte-carlo-cache';
import { expectNoA11yViolations } from '../test/a11y';
import { withTheme } from '../test/theme-render';

// Market-stress comparison: the automatic comparison runs through ONE
// size-1 worker pool, built lazily on the first cache MISS, so mock the pool +
// the MC cache (never IndexedDB, never a real Worker). Each `pool.run()` resolves with a per-case stressed summary derived
// from the staged success probabilities, in `STRESS_CASE_IDS` order.
const stressPoolRuns: unknown[] = [];
let stressSuccessQueue: number[] = [];
/** Per-case median depletion year, in `STRESS_CASE_IDS` order. `null` means the
 *  MEDIAN path never depletes — which is a statement about half the paths, not
 *  about the plan, hence the boundary coverage below. */
let stressDepletionQueue: (number | null)[] = [];
let stressPoolFails = false;
/** Simulates a wedged worker: `run()` never settles, so only the hook's own
 *  bounded timeout can end the walk. */
let stressPoolHangs = false;
/** When set, `run()` reports this path-level tick through `onProgress` before
 *  doing anything else, then HANGS from the `parkFromRun`-th run onward (1 =
 *  park immediately, `Infinity` = always resolve). Parking is what makes an
 *  in-flight row observable; resolving is what proves a SETTLED case drops its
 *  progress. Parking on a LATER run leaves the walk alive with an earlier case
 *  already settled — the only state in which a straggler tick can reach the
 *  hook's own guard rather than being absorbed by walk disposal. */
let stressPoolProgressTick:
  | { done: number; total: number; parkFromRun: number }
  | null = null;
/** Every `onProgress` the pool was handed, in dispatch order, so a test can
 *  fire a STRAGGLER tick for a case that has already settled. */
const stressPoolOnProgressByRun: ((done: number, total: number) => void)[] = [];
/** Simulates a browser that refuses to spawn the worker: `createMcPool`
 *  constructs its worker EAGERLY, so the constructor throw escapes pool
 *  creation — which is why the mock below calls the factory the way the real
 *  pool does instead of ignoring it. */
let stressWorkerConstructionThrows = false;
const stressPoolDispose = vi.fn();
/** How many pools the comparison has BUILT. The pool is created lazily, on the
 *  first case to miss the cache, so this is the assertion that a walk which
 *  never needed a worker never spawned one — a plain dispatch count cannot tell
 *  "built and idle" from "never built". */
let stressPoolCreated = 0;
vi.mock('../monte-carlo/mc-worker-pool', () => ({
  createMcPool: (opts: { factory: () => unknown }) => {
    // Eager construction, exactly like the real pool's slot loop — a factory
    // that throws must escape `createMcPool`, not be swallowed by the mock.
    opts.factory();
    stressPoolCreated += 1;
    return {
      size: 1,
      dispose: stressPoolDispose,
      run: (
        input: unknown,
        onProgress?: (done: number, total: number) => void,
      ) => {
        stressPoolRuns.push(input);
        if (onProgress) stressPoolOnProgressByRun.push(onProgress);
        if (stressPoolProgressTick) {
          onProgress?.(stressPoolProgressTick.done, stressPoolProgressTick.total);
          if (stressPoolRuns.length >= stressPoolProgressTick.parkFromRun) {
            return new Promise(() => {});
          }
        }
        if (stressPoolHangs) return new Promise(() => {});
        if (stressPoolFails) return Promise.resolve({ kind: 'error', message: 'boom' });
        const successProbability = stressSuccessQueue.shift() ?? 0.5;
        const medianDepletionYear =
          stressDepletionQueue.length > 0 ? stressDepletionQueue.shift()! : null;
        return Promise.resolve({
          kind: 'result',
          // NOTE: `stressSummaryBase` is a FACTORY — it must be CALLED.
          // Spreading the function itself yields no fields, which left every
          // depletion year `undefined` and rendered "Runs out undefined".
          summary: {
            ...stressSummaryBase(),
            successProbability,
            medianDepletionYear,
            medianEndingBalanceReal: 32 - 10 * (1 - successProbability),
          },
        });
      },
    };
  },
}));
vi.mock('../workers/monte-carlo.worker.ts?worker', () => ({
  default: class {
    constructor() {
      if (stressWorkerConstructionThrows) throw new Error('Worker constructor blocked');
    }
  },
}));
/** Stressed summaries already in the MC cache, keyed by case id. Empty (the
 *  default) means every case is a miss, which is what every pre-cache test
 *  assumed. Populate it to exercise the cache-first path the automatic walk
 *  takes before it builds a worker. */
const stressCacheHits = new Map<StressCaseId, MonteCarloSummary>();
vi.mock('../db/monte-carlo-cache', () => ({
  // The real key is a hash of the whole stressed input; the mock only needs it
  // to DIFFER per case, so it reads the lever each case pulls. `longerLife`
  // pulls none of them — it only extends the horizon — so it is the fallthrough.
  computeCacheKey: vi.fn(async (input: unknown) => {
    const i = input as {
      returnShock?: unknown;
      inflationShockPct?: number;
      annualInvestmentCostPct?: number;
    };
    if (i.returnShock) return 'case:lowerReturns';
    if (i.inflationShockPct) return 'case:higherInflation';
    if (i.annualInvestmentCostPct) return 'case:higherFees';
    return 'case:longerLife';
  }),
  getCached: vi.fn(async (key: string) =>
    stressCacheHits.get(key.replace('case:', '') as StressCaseId) ?? null,
  ),
  putCached: vi.fn(async () => {}),
}));


// ---------------------------------------------------------------------------
// Market-stress comparison: selection, deltas, a11y
// ---------------------------------------------------------------------------

describe('PlanStressTestMarketStress — same-path stress comparison', () => {
  /** A vm carrying everything the comparison needs: a settled base result, the
   *  base MC input, and a birth year to anchor the age-105 longevity cap. */
  function comparableVm(
    overrides: Partial<PlanStressTestVm> = {},
  ): PlanStressTestVm {
    return vm({
      stressBaseInput: {
        horizonYear: 2070,
        firstYear: 2026,
        // The longevity stress PADS every horizon-length series, so the fake
        // input carries the four required ones (a bare `{horizonYear}` would
        // throw and silently turn the longer-life case into an error row).
        monthlyExpenseBase: new Array(24).fill(100),
        ssByYear: new Array(45).fill(0),
        incomeByYear: new Array(45).fill(0),
        accountMcLedger: [],
      } as unknown as PlanStressTestVm['stressBaseInput'],
      // The settled base run's pair identity. `null` here means the primary run
      // has not settled for the plan on screen, and the comparison withholds
      // itself rather than differencing across an edit.
      stressPairSignature: 'plan-A::seed-1',
      // 1968 + 105 = 2073, so the age-105 cap lands BETWEEN the base horizon
      // (2070) and the uncapped +5 extension (2075) — capped and uncapped are
      // different numbers, which is what makes the cap test discriminating.
      longestLivedBirthYear: 1968,
      ...overrides,
    });
  }

  beforeEach(() => {
    stressPoolRuns.length = 0;
    stressPoolCreated = 0;
    stressPoolDispose.mockClear();
    vi.mocked(putCached).mockClear();
    stressPoolFails = false;
    stressPoolHangs = false;
    stressPoolProgressTick = null;
    stressPoolOnProgressByRun.length = 0;
    stressCacheHits.clear();
    stressWorkerConstructionThrows = false;
    // Fees / lower returns / higher inflation / longer life.
    stressSuccessQueue = [0.46, 0.4, 0.42, 0.44];
    stressDepletionQueue = [];
  });

  /**
   * Let the automatic walk get as far as it is going to.
   *
   * Dispatch sits behind `await computeCacheKey(...)`, so `pool.run` can never
   * be reached synchronously — an `expect(stressPoolRuns).toHaveLength(0)`
   * placed straight after `render()` cannot fail no matter what the hook does.
   * Every "nothing was dispatched" assertion has to flush first.
   */
  async function flushWalk(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /**
   * Wait for the automatic walk to fill every row.
   *
   * The comparison used to be opt-in, and `await user.click(Compare)` doubled
   * as the flush that let it settle. With the walk starting on its own, that
   * await is gone — and `findByRole('grid')` no longer implies anything, since
   * the table is on screen from the first paint. A queued case renders "…", so
   * "no ellipsis left anywhere" is exactly "every row has resolved".
   */
  async function settledGrid(): Promise<HTMLElement> {
    const grid = await screen.findByRole('grid', {
      name: 'Market stress comparison',
    });
    await waitFor(() => expect(within(grid).queryByText('…')).toBeNull());
    return grid;
  }

  it('withholds the comparison until a base run is available', async () => {
    // No base run yet, but the household's ages are known — so "run the stress
    // test first" is the action that actually unblocks this state.
    render(
      withTheme(
        'light',
        <PlanStressTestMarketStress
          vm={vm({ result: null, longestLivedBirthYear: 1968 })}
        />,
      ),
    );
    expect(
      screen.getByText(/run the stress test first to compare your plan/i),
    ).toBeInTheDocument();
    // Withheld means withheld: no table, and — now that the walk starts itself —
    // nothing dispatched and no worker built either.
    expect(
      screen.queryByRole('grid', { name: 'Market stress comparison' }),
    ).not.toBeInTheDocument();
    await flushWalk();
    expect(stressPoolRuns).toHaveLength(0);
    expect(stressPoolCreated).toBe(0);
  });

  it('names the missing birthdate instead of asking for a stress test that cannot fix it', async () => {
    // Reachable with a fully settled base run: `longestLivedBirthYearOf` uses
    // the STRICT ISO-date check, so a member imported with `birthdate: "1968"`
    // yields no birth year here while the engine still projects the plan. The
    // longevity cap has no age to anchor on until the date is fixed, and no
    // number of stress-test re-runs supplies it.
    render(
      withTheme(
        'light',
        <PlanStressTestMarketStress
          vm={comparableVm({ longestLivedBirthYear: null })}
        />,
      ),
    );
    expect(
      screen.getByText(
        'Add each person’s birthdate on the Household page to compare your plan against a longer life.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/run the stress test first/i)).toBeNull();
    expect(
      screen.queryByRole('grid', { name: 'Market stress comparison' }),
    ).not.toBeInTheDocument();
    await flushWalk();
    expect(stressPoolRuns).toHaveLength(0);
  });

  it('runs every named stress against the base run and reports success + shortfall deltas', async () => {
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));

    const grid = await settledGrid();
    // One row per approved shock.
    for (const name of [
      'Higher fees',
      'Lower returns',
      'Higher inflation',
      'Longer life',
    ]) {
      expect(await within(grid).findByText(name)).toBeInTheDocument();
    }
    // The changed assumption is named on the row, not hidden in a modal, and
    // its magnitude is interpolated from the one `STRESS_CASES` map.
    expect(
      within(grid).getByText(/investment cost 0\.5% a year higher/i),
    ).toBeInTheDocument();
    // Base 50% → fees 46% is a −4pp delta; lower returns 40% is −10pp.
    expect(await within(grid).findByText('-4pp')).toBeInTheDocument();
    expect(await within(grid).findByText('-10pp')).toBeInTheDocument();
    // Every one of the four results is written back under the MARKET-STRESS
    // entry class, which is what keeps them inside their own small LRU reserve.
    // Charging them to the primary budget instead would let one comparison
    // evict the cached scenario results the Scenarios page reads — the defect
    // the reserve exists to prevent — and `monte-carlo-cache.test.ts` only
    // proves the cache HONORS the class, never that this producer passes it.
    expect(vi.mocked(putCached)).toHaveBeenCalledTimes(4);
    for (const [key, , entryClass] of vi.mocked(putCached).mock.calls) {
      expect(typeof key).toBe('string');
      expect(entryClass).toBe('marketStress');
    }
  });

  it('lists every stress and what it changes from the first paint, before any case resolves', async () => {
    // The table used to appear only after the button was pressed, leaving the
    // panel looking empty and giving no idea what was coming. It is now on
    // screen — with its rows already queued — in the very first render.
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    const grid = screen.getByRole('grid', { name: 'Market stress comparison' });
    for (const name of ['Higher fees', 'Lower returns', 'Higher inflation', 'Longer life']) {
      expect(within(grid).getByText(name)).toBeInTheDocument();
    }
    // The assumption each one changes is readable up front — that is the part
    // worth showing before the figures land.
    expect(within(grid).getByText(/investment cost 0\.5% a year higher/i)).toBeInTheDocument();
    // The Success cell distinguishes queued-behind-a-running-walk ("…") from
    // nothing-running ("—"), and the walk is running: four queued cases. The
    // other two figure columns have no such distinction to draw and hold a
    // plain "—" each until their row resolves.
    expect(within(grid).getAllByText('…')).toHaveLength(4);
    expect(within(grid).getAllByText('—')).toHaveLength(8);
    // No button: a comparison the user did not ask for has nothing to offer
    // them until something fails.
    expect(screen.queryByRole('button')).toBeNull();
    await settledGrid();
  });

  it('serves a fully cached comparison without dispatching anything to a worker', async () => {
    // Every case is cache-first on a seed-inclusive key, so the automatic walk
    // over an unchanged plan is four cache reads and no simulation at all. This
    // is what makes the comparison affordable to start on its own — and what
    // made a "Compare again" button a no-op, since it could only ever re-serve
    // these same entries.
    for (const caseId of STRESS_CASE_IDS) {
      stressCacheHits.set(
        caseId,
        stressSummaryBase({ successProbability: 0.44, medianEndingBalanceReal: 21 }),
      );
    }
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    const grid = screen.getByRole('grid', { name: 'Market stress comparison' });
    expect(await within(grid).findAllByText('44%')).toHaveLength(4);
    // Nothing was computed: no dispatch, no cache WRITE, and — the assertion
    // that matters — no worker CONSTRUCTED. Building the pool up front spawned
    // and tore down the whole Monte Carlo bundle on every visit to an
    // already-compared plan, which a dispatch count cannot see.
    expect(stressPoolRuns).toHaveLength(0);
    expect(stressPoolCreated).toBe(0);
    expect(vi.mocked(putCached)).not.toHaveBeenCalled();
    // Settled, so no bar is left standing and the surface is no longer busy.
    await waitFor(() => expect(screen.queryAllByRole('progressbar')).toHaveLength(0));
  });

  it('shows cached answers even when the browser refuses to spawn a worker', async () => {
    // The reason the pool is built lazily rather than up front. Every answer is
    // already in the cache; the worker is only needed for a MISS. Constructing
    // it first turned a strict-CSP / enterprise-blocked / memory-pressured
    // browser into four "Unavailable" rows sitting on top of four perfectly
    // good results — strictly worse than the read-only cache probe this
    // replaced, which never touched a worker at all.
    for (const caseId of STRESS_CASE_IDS) {
      stressCacheHits.set(caseId, stressSummaryBase({ successProbability: 0.44 }));
    }
    stressWorkerConstructionThrows = true;
    const grid = await (async () => {
      render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
      return settledGrid();
    })();
    expect(within(grid).getAllByText('44%')).toHaveLength(4);
    expect(within(grid).queryByText('Unavailable')).toBeNull();
    // Nothing failed, so nothing is offered to retry.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps cached answers and marks only the misses unavailable when the worker fails', async () => {
    // The mixed case: one stored answer, three that need a worker that will not
    // start. The stored one is a real result and must survive; the three are
    // genuinely unavailable. Settling all four as errors — which building the
    // pool first did — throws away an answer the user already paid for.
    stressCacheHits.set('higherFees', stressSummaryBase({ successProbability: 0.44 }));
    stressWorkerConstructionThrows = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
      const grid = await settledGrid();
      expect(within(grid).getByText('44%')).toBeInTheDocument();
      expect(within(grid).getAllByText('Unavailable')).toHaveLength(3);
      // Logged ONCE for the comparison, not once per case re-throwing a
      // constructor already known to fail.
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('runs only the cases the cache does not already hold', async () => {
    // A partially cached comparison is the normal state after an edit: the walk
    // must pay for the misses and no more.
    stressCacheHits.set('higherFees', stressSummaryBase({ successProbability: 0.44 }));
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    const grid = await settledGrid();
    expect(within(grid).getByText('44%')).toBeInTheDocument();
    // Three misses dispatched; the hit never reached the pool.
    expect(stressPoolRuns).toHaveLength(3);
  });

  it('centres the depletion column, header and cell alike', async () => {
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    const grid = await settledGrid();
    expect(
      within(grid).getByRole('columnheader', { name: 'Median path runs out' }).className,
    ).toContain('text-center');
    const row = (await within(grid).findByText('Higher fees')).closest('[role="row"]');
    const cell = row!.querySelectorAll('[role="gridcell"], [role="rowheader"]')[4] as HTMLElement;
    expect(cell.className).toContain('text-center');
  });

  it('shows a coarse case-unit bar and a path-level bar for the case on the worker', async () => {
    // The comparison is four full Monte Carlo runs deep, so it reports progress
    // at BOTH granularities the rest of the app uses (Scenarios bulk recompute,
    // the SS optimizer): a coarse determinate bar in CASE units, plus a
    // path-level bar on the one row actually simulating. Parking the first run
    // after a tick is what makes the in-flight row observable at all.
    stressPoolProgressTick = { done: 2500, total: 10_000, parkFromRun: 1 };
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    // Coarse: zero of four cases done, counted in CASES — not the "paths" the
    // shared bar defaults to, which would misname what the number counts.
    expect(
      await screen.findByRole('progressbar', {
        name: 'Comparing market stresses: 0 of 4 done',
      }),
    ).toBeInTheDocument();
    // Fine: the running case's own path count, on its row.
    expect(
      await screen.findByRole('progressbar', {
        name: 'Comparing Higher fees: 2,500 of 10,000 paths',
      }),
    ).toBeInTheDocument();
    // Only the case ON the worker gets a bar — the three still queued keep the
    // plain placeholder, so the surface never implies four runs at once.
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  });

  it('leaves no bar behind once every case has settled', async () => {
    // Every case REPORTS progress and then resolves, so each row genuinely held
    // a bar before it settled. This asserts the RENDERED outcome only — the
    // `progress: null` on settle is pinned at the VM level in the hook suite
    // below, because the Success cell reads `delta` and `error` BEFORE it ever
    // reaches `progress`, so no DOM assertion can discriminate the two.
    stressPoolProgressTick = { done: 2500, total: 10_000, parkFromRun: Infinity };
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    const grid = await settledGrid();
    await within(grid).findByText('46%');
    await waitFor(() => expect(screen.queryAllByRole('progressbar')).toHaveLength(0));
  });

  it('has no a11y violations while the comparison is running', async () => {
    // The existing axe pass covers only the RESOLVED table. The running state
    // adds two progressbars — one of them inside a `role="gridcell"` in a React
    // Aria grid — neither of which was ever scanned.
    stressPoolProgressTick = { done: 2500, total: 10_000, parkFromRun: 1 };
    const { container } = render(
      withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />),
    );
    await screen.findByRole('progressbar', {
      name: 'Comparing Higher fees: 2,500 of 10,000 paths',
    });
    await expectNoA11yViolations(container);
  });

  it('reports automatic progress with aria-busy, not a live region', async () => {
    // The comparison used to be a deliberate button press, which earned it a
    // polite live region announcing progress and completion. Nobody presses
    // anything now: the same region would interrupt a screen-reader user on
    // every visit to this page and after every settled edit, to narrate work
    // they neither started nor were waiting on. `aria-busy` carries the same
    // state without speaking.
    stressPoolProgressTick = { done: 2500, total: 10_000, parkFromRun: 1 };
    const { container } = render(
      withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />),
    );
    await screen.findByRole('progressbar', {
      name: 'Comparing market stresses: 0 of 4 done',
    });
    expect(screen.queryByRole('status')).toBeNull();
    // On the named scroll REGION, not the role-less wrapper it sat on first —
    // `aria-busy` on a generic container is inert, so the a11y claim the code
    // makes would have been false while this assertion still passed.
    expect(
      screen.getByRole('region', { name: 'Market stress comparison' }),
    ).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('survives StrictMode’s double-invoke with one live walk and an honest running state', async () => {
    // The app mounts under `React.StrictMode`, which invokes every effect
    // twice. The arming effect therefore disposes walk A and starts walk B
    // under ONE UNCHANGED pair key — the only situation where two walks share a
    // key. A's exit path was keyed on the pair alone, so it published
    // `walking: false` over B: the progress bar vanished and the comparison
    // reported itself finished while B was still running it. Parking B on its
    // first case is what holds that window open long enough to observe.
    stressPoolProgressTick = { done: 2500, total: 10_000, parkFromRun: 1 };
    render(
      <StrictMode>
        {withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />)}
      </StrictMode>,
    );
    // Exactly one walk reached the worker. Walk A is disposed before its first
    // cache read resolves, so with the pool built lazily it never constructs
    // one at all — "one live walk" is now counted in DISPATCHES, not disposals.
    await waitFor(() => expect(stressPoolRuns).toHaveLength(1));
    const bar = await screen.findByRole('progressbar', {
      name: 'Comparing market stresses: 0 of 4 done',
    });
    // A's `finally` has long since run by here — the bar it used to remove is
    // still standing, because the walk it belonged to is not the live one.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(bar).toBeInTheDocument();
    expect(stressPoolRuns).toHaveLength(1);
  });

  it('drops aria-busy once every case has settled', async () => {
    // The negative half of the pair above: a surface left permanently busy is
    // as wrong as one that never reports being busy at all.
    const { container } = render(
      withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />),
    );
    await settledGrid();
    await waitFor(() =>
      expect(container.querySelector('[aria-busy="true"]')).toBeNull(),
    );
    expect(
      screen.getByRole('region', { name: 'Market stress comparison' }),
    ).toHaveAttribute('aria-busy', 'false');
  });

  it('colours a zero change green, not red', async () => {
    // The stated rule is green at or AT zero. Every other colour assertion here
    // uses a strictly positive or negative delta, so flipping the boundary to
    // red would leave them all passing.
    stressSuccessQueue = [0.5, 0.5, 0.5, 0.5];
    render(
      withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />),
    );
    const grid = await settledGrid();
    const row = (await within(grid).findByText('Higher fees')).closest('[role="row"]');
    const cells = row!.querySelectorAll('[role="gridcell"], [role="rowheader"]');
    // Stress | What changes | Success | Change | Runs out
    const cell = cells[3] as HTMLElement;
    expect(cell.textContent).toBe('No change');
    expect(cell.className).toContain('text-positive');
  });

  it('colours the Change column green at or above zero and red below', async () => {
    // Fees improve the plan, lower returns hurt it — one row of each direction,
    // so a colour wired to the wrong sign fails.
    stressSuccessQueue = [0.56, 0.4, 0.42, 0.44];
    render(
      withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />),
    );
    const grid = await settledGrid();
    expect((await within(grid).findByText('+6pp')).className).toContain(
      'text-positive',
    );
    expect((await within(grid).findByText('-10pp')).className).toContain(
      'text-negative',
    );
  });

  it('names the age the LAST SURVIVOR reaches, not the cap anchor’s', async () => {
    // The two diverge here: the cap is anchored on the youngest member (born
    // 1978), but the plan's horizon belongs to an OLDER member (born 1968) who
    // outlives them. The row must credit the added years to the survivor whose
    // death ends the plan — 2075 − 1968 = 107 — not to the youngest, who is
    // already dead by then. It must also not announce the age-105 ceiling,
    // which is irrelevant to this household and made the row read as though the
    // plan runs to 105. (`market-stress.test.ts` covers the capped arithmetic.)
    render(
      withTheme(
        'light',
        <PlanStressTestMarketStress
          vm={comparableVm({
            longestLivedBirthYear: 1978,
            lastSurvivor: { firstName: 'John', birthYear: 1968 },
          })}
        />,
      ),
    );
    const grid = await settledGrid();
    expect(
      await within(grid).findByText('5 more years of retirement (John age 107)'),
    ).toBeInTheDocument();
    expect(within(grid).queryByText(/age 105/)).toBeNull();
    // The youngest member's age at that horizon (2075 − 1978 = 97) is what the
    // row USED to print — a person the plan buried before the stress even ran.
    expect(within(grid).queryByText(/age 97/)).toBeNull();
  });

  it('states the longevity age without a name when both members reach the horizon', async () => {
    // An uncapped household (born 1990 → age 105 in 2095, well past the 2075
    // extension) proves the row reports the REACHED age, not the ceiling. With
    // no single survivor to credit, the age stands unattributed.
    render(
      withTheme(
        'light',
        <PlanStressTestMarketStress
          vm={comparableVm({
            longestLivedBirthYear: 1990,
            lastSurvivor: { firstName: null, birthYear: 1990 },
          })}
        />,
      ),
    );
    const grid = await settledGrid();
    expect(
      within(grid).getByText('5 more years of retirement (to age 85)'),
    ).toBeInTheDocument();
  });

  it('pairs every stress run to the DISPLAYED base run seed and path count', async () => {
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    await settledGrid();
    expect(stressPoolRuns).toHaveLength(4);
    for (const run of stressPoolRuns as { seed: number; pathCount: number }[]) {
      expect(run.seed).toBe(1);
      expect(run.pathCount).toBe(100);
    }
  });

  it('caps the longevity stress at age 105 for the longest-lived member', async () => {
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    await settledGrid();
    // Base horizon 2070; +5 years would reach 2075, but the youngest member's
    // age-105 year is 1968 + 105 = 2073, so the cap binds THERE. Capped (2073)
    // and uncapped (2075) are deliberately different numbers — an anchor where
    // they coincide would pass whether the cap ran or not.
    const longerLife = (stressPoolRuns as { horizonYear: number }[])[3];
    expect(longerLife.horizonYear).toBe(2073);
  });

  it('extends the full five years when the age-105 cap does not bind', async () => {
    render(
      withTheme(
        'light',
        // 1990 + 105 = 2095, far past the +5 extension, so nothing is clipped.
        <PlanStressTestMarketStress vm={comparableVm({ longestLivedBirthYear: 1990 })} />,
      ),
    );
    await settledGrid();
    const longerLife = (stressPoolRuns as { horizonYear: number }[])[3];
    expect(longerLife.horizonYear).toBe(2075);
  });

  it('marks a failed case Unavailable and offers the one retry worth offering', async () => {
    // A crashed worker or a per-case timeout is not a permanent verdict, and it
    // leaves nothing in the cache — so a retry can genuinely produce a
    // different outcome. That is the ONLY state in which this surface still
    // shows a button: re-running a case that succeeded would re-serve its
    // cached summary unchanged.
    stressPoolFails = true;
    const user = userEvent.setup();
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    const grid = await screen.findByRole('grid', {
      name: 'Market stress comparison',
    });
    expect(await within(grid).findAllByText('Unavailable')).toHaveLength(4);

    const retry = screen.getByRole('button', {
      name: 'Try the market stress comparison again',
    });
    stressPoolFails = false;
    stressSuccessQueue = [0.46, 0.4, 0.42, 0.44];
    await user.click(retry);
    expect(await within(grid).findByText('46%')).toBeInTheDocument();
    // With nothing left failing, the button goes away again.
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  });

  it('disposes the worker pool once the walk finishes (no leaked worker)', async () => {
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    await settledGrid();
    await waitFor(() => expect(stressPoolDispose).toHaveBeenCalled());
  });

  it('labels the depletion column as a MEDIAN-path statistic, not a whole-plan promise', async () => {
    // A null median depletion year means at most half the paths deplete — up to
    // half of them still can. "Still funds the full plan" read as a guarantee.
    // The short cell reading drops the qualifier, so the COLUMN HEADER is what
    // now carries "median path" — this pins that it still does.
    stressDepletionQueue = [null, 2064, null, 2066];
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    const grid = await settledGrid();
    expect(
      within(grid).getAllByText('Fully funded'),
    ).toHaveLength(2);
    expect(
      within(grid).getByRole('columnheader', { name: 'Median path runs out' }),
    ).toBeInTheDocument();
  });

  it('holds the median-path wording at the 50% depletion boundary', async () => {
    // Exactly half the paths deplete: the engine still reports no median
    // depletion year, and the copy must not promote that into "the plan holds".
    stressSuccessQueue = [0.5, 0.5, 0.5, 0.5];
    stressDepletionQueue = [null, null, null, null];
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    const grid = await settledGrid();
    expect(
      within(grid).getAllByText('Fully funded'),
    ).toHaveLength(4);
    expect(
      within(grid).getByRole('columnheader', { name: 'Median path runs out' }),
    ).toBeInTheDocument();
  });

  it('reads a depleting base run as sooner / unchanged / later, in that direction', async () => {
    // The one SIGNED piece of time arithmetic on this surface. Every other case
    // here leaves the base run undepleted, which never reaches the comparative
    // wording at all — so without this the subtraction could be reversed and
    // print "6 yr later" for a stress that runs the money out six years EARLIER.
    stressDepletionQueue = [2058, 2064, 2070, null];
    render(
      withTheme(
        'light',
        <PlanStressTestMarketStress
          vm={comparableVm({
            result: stressSummaryBase({ medianDepletionYear: 2064 }),
          })}
        />,
      ),
    );
    const grid = await settledGrid();
    const rowFor = async (name: string): Promise<string> => {
      const row = (await within(grid).findByText(name)).closest('[role="row"]');
      expect(row).not.toBeNull();
      return row!.textContent ?? '';
    };
    // Base median depletion 2064.
    expect(await rowFor('Higher fees')).toContain('2058 (6 yr sooner)');
    expect(await rowFor('Lower returns')).toContain('2064 (unchanged)');
    expect(await rowFor('Higher inflation')).toContain(
      '2070 (6 yr later)',
    );
  });

  it('renders exactly the five comparison columns, in order', async () => {
    // The three positional cell reads in this suite index into the row, so a
    // silently added, removed or reordered column moves them all. Pin the whole
    // column set, ordered and exact-length, so that drift fails here first.
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    const grid = await settledGrid();
    expect(
      within(grid)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Stress',
      'What changes',
      'Success',
      'Change',
      'Median path runs out',
    ]);
  });

  it('shows the success change as the difference between the two DISPLAYED percentages', async () => {
    // 0.496 displays as 50% and 0.454 as 45%; rounding the raw difference
    // independently would print "-4pp" beside two numbers 5 points apart.
    stressSuccessQueue = [0.454, 0.4, 0.42, 0.44];
    render(
      withTheme(
        'light',
        <PlanStressTestMarketStress
          vm={comparableVm({ result: stressSummaryBase({ successProbability: 0.496 }) })}
        />,
      ),
    );
    const grid = await settledGrid();
    const feesRow = within(grid).getByText('Higher fees').closest('[role="row"]');
    expect(feesRow!.textContent).toContain('45%');
    expect(feesRow!.textContent).toContain('-5pp');
  });

  it('pins the whole footnote, sentence for sentence', async () => {
    // A POSITIVE full-text pin, not a set of negative assertions: the sentence
    // this footnote lost ("Amounts are in today’s dollars.") rendered a
    // typographic apostrophe, so a hand-typed `not.toHaveTextContent("today's
    // dollars")` with an ASCII apostrophe matches nothing and passes whether
    // the sentence is there or not. Exact equality — not `toHaveTextContent`,
    // which is a substring match and would miss an ADDED sentence.
    //
    // Worth the strictness because all three longevity disclosures are
    // required on this surface — fresh draws, flat-nominal income with no
    // COLA, and the unchanged tax return — and the no-COLA clause is pinned
    // nowhere else on this component.
    //
    // Scoped to the footnote `<p>` via a phrase unique to it: the chart below
    // renders a near-identical same-market-histories note, which a page-wide
    // query can resolve to instead.
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    await settledGrid();
    const footnote = screen.getByText(/each comparison re-runs your plan/i);
    expect(footnote.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Each comparison re-runs your plan with only that assumption changed, ' +
        'against the same simulated market histories as the result above, so ' +
        'the difference is the assumption and not luck. The longer-life row ' +
        'matches only up to the original end of your plan: the extra years use ' +
        'fresh market draws, and in those years Social Security and other ' +
        'income simply repeat their last dollar amount with no further ' +
        'cost-of-living increase, so their buying power falls. Those years also ' +
        'keep whichever tax return you were already filing rather than working ' +
        'out a new one. These are illustrations, not forecasts.',
    );
  });

  it('withholds the comparison while the base run is stale or in flight', async () => {
    // A settled result is on screen but the plan moved on, so no pair identity
    // exists: differencing the new input against the old result would publish
    // "new plan + stress - old plan".
    render(
      withTheme(
        'light',
        <PlanStressTestMarketStress vm={comparableVm({ stressPairSignature: null })} />,
      ),
    );
    expect(
      screen.queryByRole('grid', { name: 'Market stress comparison' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/your plan changed/i)).toBeInTheDocument();
    await flushWalk();
    expect(stressPoolRuns).toHaveLength(0);
  });

  it('disposes an IN-FLIGHT walk when the base run changes underneath it, and starts the new one', async () => {
    // The walk must still be running for supersession to mean anything: a
    // finished walk has already disposed itself.
    stressPoolHangs = true;
    const { rerender } = render(
      withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />),
    );
    await waitFor(() => expect(stressPoolRuns.length).toBeGreaterThan(0));
    stressPoolDispose.mockClear();
    stressPoolRuns.length = 0;
    stressPoolHangs = false;
    // Consumed by the NEW walk — the hung one never reached the queue.
    stressSuccessQueue = [0.46, 0.4, 0.42, 0.44];

    // A new settled base run supersedes the comparison on screen.
    rerender(
      withTheme(
        'light',
        <PlanStressTestMarketStress
          vm={comparableVm({ stressPairSignature: 'plan-B::seed-1' })}
        />,
      ),
    );
    expect(stressPoolDispose).toHaveBeenCalled();
    // The table itself is always on screen, so what supersession must clear is
    // its RESULTS: every figure column drops back to the queued placeholder
    // rather than leaving the old plan's deltas standing under the new one.
    const superseded = screen.getByRole('grid', { name: 'Market stress comparison' });
    expect(within(superseded).queryByText('46%')).toBeNull();
    expect(within(superseded).queryByText('-4pp')).toBeNull();
    expect(within(superseded).getAllByText('…')).toHaveLength(4);

    // And the replacement walk must actually run: a walk that was superseded
    // rather than finished used to leave the re-entry guard closed forever,
    // which now costs the new base run its comparison entirely rather than
    // just disabling a button.
    await settledGrid();
    expect(stressPoolRuns).toHaveLength(4);
  });

  it('re-runs against the new sample when Recalculate lands', async () => {
    // Recalculate mints a FRESH seed, and the seed is part of the pair key, so
    // the comparison must re-key onto the new sample. This is the whole reason
    // removing the Compare button is defensible: Recalculate is now the only
    // way to get different numbers, so it had better produce them. Note the
    // signature is UNCHANGED here — same plan, new sample — which the existing
    // supersession test (an edit) does not cover.
    const { rerender } = render(
      withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />),
    );
    const grid = await settledGrid();
    expect(within(grid).getByText('46%')).toBeInTheDocument();
    expect(stressPoolRuns).toHaveLength(4);

    stressPoolRuns.length = 0;
    stressSuccessQueue = [0.3, 0.31, 0.32, 0.33];
    rerender(
      withTheme(
        'light',
        <PlanStressTestMarketStress
          vm={comparableVm({ result: stressSummaryBase({ seed: 2 }) })}
        />,
      ),
    );
    await settledGrid();
    // Four genuinely new runs — the seed-inclusive keys all miss — and the old
    // figures are gone rather than left standing against a sample that no
    // longer exists.
    expect(stressPoolRuns).toHaveLength(4);
    expect(within(grid).getByText('30%')).toBeInTheDocument();
    expect(within(grid).queryByText('46%')).toBeNull();
  });

  it('stands the walk down while the page runs the plan again, and restarts it after', async () => {
    // A Recalculate does NOT change the pair key: the previously settled run is
    // deliberately kept (it is still the summary on screen), so signature, seed
    // and path count are all unchanged until the new sample lands. Without the
    // in-flight flag the obsolete walk kept a worker saturated for the entire
    // Recalculate — competing with the run the user actually asked for, which
    // shards across every other core — and its results were thrown away anyway.
    stressPoolHangs = true;
    const { rerender } = render(
      withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />),
    );
    await waitFor(() => expect(stressPoolRuns.length).toBeGreaterThan(0));
    stressPoolDispose.mockClear();

    // The user presses Recalculate. Same plan, same pair key, primary running.
    rerender(
      withTheme(
        'light',
        <PlanStressTestMarketStress vm={comparableVm({ isRunning: true })} />,
      ),
    );
    expect(stressPoolDispose).toHaveBeenCalled();
    // No bar for a walk that no longer exists.
    expect(
      screen.queryByRole('progressbar', {
        name: 'Comparing market stresses: 0 of 4 done',
      }),
    ).toBeNull();
    stressPoolRuns.length = 0;
    stressPoolHangs = false;
    await flushWalk();
    expect(stressPoolRuns).toHaveLength(0);

    // The new sample lands: a fresh comparison starts against it.
    stressSuccessQueue = [0.46, 0.4, 0.42, 0.44];
    rerender(
      withTheme(
        'light',
        <PlanStressTestMarketStress
          vm={comparableVm({ result: stressSummaryBase({ seed: 2 }) })}
        />,
      ),
    );
    await settledGrid();
    expect(stressPoolRuns).toHaveLength(4);
  });

  it('keeps focus on the retry button and announces what it started', async () => {
    // The only control on this surface. Unmounting it the instant the retry
    // began dropped keyboard focus to `document.body` at the exact moment the
    // user acted — and with the automatic path deliberately silent, nothing
    // told them anything had happened.
    stressPoolFails = true;
    stressPoolHangs = false;
    const user = userEvent.setup();
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    const grid = await settledGrid();
    expect(await within(grid).findAllByText('Unavailable')).toHaveLength(4);

    const retry = screen.getByRole('button', {
      name: 'Try the market stress comparison again',
    });
    retry.focus();
    // Park the retry mid-walk so the in-flight state is observable at all.
    stressPoolFails = false;
    stressPoolProgressTick = { done: 10, total: 100, parkFromRun: 1 };
    await user.click(retry);

    expect(retry).toBeInTheDocument();
    expect(retry).toHaveFocus();
    expect(retry).toBeDisabled();
    // A retry IS user-initiated, so unlike the automatic walk its outcome is
    // announced — that is what the user is waiting for.
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Retrying the market stress comparison.',
    );
  });

  it('has no a11y violations once the comparison has resolved', async () => {
    const { container } = render(
      withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />),
    );
    await settledGrid();
    await expectNoA11yViolations(container);
  });

  it('explains itself when the cash balance plan does not validate, instead of rendering nothing', async () => {
    // The page renders this surface's "Compare against market stresses"
    // heading for every scenario that has accounts, so returning `null` here
    // left a bordered section with a heading and no content and no reason —
    // and that state is reachable (the fan chart shows its cash-balance
    // remediation banner in exactly the same case).
    render(
      withTheme(
        'light',
        <PlanStressTestMarketStress
          vm={comparableVm({
            cbpValidation: {
              ok: false,
              unconfigured: ['acct-1'],
              annuityMissingStream: [],
              annuityDuplicateStream: [],
            },
          })}
        />,
      ),
    );
    expect(
      screen.getByText(/finish setting up the cash balance plan/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('grid', { name: 'Market stress comparison' }),
    ).not.toBeInTheDocument();
    // The hook is called ABOVE this early return — rules of hooks — so nothing
    // about rendering a one-line explanation stops it arming. Only withholding
    // its INPUT does. Unflushed, this assertion could not fail; flushed, it
    // failed with four dispatched runs behind a panel showing no table at all.
    await flushWalk();
    expect(stressPoolRuns).toHaveLength(0);
    expect(stressPoolCreated).toBe(0);
  });

  it('places the plot selector ABOVE the fan it controls', async () => {
    // Rendering the selector below meant picking a case inserted a full-height
    // chart above the control the user was operating, pushing it down the
    // viewport out from under their pointer and focus.
    const user = userEvent.setup();
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    const selector = await screen.findByRole('radiogroup', {
      name: 'Plot a stressed outcome band',
    });
    await user.click(await screen.findByRole('radio', { name: 'Higher fees' }));
    const fan = await screen.findByRole('region', {
      name: 'Outcomes with higher fees',
    });
    // The fan must come AFTER the selector in document order.
    expect(
      selector.compareDocumentPosition(fan) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('qualifies a plotted LONGER-LIFE fan, and leaves a same-horizon fan unqualified', async () => {
    // The case-id → `extendsHorizon` wiring is what carries the longevity
    // approximation disclosure onto the plotted fan. The chart itself
    // is tested with the flag passed in directly, so without this the mapping
    // could be inverted — or narrowed to just `longerLife` — and every other
    // test would still pass while the fan silently claimed the same simulated
    // market histories all the way to its end.
    const user = userEvent.setup();
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    await user.click(await screen.findByRole('radio', { name: 'Longer life' }));
    await screen.findByRole('region', { name: 'Outcomes with longer life' });
    expect(
      screen.getByText(
        /added years past the original end of your plan use fresh market draws/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/life expectancy markers are left off/i),
    ).toBeInTheDocument();

    // A case that only re-prices the SAME horizon must not carry it.
    await user.click(await screen.findByRole('radio', { name: 'Higher fees' }));
    await screen.findByRole('region', { name: 'Outcomes with higher fees' });
    expect(
      screen.queryByText(/life expectancy markers are left off/i),
    ).not.toBeInTheDocument();
  });

  it('falls back to “No stress plotted” when a re-run shrinks the options out from under the pick, then restores it', async () => {
    // A new base run resets every case to pending, so the selector re-mounts as
    // soon as the FIRST case resolves — offering only "No stress plotted" and
    // "Higher fees" while the pick is still the LAST case. Rendered with the raw
    // pick, React Aria's RadioGroup matches no option and shows NOTHING checked,
    // for the rest of the walk.
    const user = userEvent.setup();
    const { rerender } = render(
      withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />),
    );
    await user.click(await screen.findByRole('radio', { name: 'Longer life' }));
    // The last case has resolved, so the first walk is over and the cache-read
    // queue staged below belongs entirely to the second one.
    await screen.findByRole('region', {
      name: 'Outcomes with longer life',
    });

    // Park the re-run on its SECOND case's cache read: case 1 (Higher fees) has
    // published, cases 2-4 are still pending.
    let releaseCacheRead: (v: null) => void = () => undefined;
    vi.mocked(getCached)
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            releaseCacheRead = resolve;
          }),
      );
    stressSuccessQueue = [0.46, 0.4, 0.42, 0.44];
    rerender(
      withTheme(
        'light',
        <PlanStressTestMarketStress
          vm={comparableVm({ stressPairSignature: 'plan-B::seed-1' })}
        />,
      ),
    );
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(2));
    expect(screen.queryByRole('radio', { name: 'Longer life' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'No stress plotted' })).toBeChecked();
    expect(
      screen.queryByRole('region', { name: 'Outcomes with longer life' }),
    ).toBeNull();

    // The pick itself was never cleared: it comes back with its own option.
    releaseCacheRead(null);
    expect(
      await screen.findByRole('radio', { name: 'Longer life' }),
    ).toBeChecked();
    await screen.findByRole('region', {
      name: 'Outcomes with longer life',
    });
  });
});


// ---------------------------------------------------------------------------
// The comparison's own reliability floor: a wedged worker
// ---------------------------------------------------------------------------

describe('useMarketStressComparison — bounded wait on a hung worker', () => {
  const baseInput = {
    horizonYear: 2070,
    firstYear: 2026,
    monthlyExpenseBase: new Array(24).fill(100),
    ssByYear: new Array(45).fill(0),
    incomeByYear: new Array(45).fill(0),
    accountMcLedger: [],
  } as unknown as PlanStressTestVm['stressBaseInput'];

  beforeEach(() => {
    stressPoolRuns.length = 0;
    stressPoolCreated = 0;
    stressPoolDispose.mockClear();
    stressPoolFails = false;
    stressPoolHangs = false;
    stressPoolProgressTick = null;
    stressPoolOnProgressByRun.length = 0;
    stressCacheHits.clear();
    stressWorkerConstructionThrows = false;
    stressDepletionQueue = [];
  });

  it('clears a case’s progress when it settles, and ignores a straggler tick', async () => {
    // Probed on the VM, not the DOM: the Success cell reads `delta` and the
    // error state BEFORE `progress`, so a settled case that KEPT its last tick
    // renders identically to one that dropped it — every DOM assertion passes
    // either way. Only reading `cases[].progress` can tell them apart, and this
    // is the state a future render change would surface as a frozen bar.
    stressPoolProgressTick = { done: 2500, total: 10_000, parkFromRun: Infinity };
    const { result } = renderHook(() =>
      useMarketStressComparison({
        baseInput,
        baseResult: stressSummaryBase(),
        baseSignature: 'plan-A::seed-1',
        longestLivedBirthYear: 1968,
        baseRunInFlight: false,
      }),
    );

    // The walk starts itself on mount; this just lets it get through.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Every case reported 2,500 paths before resolving; none may still hold it.
    expect(result.current.state).toBe('done');
    expect(result.current.cases).toHaveLength(4);
    expect(result.current.cases.map((c) => c.progress)).toEqual([
      null,
      null,
      null,
      null,
    ]);

  });

  it('ignores a straggler tick for a case that already settled mid-walk', async () => {
    // Parking on the SECOND run leaves the walk alive with case 1 settled — the
    // only state where a late tick reaches the hook's own `state === 'pending'`
    // check. Fire it after the whole walk and `walk.disposed` absorbs it first,
    // so that variant proves nothing about this guard.
    stressPoolProgressTick = { done: 2500, total: 10_000, parkFromRun: 2 };
    const { result } = renderHook(() =>
      useMarketStressComparison({
        baseInput,
        baseResult: stressSummaryBase(),
        baseSignature: 'plan-A::seed-1',
        longestLivedBirthYear: 1968,
        baseRunInFlight: false,
      }),
    );

    // The walk starts itself on mount; this just lets it get through.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Case 1 resolved; case 2 is on the worker and holding its bar.
    expect(result.current.state).toBe('running');
    expect(result.current.cases[0].state).toBe('ready');
    expect(result.current.cases[0].progress).toBeNull();
    expect(result.current.cases[1].progress).toEqual({ done: 2500, total: 10_000 });

    // Case 1's own callback fires late. It must not re-open a finished case.
    act(() => stressPoolOnProgressByRun[0](9_000, 10_000));
    expect(result.current.cases[0].progress).toBeNull();
    expect(result.current.cases[0].state).toBe('ready');
  });

  it('reports the in-flight case’s path progress while it runs', async () => {
    // The positive half of the pair above: a case ON the worker must actually
    // carry its tick, or "clears on settle" would pass against a hook that
    // never published progress at all.
    stressPoolProgressTick = { done: 2500, total: 10_000, parkFromRun: 1 };
    const { result } = renderHook(() =>
      useMarketStressComparison({
        baseInput,
        baseResult: stressSummaryBase(),
        baseSignature: 'plan-A::seed-1',
        longestLivedBirthYear: 1968,
        baseRunInFlight: false,
      }),
    );

    // The walk starts itself on mount; this just lets it get through.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.cases[0].progress).toEqual({ done: 2500, total: 10_000 });
    // Sequential walk: the three still queued have nothing to show.
    expect(result.current.cases.slice(1).every((c) => c.progress === null)).toBe(true);
  });

  it('settles every case as unavailable when the worker pool cannot be built, and allows a retry', async () => {
    // `createMcPool` constructs its worker eagerly, so a browser that refuses
    // to spawn one throws at the first case that misses the cache. Every case
    // must then settle as unavailable — none may be left on "Comparing…" for
    // the life of the page with no walk to time out — and the failure is
    // recorded ONCE for the comparison, not once per case retrying a
    // constructor already known to throw.
    stressWorkerConstructionThrows = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { result } = renderHook(() =>
        useMarketStressComparison({
          baseInput,
          baseResult: stressSummaryBase(),
          baseSignature: 'plan-A::seed-1',
          longestLivedBirthYear: 1968,
          baseRunInFlight: false,
        }),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(result.current.state).toBe('done');
      expect(result.current.cases).toHaveLength(4);
      expect(result.current.cases.every((c) => c.state === 'error')).toBe(true);
      expect(result.current.completed).toBe(4);
      expect(warn).toHaveBeenCalledTimes(1);

      // A retry is still possible: no walk was ever armed, so `run()` (with a
      // browser that will spawn the worker) starts normally.
      stressWorkerConstructionThrows = false;
      await act(async () => {
        result.current.run();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(stressPoolRuns.length).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('settles every case as unavailable instead of comparing forever', async () => {
    // This surface has no Cancel button of its own, so a worker that never
    // posts back used to leave it "Comparing…" for the life of the page.
    stressPoolHangs = true;
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useMarketStressComparison({
          baseInput,
          baseResult: stressSummaryBase(),
          baseSignature: 'plan-A::seed-1',
          longestLivedBirthYear: 1968,
          baseRunInFlight: false,
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STRESS_CASE_TIMEOUT_MS + 1);
      });
      expect(result.current.state).toBe('done');
      expect(result.current.cases).toHaveLength(4);
      expect(result.current.cases.every((c) => c.state === 'error')).toBe(true);
      // The presumed-wedged pool is released, not stranded.
      expect(stressPoolDispose).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never queues a case onto a pool disposed while its cache read was in flight', async () => {
    // `runStressCase` awaits a hash and an IndexedDB read before it touches the
    // pool. If the pair key changes in that window the pool is already
    // terminated, `pump()` returns early, and the queued task's promise NEVER
    // settles — pinning the case's `Promise.race` and the whole stressed input
    // (including its Float64Array ledger) until the 5-minute timeout fires.
    let releaseCacheRead: (v: null) => void = () => undefined;
    vi.mocked(getCached)
      .mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            releaseCacheRead = resolve;
          }),
      )
      // The plan-B comparison starts on its OWN the moment the signature
      // changes, so park it on its first cache read too. Without this the
      // dispatches it legitimately makes would swamp the assertion below, and
      // the abandoned plan-A case — the only thing this test is about — could
      // reach the pool unnoticed.
      .mockImplementationOnce(() => new Promise<null>(() => {}));
    const { rerender } = renderHook(
      (props: { signature: string }) =>
        useMarketStressComparison({
          baseInput,
          baseResult: stressSummaryBase(),
          baseSignature: props.signature,
          longestLivedBirthYear: 1968,
          baseRunInFlight: false,
        }),
      { initialProps: { signature: 'plan-A::seed-1' } },
    );
    await act(async () => {
      // Let the walk get past `computeCacheKey` and actually PARK on the cache
      // read — otherwise it would still be parked on the hash and the race this
      // test exists for would never be entered.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(getCached)).toHaveBeenCalled();
    expect(stressPoolRuns).toHaveLength(0);

    // The walk is parked on the cache read; the plan changes underneath it.
    rerender({ signature: 'plan-B::seed-1' });
    // There is nothing to dispose, and that is the point: the pool is built on
    // the first case to MISS the cache, so a walk abandoned during its cache
    // read never spawned a worker to strand in the first place.
    expect(stressPoolCreated).toBe(0);
    expect(stressPoolDispose).not.toHaveBeenCalled();

    await act(async () => {
      releaseCacheRead(null);
      // Let the parked walk resume fully: a macrotask flush drains every
      // microtask the resumed `runStressCase` would queue on its way to
      // `pool.run`.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(stressPoolRuns).toHaveLength(0);
  });
});
