/**
 * RothSuggestionPanel tests. The `?worker` module is mocked by a fake Worker
 * class that records what the page sends and lets a test post progress, then
 * hold the terminal reply until it chooses to release it (the harness in
 * `SsOptimizerPage.test.tsx`, extended with held replies). The fake keeps its
 * listeners after `terminate()`, so a late reply reaches the page and only the
 * run guard stands between it and the screen.
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScenarioPayload } from '../../db/types';
import { toyProjection } from '../../lib/roth-suggestion/test-fixtures';
import { expectNoA11yViolations } from '../../test/a11y';
import {
  runRothSuggestion,
  type RothSuggestionWorkerInbound,
  type RothSuggestionWorkerOutbound,
  type RothSuggestionWorkerResult,
} from '../../workers/roth-suggestion.worker';
import { buildRothBETRPageData, type RothBETRPageData } from './roth-betr-data';
import { RothSuggestionPanel } from './RothSuggestionPanel';

const { fakeWorkers } = vi.hoisted(() => ({ fakeWorkers: [] as FakeWorkerShape[] }));

interface FakeWorkerShape {
  readonly sent: RothSuggestionWorkerInbound[];
  terminated: boolean;
  emit(msg: RothSuggestionWorkerOutbound): void;
}

vi.mock('../../workers/roth-suggestion.worker.ts?worker', () => {
  class FakeRothSuggestionWorker implements FakeWorkerShape {
    private readonly listeners = new Map<string, Set<(ev: Event) => void>>();
    readonly sent: RothSuggestionWorkerInbound[] = [];
    terminated = false;
    constructor() {
      fakeWorkers.push(this);
    }
    addEventListener(type: string, fn: (ev: Event) => void): void {
      const set = this.listeners.get(type) ?? new Set();
      set.add(fn);
      this.listeners.set(type, set);
    }
    removeEventListener(type: string, fn: (ev: Event) => void): void {
      this.listeners.get(type)?.delete(fn);
    }
    postMessage(msg: RothSuggestionWorkerInbound): void {
      this.sent.push(msg);
    }
    terminate(): void {
      this.terminated = true;
    }
    emit(msg: RothSuggestionWorkerOutbound): void {
      const ev = new MessageEvent('message', { data: msg });
      this.listeners.get('message')?.forEach((fn) => fn(ev));
    }
  }
  return { default: FakeRothSuggestionWorker };
});

const TIMEOUT = { timeout: 60_000 };

let projection = toyProjection({ couple: false });
let pageData: RothBETRPageData;
let baseResult: RothSuggestionWorkerResult;

beforeAll(async () => {
  const built = buildRothBETRPageData(projection);
  if (built === null) throw new Error('toy page data is null');
  pageData = built;
  const { bundle: _bundle, ...rest } = projection;
  void _bundle;
  const posted: RothSuggestionWorkerOutbound[] = [];
  await runRothSuggestion(
    'seed',
    { projection: rest, targetRothAccountId: 'roth', leftoverTaxRate: 0.2, deathAges: { primary: 90 } },
    (m) => posted.push(m),
  );
  const terminal = posted[posted.length - 1];
  if (terminal.kind !== 'result') throw new Error(`seed search gave ${terminal.kind}`);
  baseResult = terminal.result;
}, 60_000);

beforeEach(() => {
  fakeWorkers.length = 0;
  projection = toyProjection({ couple: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface PanelProps {
  pageData?: RothBETRPageData;
  data?: typeof projection;
  selectedScenarioId?: string;
  leftoverTaxPct?: number;
  persistOverrides?: (fragment: Partial<ScenarioPayload['overrides']>) => Promise<boolean>;
}

function panel(props: PanelProps = {}): React.ReactElement {
  const data = props.data ?? projection;
  return (
    <RothSuggestionPanel
      pageData={props.pageData ?? pageData}
      data={{ ...data, scenarios: [...data.scenarios, { ...data.scenarios[0], id: 'other' }] }}
      selectedScenarioId={props.selectedScenarioId ?? 'toy'}
      leftoverTaxPct={props.leftoverTaxPct ?? 20}
      persistOverrides={props.persistOverrides ?? vi.fn(async () => true)}
      onError={vi.fn()}
    />
  );
}

const ACTION = { name: 'Compare conversion plans' };

function worker(): FakeWorkerShape {
  const w = fakeWorkers[fakeWorkers.length - 1];
  if (w === undefined) throw new Error('no worker was spawned');
  return w;
}

function runIdOf(w: FakeWorkerShape): string {
  return w.sent[w.sent.length - 1].runId;
}

/** Posts a terminal reply; the dispatch resolves on a microtask, hence async. */
async function reply(w: FakeWorkerShape, message: RothSuggestionWorkerOutbound): Promise<void> {
  await act(async () => {
    w.emit(message);
  });
}

