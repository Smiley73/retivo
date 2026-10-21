/**
 * The Compare tab's "Plan success" row on the demo dataset (Base > {Retire
 * early at 62 > Funds Run Out, Delay — work to 70}). The viewed side is driven
 * through the stress view model override (the real provider settles to
 * `isRunning: false` in jsdom), the comparison side through a pre-seeded Monte
 * Carlo cache entry, so no test waits on a real simulation. The hook's own
 * lifecycle (start gate, abort, retry, equal keys) is pinned in
 * `monte-carlo/use-compare-stress.test.ts`.
 */
import 'fake-indexeddb/auto';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import {
  clearAllStores,
  listAggregates,
  putAggregate,
  writeSelectedScenario,
} from '../db/store';
import { clearMonteCarloCache, mcCacheKey, putCached } from '../db/monte-carlo-cache';
import type { Aggregate, ScenarioOverrides, ScenarioPayload } from '../db/types';
import { loadDemoData } from '../lib/demo-data-loader';
import type { MonteCarloSummary } from '../lib/monte-carlo';
import {
  buildMonteCarloInputForScenario,
  MC_PATH_COUNT,
  type ScenarioMcInputs,
} from '../lib/monte-carlo-scenario-input';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import { MonteCarloProvider } from '../monte-carlo/MonteCarloProvider';
import { fakeSummary } from '../monte-carlo/fake-worker.test-harness';
import { expectNoA11yViolations } from '../test/a11y';
import { withTheme } from '../test/theme-render';
import { BalanceProjectionPage } from './BalanceProjectionPage';

// The page's stress view model, overridden field by field. `null` passes the
// real hook's value through.
const stressVmOverride = vi.hoisted<{
  value: Partial<import('../components/PlanStressTestSection').PlanStressTestVm> | null;
}>(() => ({ value: null }));
vi.mock('../components/PlanStressTestSection', async () => {
  const actual = await vi.importActual<typeof import('../components/PlanStressTestSection')>(
    '../components/PlanStressTestSection',
  );
  return {
    ...actual,
    usePlanStressTestVm: (...args: Parameters<typeof actual.usePlanStressTestVm>) => {
      const real = actual.usePlanStressTestVm(...args);
      return stressVmOverride.value ? { ...real, ...stressVmOverride.value } : real;
    },
  };
});

const BASE = 'demo-scenario-base';
const EARLY = 'demo-scenario-early';
const WAIT = { timeout: 10_000 };

const summaryAt = (successProbability: number): MonteCarloSummary => ({
  ...fakeSummary(1),
  successProbability,
  pathCount: MC_PATH_COUNT,
});

/** The viewed side as the page reports it once its run settled for the plan on screen. */
const settled = (successProbability: number) => ({
  isRunning: false,
  error: null,
  stressPairSignature: 'settled-signature',
  result: summaryAt(successProbability),
  progressDone: 0,
  progressTotal: 0,
});

/** A result is on screen, but no completed run for this plan produced it. */
const unsettled = {
  isRunning: false,
  error: null,
  stressPairSignature: null,
  result: summaryAt(0.97),
  progressDone: 0,
  progressTotal: 0,
};

async function cacheFor(scenarioId: string, successProbability: number): Promise<void> {
  const now = new Date();
  async function list<T>(type: string): Promise<T[]> {
    return (await listAggregates(type as never)) as T[];
  }
  const inputs: ScenarioMcInputs = {
    members: await list('householdMember'),
    accounts: await list('account'),
    balances: await list('accountBalance'),
    expenses: await list('expense'),
    incomeStreams: await list('incomeStream'),
    ssBenefits: await list('socialSecurityBenefit'),
    categories: await list('expenseCategory'),
  };
  const input = buildMonteCarloInputForScenario({
    scenarioId,
    scenarios: await list<ScenarioAggregate>('scenario'),
    inputs,
    todayYear: now.getFullYear(),
    todayMonthIndex: now.getMonth(),
  })!;
  await putCached(await mcCacheKey(input), summaryAt(successProbability));
}

