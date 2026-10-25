/** Market-stress comparison tests: the card surface and the comparison hook, which share one mocked worker pool and MC cache. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PlanStressTestVm } from './PlanStressTestSection';
import { PlanStressTestMarketStress } from './PlanStressTestCards';
import { vm, summary as stressSummaryBase } from './__fixtures__/plan-stress-test-vm';
import { useMarketStressComparison } from './plan-market-stress-comparison';
import { STRESS_CASE_IDS, type StressCaseId } from '../lib/market-stress';
import type { MonteCarloSummary } from '../lib/monte-carlo-types';
import { getCached, putCached } from '../db/monte-carlo-cache';
import { expectNoA11yViolations } from '../test/a11y';
import { withTheme } from '../test/theme-render';

// The automatic walk builds one size-1 worker pool lazily on the first cache miss, so mock the pool and the MC cache
// (no IndexedDB, no real Worker). Each run resolves with a per-case summary from the staged success probabilities.
const stressPoolRuns: unknown[] = [];
let stressSuccessQueue: number[] = [];
// Per-case median depletion year, in `STRESS_CASE_IDS` order.
let stressDepletionQueue: (number | null)[] = [];
let stressPoolFails = false;
// A wedged worker: `run()` never settles, so only the hook's own timeout can end the walk.
let stressPoolHangs = false;
// Path-level tick reported through `onProgress` before anything else; runs park from the `parkFromRun`-th on
// (`Infinity` = always resolve), which leaves an earlier case settled while the walk is alive.
let stressPoolProgressTick:
  | { done: number; total: number; parkFromRun: number }
  | null = null;
const stressPoolOnProgressByRun: ((done: number, total: number) => void)[] = [];
// `createMcPool` constructs its worker eagerly, so a constructor throw escapes pool creation; the mock calls the
// factory the way the real pool does.
let stressWorkerConstructionThrows = false;
const stressPoolDispose = vi.fn();
// Pools built so far: tells "built and idle" from "never built", which a dispatch count cannot.
let stressPoolCreated = 0;
vi.mock('../monte-carlo/mc-worker-pool', () => ({
  createMcPool: (opts: { factory: () => unknown }) => {
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
          // `stressSummaryBase` is a factory: spreading the function itself yields no fields.
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
const stressCacheHits = new Map<StressCaseId, MonteCarloSummary>();
vi.mock('../db/monte-carlo-cache', () => ({
  // The key only needs to differ per case; `longerLife` pulls no lever, so it is the fallthrough.
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

describe('PlanStressTestMarketStress — same-path stress comparison', () => {
  function comparableVm(
    overrides: Partial<PlanStressTestVm> = {},
  ): PlanStressTestVm {
    return vm({
      stressBaseInput: {
        horizonYear: 2070,
        firstYear: 2026,
        // The longevity stress pads every horizon-length series, so the fake input needs these four.
        monthlyExpenseBase: new Array(24).fill(100),
        ssByYear: new Array(45).fill(0),
        incomeByYear: new Array(45).fill(0),
        accountMcLedger: [],
      } as unknown as PlanStressTestVm['stressBaseInput'],
      stressPairSignature: 'plan-A::seed-1',
      // 1968 + 105 = 2073 lands the age-105 cap between the base horizon (2070) and the uncapped +5 extension (2075).
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

  // Dispatch sits behind an awaited cache key, so every "nothing was dispatched" assertion must flush first or it cannot fail.
  async function flushWalk(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  // No ellipsis left means every row has resolved; the table is on screen from the first paint.
  async function settledGrid(): Promise<HTMLElement> {
    const grid = await screen.findByRole('grid', {
      name: 'Market stress comparison',
    });
    await waitFor(() => expect(within(grid).queryByText('…')).toBeNull());
    return grid;
  }

  it('withholds the comparison until a base run is available', async () => {
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
    expect(
      screen.queryByRole('grid', { name: 'Market stress comparison' }),
    ).not.toBeInTheDocument();
    await flushWalk();
    expect(stressPoolRuns).toHaveLength(0);
    expect(stressPoolCreated).toBe(0);
  });

  it('names the missing birthdate instead of asking for a stress test that cannot fix it', async () => {
    // Reachable with a settled base run: a member imported with birthdate "1968" yields no birth year.
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
    for (const name of [
      'Higher fees',
      'Lower returns',
      'Higher inflation',
      'Longer life',
    ]) {
      expect(await within(grid).findByText(name)).toBeInTheDocument();
    }
    expect(
      within(grid).getByText(/investment cost 0\.5% a year higher/i),
    ).toBeInTheDocument();
    expect(await within(grid).findByText('-4pp')).toBeInTheDocument();
    expect(await within(grid).findByText('-10pp')).toBeInTheDocument();
    // Results are written under the market-stress entry class so they stay in their own LRU reserve.
    expect(vi.mocked(putCached)).toHaveBeenCalledTimes(4);
    for (const [key, , entryClass] of vi.mocked(putCached).mock.calls) {
      expect(typeof key).toBe('string');
      expect(entryClass).toBe('marketStress');
    }
  });

  it('lists every stress and what it changes from the first paint, before any case resolves', async () => {
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    const grid = screen.getByRole('grid', { name: 'Market stress comparison' });
    for (const name of ['Higher fees', 'Lower returns', 'Higher inflation', 'Longer life']) {
      expect(within(grid).getByText(name)).toBeInTheDocument();
    }
    // Success separates queued ("…") from idle ("—"); the other two figure columns hold "—" until their row resolves.
    expect(within(grid).getAllByText('…')).toHaveLength(4);
    expect(within(grid).getAllByText('—')).toHaveLength(8);
    expect(screen.queryByRole('button')).toBeNull();
    await settledGrid();
  });

  it('serves a fully cached comparison without dispatching anything to a worker', async () => {
    for (const caseId of STRESS_CASE_IDS) {
      stressCacheHits.set(
        caseId,
        stressSummaryBase({ successProbability: 0.44, medianEndingBalanceReal: 21 }),
      );
    }
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    const grid = screen.getByRole('grid', { name: 'Market stress comparison' });
    expect(await within(grid).findAllByText('44%')).toHaveLength(4);
    // No dispatch, no cache write and no worker constructed; a dispatch count cannot see the last.
    expect(stressPoolRuns).toHaveLength(0);
    expect(stressPoolCreated).toBe(0);
    expect(vi.mocked(putCached)).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryAllByRole('progressbar')).toHaveLength(0));
  });

  it('shows cached answers even when the browser refuses to spawn a worker', async () => {
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
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps cached answers and marks only the misses unavailable when the worker fails', async () => {
    stressCacheHits.set('higherFees', stressSummaryBase({ successProbability: 0.44 }));
    stressWorkerConstructionThrows = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
      const grid = await settledGrid();
      expect(within(grid).getByText('44%')).toBeInTheDocument();
      expect(within(grid).getAllByText('Unavailable')).toHaveLength(3);
      // Logged once for the comparison, not once per case.
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('runs only the cases the cache does not already hold', async () => {
    stressCacheHits.set('higherFees', stressSummaryBase({ successProbability: 0.44 }));
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    const grid = await settledGrid();
    expect(within(grid).getByText('44%')).toBeInTheDocument();
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
    stressPoolProgressTick = { done: 2500, total: 10_000, parkFromRun: 1 };
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    expect(
      await screen.findByRole('progressbar', {
        name: 'Comparing market stresses: 0 of 4 done',
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('progressbar', {
        name: 'Comparing Higher fees: 2,500 of 10,000 paths',
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  });

  it('leaves no bar behind once every case has settled', async () => {
    stressPoolProgressTick = { done: 2500, total: 10_000, parkFromRun: Infinity };
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    const grid = await settledGrid();
    await within(grid).findByText('46%');
    await waitFor(() => expect(screen.queryAllByRole('progressbar')).toHaveLength(0));
  });

  it('has no a11y violations while the comparison is running', async () => {
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
    stressPoolProgressTick = { done: 2500, total: 10_000, parkFromRun: 1 };
    const { container } = render(
      withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />),
    );
    await screen.findByRole('progressbar', {
      name: 'Comparing market stresses: 0 of 4 done',
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(
      screen.getByRole('region', { name: 'Market stress comparison' }),
    ).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('survives StrictMode’s double-invoke with one live walk and an honest running state', async () => {
    // StrictMode runs every effect twice and the second walk shares the first's pair key, so the first's exit must not
    // publish `walking: false` over it.
    stressPoolProgressTick = { done: 2500, total: 10_000, parkFromRun: 1 };
    render(
      <StrictMode>
        {withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />)}
      </StrictMode>,
    );
    await waitFor(() => expect(stressPoolRuns).toHaveLength(1));
    const bar = await screen.findByRole('progressbar', {
      name: 'Comparing market stresses: 0 of 4 done',
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(bar).toBeInTheDocument();
    expect(stressPoolRuns).toHaveLength(1);
  });

  it('drops aria-busy once every case has settled', async () => {
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

  it('names the age the last survivor reaches, not the cap anchor’s', async () => {
    // The cap anchors on the youngest member (1978) but the horizon belongs to the older survivor (1968): 2075 - 1968 = 107.
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
    expect(within(grid).queryByText(/age 97/)).toBeNull();
  });

  it('states the longevity age without a name when both members reach the horizon', async () => {
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

  it('pairs every stress run to the displayed base run seed and path count', async () => {
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
    // Capped (2073) and uncapped (2075) differ, so the assertion sees whether the cap ran.
    const longerLife = (stressPoolRuns as { horizonYear: number }[])[3];
    expect(longerLife.horizonYear).toBe(2073);
  });

  it('extends the full five years when the age-105 cap does not bind', async () => {
    render(
      withTheme(
        'light',
        <PlanStressTestMarketStress vm={comparableVm({ longestLivedBirthYear: 1990 })} />,
      ),
    );
    await settledGrid();
    const longerLife = (stressPoolRuns as { horizonYear: number }[])[3];
    expect(longerLife.horizonYear).toBe(2075);
  });

  it('marks a failed case Unavailable and offers the one retry worth offering', async () => {
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
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  });

  it('disposes the worker pool once the walk finishes (no leaked worker)', async () => {
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    await settledGrid();
    await waitFor(() => expect(stressPoolDispose).toHaveBeenCalled());
  });

  it('labels the depletion column as a median-path statistic, not a whole-plan promise', async () => {
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

  it('reads a depleting base run as sooner / unchanged / later, in that direction', async () => {
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
    expect(await rowFor('Higher fees')).toContain('2058 (6 yr sooner)');
    expect(await rowFor('Lower returns')).toContain('2064 (unchanged)');
    expect(await rowFor('Higher inflation')).toContain(
      '2070 (6 yr later)',
    );
  });

  it('renders exactly the five comparison columns, in order', async () => {
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

  it('shows the success change as the difference between the two displayed percentages', async () => {
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
    // Exact equality, not a substring match, so an added sentence fails; scoped by a phrase unique to the footnote
    // because the chart below renders a near-identical note.
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

  it('disposes an in-flight walk when the base run changes underneath it, and starts the new one', async () => {
    stressPoolHangs = true;
    const { rerender } = render(
      withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />),
    );
    await waitFor(() => expect(stressPoolRuns.length).toBeGreaterThan(0));
    stressPoolDispose.mockClear();
    stressPoolRuns.length = 0;
    stressPoolHangs = false;
    stressSuccessQueue = [0.46, 0.4, 0.42, 0.44];

    rerender(
      withTheme(
        'light',
        <PlanStressTestMarketStress
          vm={comparableVm({ stressPairSignature: 'plan-B::seed-1' })}
        />,
      ),
    );
    expect(stressPoolDispose).toHaveBeenCalled();
    const superseded = screen.getByRole('grid', { name: 'Market stress comparison' });
    expect(within(superseded).queryByText('46%')).toBeNull();
    expect(within(superseded).queryByText('-4pp')).toBeNull();
    expect(within(superseded).getAllByText('…')).toHaveLength(4);

    await settledGrid();
    expect(stressPoolRuns).toHaveLength(4);
  });

  it('re-runs against the new sample when Recalculate lands', async () => {
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
    expect(stressPoolRuns).toHaveLength(4);
    expect(within(grid).getByText('30%')).toBeInTheDocument();
    expect(within(grid).queryByText('46%')).toBeNull();
  });

  it('stands the walk down while the page runs the plan again, and restarts it after', async () => {
    stressPoolHangs = true;
    const { rerender } = render(
      withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />),
    );
    await waitFor(() => expect(stressPoolRuns.length).toBeGreaterThan(0));
    stressPoolDispose.mockClear();

    rerender(
      withTheme(
        'light',
        <PlanStressTestMarketStress vm={comparableVm({ isRunning: true })} />,
      ),
    );
    expect(stressPoolDispose).toHaveBeenCalled();
    expect(
      screen.queryByRole('progressbar', {
        name: 'Comparing market stresses: 0 of 4 done',
      }),
    ).toBeNull();
    stressPoolRuns.length = 0;
    stressPoolHangs = false;
    await flushWalk();
    expect(stressPoolRuns).toHaveLength(0);

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
    stressPoolFails = false;
    stressPoolProgressTick = { done: 10, total: 100, parkFromRun: 1 };
    await user.click(retry);

    expect(retry).toBeInTheDocument();
    expect(retry).toHaveFocus();
    expect(retry).toBeDisabled();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Retrying the market stress comparison.',
    );
  });

  it('explains itself when the cash balance plan does not validate, instead of rendering nothing', async () => {
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
    // The hook runs above this early return, so only withholding its input stops it arming; flush first or this cannot fail.
    await flushWalk();
    expect(stressPoolRuns).toHaveLength(0);
    expect(stressPoolCreated).toBe(0);
  });

  it('places the plot selector above the fan it controls', async () => {
    const user = userEvent.setup();
    render(withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />));
    const selector = await screen.findByRole('radiogroup', {
      name: 'Plot a stressed outcome band',
    });
    await user.click(await screen.findByRole('radio', { name: 'Higher fees' }));
    const fan = await screen.findByRole('region', {
      name: 'Outcomes with higher fees',
    });
    expect(
      selector.compareDocumentPosition(fan) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('qualifies a plotted longer-life fan, and leaves a same-horizon fan unqualified', async () => {
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

    await user.click(await screen.findByRole('radio', { name: 'Higher fees' }));
    await screen.findByRole('region', { name: 'Outcomes with higher fees' });
    expect(
      screen.queryByText(/life expectancy markers are left off/i),
    ).not.toBeInTheDocument();
  });

  it('falls back to “No stress plotted” when a re-run shrinks the options out from under the pick, then restores it', async () => {
    // A re-run resets every case to pending, so the options shrink to the first resolved case while the pick is the last;
    // the raw pick would leave nothing checked.
    const user = userEvent.setup();
    const { rerender } = render(
      withTheme('light', <PlanStressTestMarketStress vm={comparableVm()} />),
    );
    await user.click(await screen.findByRole('radio', { name: 'Longer life' }));
    await screen.findByRole('region', {
      name: 'Outcomes with longer life',
    });

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

    releaseCacheRead(null);
    expect(
      await screen.findByRole('radio', { name: 'Longer life' }),
    ).toBeChecked();
    await screen.findByRole('region', {
      name: 'Outcomes with longer life',
    });
  });
});
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
    // Probed on the VM: the Success cell reads `delta` and the error state before `progress`, so no DOM assertion can tell a kept tick from a dropped one.
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

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

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
    // Parking on the second run leaves case 1 settled with the walk alive: the only state where a late tick reaches the hook's own guard.
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

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.state).toBe('running');
    expect(result.current.cases[0].state).toBe('ready');
    expect(result.current.cases[0].progress).toBeNull();
    expect(result.current.cases[1].progress).toEqual({ done: 2500, total: 10_000 });

    act(() => stressPoolOnProgressByRun[0](9_000, 10_000));
    expect(result.current.cases[0].progress).toBeNull();
    expect(result.current.cases[0].state).toBe('ready');
  });

  it('reports the in-flight case’s path progress while it runs', async () => {
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

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.cases[0].progress).toEqual({ done: 2500, total: 10_000 });
    expect(result.current.cases.slice(1).every((c) => c.progress === null)).toBe(true);
  });

  it('settles every case as unavailable when the worker pool cannot be built, and allows a retry', async () => {
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
        await vi.advanceTimersByTimeAsync(600_000);
      });
      expect(result.current.state).toBe('done');
      expect(result.current.cases).toHaveLength(4);
      expect(result.current.cases.every((c) => c.state === 'error')).toBe(true);
      expect(stressPoolDispose).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never queues a case onto a pool disposed while its cache read was in flight', async () => {
    // A case queued onto a pool disposed during its cache read would never settle, pinning the stressed input until the timeout.
    let releaseCacheRead: (v: null) => void = () => undefined;
    vi.mocked(getCached)
      .mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            releaseCacheRead = resolve;
          }),
      )
      // The plan-B comparison starts on its own; park it on its first cache read too or its dispatches swamp the assertion.
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
      // Let the walk get past the hash and park on the cache read, or the race is never entered.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(vi.mocked(getCached)).toHaveBeenCalled();
    expect(stressPoolRuns).toHaveLength(0);

    rerender({ signature: 'plan-B::seed-1' });
    // The pool is built on the first cache miss, so a walk abandoned during its cache read never spawned a worker.
    expect(stressPoolCreated).toBe(0);
    expect(stressPoolDispose).not.toHaveBeenCalled();

    await act(async () => {
      releaseCacheRead(null);
      // A macrotask flush drains every microtask the resumed case queues on its way to `pool.run`.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(stressPoolRuns).toHaveLength(0);
  });
});