async function release(
  w: FakeWorkerShape,
  result: RothSuggestionWorkerResult = baseResult,
): Promise<void> {
  await reply(w, { kind: 'result', runId: runIdOf(w), scenarioId: 'toy', result });
}

/** The base result with a rerouted plan and one whose cap was not met. */
function flaggedResult(): RothSuggestionWorkerResult {
  const copy = structuredClone(baseResult);
  const [, first, second] = copy.candidates;
  return {
    ...copy,
    candidates: copy.candidates.map((c) => {
      if (c.id === first.id) return { ...c, reroutedYears: [2031] };
      if (c.id === second.id) {
        return {
          ...c,
          rank: null,
          unranked: [{ kind: 'cap-breached' as const, years: [2030, 2032] }],
        };
      }
      return c;
    }),
    rankedIds: copy.rankedIds.filter((id) => id !== second.id),
  };
}

function bodyRowNames(): string[] {
  const table = screen.getByRole('grid', { name: 'Roth conversion plan comparison' });
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('rowheader')[0].textContent ?? '');
}

async function start(user: ReturnType<typeof userEvent.setup>): Promise<FakeWorkerShape> {
  await user.click(screen.getByRole('button', ACTION));
  return worker();
}

describe('before a run', () => {
  it('offers the action, runs nothing on its own, and spawns no worker', () => {
    render(panel());
    expect(screen.getByRole('button', ACTION)).toBeEnabled();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(fakeWorkers).toHaveLength(0);
    expect(screen.getByText(/Conversions go into/)).toBeInTheDocument();
  });

  it('states the framing in the disclaimer card and never reads as advice', () => {
    render(panel());
    const note = screen.getByRole('note', { name: 'Roth conversion plan comparison disclaimer' });
    const text = note.textContent ?? '';
    expect(text).toMatch(/fixed set of bracket targets/);
    expect(text).toMatch(/one assumed death age \(age 90\)/);
    expect(text).toMatch(/planned basis/);
    expect(text).toMatch(/federal tax only/);
    expect(text).toMatch(/does not say which one to pick/);
    expect(text).toMatch(/Illustrative only/);
    expect(text).not.toMatch(/recommended|best|optimal/i);
    expect(text).not.toMatch(/\b(MAGI|IRMAA|ACA)\b/);
  });

  it('keeps the disclaimer when no plan can be searched', () => {
    render(panel({ pageData: { ...pageData, rothIraAccounts: [] } }));
    expect(screen.getByRole('note', { name: /disclaimer/ })).toBeInTheDocument();
  });
});

describe('empty states', () => {
  it.each([
    ['no own Roth IRA', { rothIraAccounts: [] }, /Add an active Roth IRA/],
    [
      'no retirement year before the RMD age',
      { ctx: { retirementYear: 2041 } },
      /no retirement year before required minimum distributions/,
    ],
  ])('explains why for %s and offers no action', (_name, patch, message) => {
    const patched = {
      ...pageData,
      ...patch,
      ctx: { ...pageData.ctx, ...('ctx' in patch ? patch.ctx : {}) },
    } as RothBETRPageData;
    render(panel({ pageData: patched }));
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('button', ACTION)).toBeNull();
  });
});