async function seedChild(
  id: string,
  parentId: string,
  overrides: ScenarioOverrides,
): Promise<void> {
  const parent = (await listAggregates('scenario')).find((s) => s.id === parentId)!;
  await putAggregate('scenario', {
    ...parent,
    id,
    payload: {
      ...(parent.payload as ScenarioPayload),
      name: id,
      parentScenarioId: parentId,
      isPrimary: false,
      overrides,
    },
  } as Aggregate<ScenarioPayload>);
}

function pageElement(withId?: string): React.ReactElement {
  const search = withId ? `&with=${withId}` : '';
  return withTheme(
    'light',
    <MemoryRouter initialEntries={[`/balance-projection?view=compare${search}`]}>
      <MonteCarloProvider>
        <BalanceProjectionPage />
      </MonteCarloProvider>
    </MemoryRouter>,
  );
}

async function renderCompare(viewed: string, withId?: string) {
  await writeSelectedScenario({ scenarioId: viewed, updatedAt: new Date().toISOString() });
  const view = render(pageElement(withId));
  const panel = await screen.findByRole('region', { name: 'Compare scenarios' }, WAIT);
  return { panel, rerender: () => view.rerender(pageElement(withId)) };
}

async function findRow(panel: HTMLElement): Promise<HTMLElement> {
  return within(panel).findByRole('region', { name: 'Plan success' }, WAIT);
}

/** The row's figures by label: viewed name, comparison name, Difference. */
function figures(row: HTMLElement): Record<string, string> {
  return Object.fromEntries(
    [...row.querySelectorAll('dl > div')].map((d) => [
      d.querySelector('dt')!.textContent!,
      d.querySelector('dd')!.textContent!,
    ]),
  );
}