describe('a scenario that files separate returns', () => {
  it('explains why and offers no action', () => {
    const couple = toyProjection({
      couple: true,
      overrides: {
        taxFilingPlan: {
          kind: 'separate',
          units: [
            { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
            { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
          ],
        },
      },
    });
    const built = buildRothBETRPageData(couple);
    if (built === null) throw new Error('couple page data is null');
    render(panel({ pageData: built, data: couple }));
    expect(screen.getByText(/married filing separately/)).toBeInTheDocument();
    expect(screen.queryByRole('button', ACTION)).toBeNull();
  });
});

describe('a run', () => {
  it('sends the selected scenario, the page data, the rate and the death age', async () => {
    const user = userEvent.setup();
    render(panel({ leftoverTaxPct: 27 }));
    const w = await start(user);

    expect(w.sent).toHaveLength(1);
    const { input } = w.sent[0];
    expect(input.projection.selectedScenarioId).toBe('toy');
    expect(input.projection.accounts).toBe(projection.accounts);
    expect(input.projection.todayMonthIndex).toBe(pageData.todayMonthIndex);
    expect(input.leftoverTaxRate).toBe(0.27);
    expect(input.targetRothAccountId).toBe('roth');
    expect(input.deathAges).toEqual({ primary: 90 });
  });

  it('shows a determinate bar that follows the ticks, with a Cancel', async () => {
    const user = userEvent.setup();
    render(panel());
    const w = await start(user);

    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-label', 'candidate 1 / 9');
    expect(bar).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', ACTION)).toBeNull();

    act(() => w.emit({ kind: 'progress', runId: runIdOf(w), done: 3, total: 9 }));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-label', 'candidate 4 / 9');
    expect(within(screen.getByRole('progressbar')).getByText('33%', { selector: '.sr-only' })).toBeInTheDocument();

    act(() => w.emit({ kind: 'progress', runId: 'another-run', done: 8, total: 9 }));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
  });

  it('renders the comparison when the reply lands', async () => {
    const user = userEvent.setup();
    render(panel());
    const w = await start(user);
    await release(w);

    expect(screen.queryByRole('progressbar')).toBeNull();
    const names = bodyRowNames();
    expect(names).toHaveLength(baseResult.candidates.length);
    expect(names.some((n) => n.startsWith('Current plan'))).toBe(true);
    expect(names[0]).toContain('Highest after-tax ending balance');
    expect(screen.getByRole('button', ACTION)).toBeInTheDocument();
  });

  it('announces the finished comparison in a live region that was already mounted', async () => {
    const user = userEvent.setup();
    render(panel());
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live).toHaveTextContent('');
    const w = await start(user);
    expect(live).toHaveTextContent('');
    await release(w);
    expect(live).toBeInTheDocument();
    expect(live).toHaveTextContent(
      `Comparison finished: ${baseResult.candidates.length} plans listed below.`,
    );
  });

  it('labels the rerouted and not-ranked rows as text, with the unranked one last', async () => {
    const user = userEvent.setup();
    render(panel());
    const w = await start(user);
    await release(w, flaggedResult());

    const names = bodyRowNames();
    expect(names[names.length - 1]).toContain('Not ranked: cap not met in 2 years');
    expect(screen.getByText(/Spending withdrawals moved to a later account in 2031/)).toBeInTheDocument();
    expect(screen.getByText(/the projection drew spending from a later account/)).toBeInTheDocument();
  });

  it('reports an empty reply and an error reply in a status region', async () => {
    const user = userEvent.setup();
    render(panel());
    const w = await start(user);
    await reply(w, { kind: 'empty', runId: runIdOf(w), scenarioId: 'toy', reason: 'member-birthdate-missing' });
    expect(screen.getByRole('status')).toHaveTextContent(/needs a birthdate/);

    await user.click(screen.getByRole('button', ACTION));
    const second = worker();
    await reply(second, { kind: 'error', runId: runIdOf(second), scenarioId: 'toy', message: 'engine blew up' });
    expect(screen.getByRole('status')).toHaveTextContent('The comparison could not finish: engine blew up');
    expect(screen.queryByRole('grid')).toBeNull();
  });

  it('is one notice, not a table, when no plan converts anything', async () => {
    const user = userEvent.setup();
    render(panel());
    const w = await start(user);
    const none = structuredClone(baseResult);
    await release(w, {
      ...none,
      candidates: none.candidates.map((c) => ({
        ...c,
        totals: { ...c.totals, totalConvertedTodayDollars: 0, yearsConverted: 0 },
      })),
    });
    expect(screen.getByRole('status')).toHaveTextContent(/No bracket had room/);
    expect(screen.queryByRole('grid')).toBeNull();
  });

  it('terminates the worker and spawns a fresh one for the next run', async () => {
    const user = userEvent.setup();
    render(panel());
    const first = await start(user);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(first.terminated).toBe(true);

    await user.click(screen.getByRole('button', ACTION));
    expect(fakeWorkers).toHaveLength(2);
    expect(worker()).not.toBe(first);
  });

  it('terminates the worker on unmount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(panel());
    const w = await start(user);
    unmount();
    expect(w.terminated).toBe(true);
  });
});