describe('Compare tab — Plan success row', () => {
  beforeEach(async () => {
    await clearAllStores();
    await clearMonteCarloCache();
    window.localStorage.clear();
    stressVmOverride.value = null;
    await loadDemoData({ householdId: 'hh-test', email: 'demo@example.test', displayName: 'Demo User' });
  });
  afterEach(async () => {
    cleanup();
    stressVmOverride.value = null;
    await clearAllStores();
    await clearMonteCarloCache();
    window.localStorage.clear();
  });

  it('shows the planned headline immediately and keeps the row pending, with no number, until the pair settles', async () => {
    stressVmOverride.value = { ...unsettled };
    await cacheFor(BASE, 0.8);
    const { panel, rerender } = await renderCompare(EARLY, BASE);
    // Ending balance and run-out year never wait on the stress test.
    await within(panel).findByRole('row', { name: /Ending balance at the horizon/ }, WAIT);
    expect(within(panel).getByRole('row', { name: /Year money runs out/ })).toBeInTheDocument();

    const row = await findRow(panel);
    await waitFor(() => expect(figures(row).Base).toBe('80%'), WAIT);
    const pending = row.querySelector('dl')!;
    expect(pending).toHaveAttribute('aria-busy', 'true');
    expect(pending).toHaveClass('opacity-50');
    // A result is on screen (97%) but is not the settled pair for this plan, so
    // it must not be painted; the comparison's own cached value is fine.
    expect(figures(row)).toEqual({
      'Retire early at 62': '—',
      Base: '80%',
      Difference: '—',
    });
    expect(row.textContent).not.toContain('97%');
    expect(within(row).getByRole('progressbar', { name: /Stress test for Retire early at 62/ })).toBeInTheDocument();
    await expectNoA11yViolations(panel);

    stressVmOverride.value = { ...settled(0.9) };
    rerender();
    await waitFor(() => expect(figures(row)['Retire early at 62']).toBe('90%'), WAIT);
    expect(row.querySelector('dl')).toHaveAttribute('aria-busy', 'false');

    // An edit returns it to pending.
    stressVmOverride.value = { ...unsettled };
    rerender();
    await waitFor(() => expect(figures(row)['Retire early at 62']).toBe('—'), WAIT);
    expect(row.querySelector('dl')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows the page progress for the viewed side while its run is in flight', async () => {
    stressVmOverride.value = {
      ...unsettled,
      result: null,
      isRunning: true,
      progressDone: 3_000,
      progressTotal: 10_000,
    };
    await cacheFor(BASE, 0.8);
    const { panel } = await renderCompare(EARLY, BASE);
    const row = await findRow(panel);
    expect(
      within(row).getByRole('progressbar', { name: /Stress test for Retire early at 62: 3,000 of 10,000 paths/ }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(panel);
  });

  it('reads two noise-sized results as about the same, with the sampling-noise reason', async () => {
    stressVmOverride.value = { ...settled(0.9) };
    await cacheFor(BASE, 0.903);
    const { panel } = await renderCompare(EARLY, BASE);
    const row = await findRow(panel);
    await waitFor(() => expect(figures(row).Base).toBe('90%'), WAIT);
    expect(figures(row)).toEqual({
      'Retire early at 62': '90%',
      Base: '90%',
      Difference: 'About the same',
    });
    expect(within(row).getByText(/sampling noise/)).toBeInTheDocument();
    expect(row.querySelector('dl')).toHaveAttribute('aria-busy', 'false');
    await expectNoA11yViolations(panel);
  });

  it('reads a signal-sized gap as a glyph plus a direction word, in either direction', async () => {
    stressVmOverride.value = { ...settled(0.9) };
    await cacheFor(BASE, 0.8);
    const { panel } = await renderCompare(EARLY, BASE);
    const row = await findRow(panel);
    await waitFor(() => expect(figures(row).Difference).toBe('+10pp higher'), WAIT);
    expect(figures(row)['Retire early at 62']).toBe('90%');
    expect(figures(row).Base).toBe('80%');
    const classes = [...row.querySelectorAll('*')].map((e) => e.getAttribute('class') ?? '').join(' ');
    expect(classes).not.toMatch(/success|danger|error|warning|positive|negative|green|red/);
    cleanup();

    stressVmOverride.value = { ...settled(0.7) };
    const second = await renderCompare(EARLY, BASE);
    const lower = await findRow(second.panel);
    await waitFor(() => expect(figures(lower).Difference).toBe('−10pp lower'), WAIT);
  });

  it('keeps the row for a child whose planned results are identical but whose stress test differs', async () => {
    const guardrails = { enabled: true, lowerBandPct: 85, upperBandPct: 115, stepPct: 10, maxRaisePct: 100 };
    await seedChild('guardrails-child', BASE, { downturnGuardrails: guardrails });
    stressVmOverride.value = { ...settled(0.9) };
    const { panel } = await renderCompare('guardrails-child', BASE);
    await within(panel).findByText(/The Planned projections of .* are identical/, undefined, WAIT);
    expect(within(panel).queryByRole('row')).toBeNull();
    const row = await findRow(panel);
    expect(row).toBeInTheDocument();
    expect(within(panel).getByText(/can still differ/)).toBeInTheDocument();
  });

  it('shows no row, and says the stress tests match, for a child identical on both counts', async () => {
    await seedChild('plain-child', BASE, {});
    stressVmOverride.value = { ...settled(0.9) };
    const { panel } = await renderCompare('plain-child', BASE);
    await within(panel).findByText(/Their stress tests use the same inputs too/, undefined, WAIT);
    expect(within(panel).queryByRole('region', { name: 'Plan success' })).toBeNull();
  });

  it('points at the page controls when the viewed run failed, without a second retry button', async () => {
    stressVmOverride.value = { ...unsettled, result: null, error: 'worker crashed' };
    await cacheFor(BASE, 0.8);
    const { panel } = await renderCompare(EARLY, BASE);
    const row = await findRow(panel);
    await waitFor(() => expect(figures(row).Base).toBe('80%'), WAIT);
    expect(figures(row)['Retire early at 62']).toBe('—');
    expect(within(row).getByText(/Use Try again in the stress test controls/)).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