describe('cancel and stale replies', () => {
  it('cancels: shows the status, drops a reply released afterwards, and refocuses the action', async () => {
    const user = userEvent.setup();
    render(panel());
    const w = await start(user);
    act(() => w.emit({ kind: 'progress', runId: runIdOf(w), done: 2, total: 9 }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(w.terminated).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('Comparison cancelled');
    expect(screen.getByRole('button', ACTION)).toHaveFocus();

    await release(w);
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Comparison cancelled');
  });

  it('drops a reply released after the scenario changed', async () => {
    const user = userEvent.setup();
    const { rerender } = render(panel());
    const w = await start(user);
    rerender(panel({ selectedScenarioId: 'other' }));

    expect(w.terminated).toBe(true);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByRole('button', ACTION)).toBeInTheDocument();
    await release(w);
    expect(screen.queryByRole('grid')).toBeNull();
  });

  it('hides a finished result when the scenario changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(panel());
    const w = await start(user);
    await release(w);
    expect(screen.getByRole('grid')).toBeInTheDocument();

    rerender(panel({ selectedScenarioId: 'other' }));
    expect(screen.queryByRole('grid')).toBeNull();
  });

  it('marks a result out of date when the data changes, without running again', async () => {
    const user = userEvent.setup();
    const { rerender } = render(panel());
    const w = await start(user);
    await release(w);
    expect(screen.queryByText(/Your data changed/)).toBeNull();

    const changed = {
      ...projection,
      accounts: projection.accounts.map((a, i) => (i === 0 ? { ...a, version: a.version + 1 } : a)),
    };
    rerender(panel({ data: changed }));
    expect(screen.getByRole('status')).toHaveTextContent(/Your data changed after this comparison ran/);
    expect(screen.getByRole('grid')).toBeInTheDocument();
    expect(fakeWorkers).toHaveLength(1);
    expect(worker().sent).toHaveLength(1);
  });
});

describe('the leftover-tax rate', () => {
  it('re-ranks the shown result without a second dispatch', async () => {
    const user = userEvent.setup();
    const result = structuredClone(baseResult);
    // Two plans that swap places as the rate on pre-tax money rises.
    const reference = result.candidates[0];
    const other = result.candidates.find((c) => !c.isReference && c.unranked.length === 0);
    if (other === undefined) throw new Error('the toy search ranked no ladder plan');
    const tilted: RothSuggestionWorkerResult = {
      ...result,
      candidates: result.candidates.map((c) => {
        if (c.id === reference.id) {
          return { ...c, afterTax: { ...c.afterTax, endingTodayDollars: 5_000_000, preTaxTodayDollars: 4_000_000 } };
        }
        if (c.id === other.id) {
          return { ...c, afterTax: { ...c.afterTax, endingTodayDollars: 4_500_000, preTaxTodayDollars: 0 } };
        }
        return { ...c, afterTax: { ...c.afterTax, endingTodayDollars: 1_000_000, preTaxTodayDollars: 0 } };
      }),
    };
    const { rerender } = render(panel({ leftoverTaxPct: 0 }));
    const w = await start(user);
    await release(w, tilted);
    expect(bodyRowNames()[0]).toMatch(/^Current plan/);

    rerender(panel({ leftoverTaxPct: 50 }));
    expect(bodyRowNames()[0]).not.toMatch(/^Current plan/);
    expect(w.sent).toHaveLength(1);
    expect(fakeWorkers).toHaveLength(1);
  });
});

describe('keyboard and accessibility', () => {
  it('reaches the action, then Cancel, then the table, and lands on the action when Cancel goes', async () => {
    const user = userEvent.setup();
    render(panel());
    await user.tab();
    expect(screen.getByRole('button', ACTION)).toHaveFocus();

    await user.keyboard('{Enter}');
    // The action unmounts under the keyboard; focus moves to Cancel.
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    const w = worker();
    await release(w);
    expect(screen.getByRole('button', ACTION)).toHaveFocus();

    await user.tab();
    const region = screen.getByRole('region', { name: 'Roth conversion plan comparison' });
    expect(region.contains(document.activeElement)).toBe(true);
  });

  it('has no axe violations while running', TIMEOUT, async () => {
    const user = userEvent.setup();
    const { container } = render(panel());
    const w = await start(user);
    act(() => w.emit({ kind: 'progress', runId: runIdOf(w), done: 2, total: 9 }));
    await expectNoA11yViolations(container);
  });

  it('has no axe violations with results and flagged rows', TIMEOUT, async () => {
    const user = userEvent.setup();
    const { container } = render(panel());
    const w = await start(user);
    await release(w, flaggedResult());
    await expectNoA11yViolations(container);
  });
});
