/**
 * Saving a ranked plan from the panel: which rows offer Save, what confirming
 * writes, and the saved-plan marker's states.
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScenarioPayload } from '../../db/types';
import { buildSuggestionCapWindows } from '../../lib/roth-betr-apply-helpers';
import { toyProjection } from '../../lib/roth-suggestion/test-fixtures';
import type { RothSuggestionWorkerResult } from '../../workers/roth-suggestion.worker';
import type { RothBETRPageData } from './roth-betr-data';
import { RothSuggestionPanel } from './RothSuggestionPanel';
import { fakeWorkers, seedToyPanel } from './roth-suggestion-panel-fixture';
import { buildSavedPlanRecord, readSavedPlan, writeSavedPlan } from './roth-suggestion-saved-plan';

vi.mock('../../workers/roth-suggestion.worker.ts?worker', async () => ({
  default: (await import('./roth-suggestion-panel-fixture')).FakeRothSuggestionWorker,
}));

let projection = toyProjection({ couple: false });
let pageData: RothBETRPageData;
let baseResult: RothSuggestionWorkerResult;

beforeAll(async () => {
  ({ pageData, baseResult } = await seedToyPanel());
}, 60_000);

beforeEach(() => {
  fakeWorkers.length = 0;
  window.localStorage.clear();
  projection = toyProjection({ couple: false });
});

afterEach(() => {
  window.localStorage.clear();
});

type Persist = (fragment: Partial<ScenarioPayload['overrides']>) => Promise<boolean>;

function panel(persist: Persist, data = projection): React.ReactElement {
  return (
    <RothSuggestionPanel
      pageData={pageData}
      data={data}
      selectedScenarioId="toy"
      leftoverTaxPct={20}
      persistOverrides={persist}
      onError={vi.fn()}
    />
  );
}

/** The base result with the second plan's cap not met. */
function withBreach(): RothSuggestionWorkerResult {
  const copy = structuredClone(baseResult);
  const second = copy.candidates[2];
  return {
    ...copy,
    candidates: copy.candidates.map((c) =>
      c.id === second.id
        ? { ...c, rank: null, unranked: [{ kind: 'cap-breached' as const, years: [2030] }] }
        : c,
    ),
    rankedIds: copy.rankedIds.filter((id) => id !== second.id),
  };
}

async function showResults(
  user: ReturnType<typeof userEvent.setup>,
  result: RothSuggestionWorkerResult,
): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Compare conversion plans' }));
  const w = fakeWorkers[fakeWorkers.length - 1];
  const runId = w.sent[w.sent.length - 1].runId;
  await act(async () => {
    w.emit({ kind: 'result', runId, scenarioId: 'toy', result });
  });
}

/** The first ranked plan of the search's own in table order (the order the
 *  Save buttons appear in). */
function firstSavable() {
  return baseResult.rankedIds
    .map((id) => baseResult.candidates.find((c) => c.id === id))
    .find((c) => c !== undefined && !c.isReference && c.rank !== null);
}

const SAVE = /^Save plan to scenario:/;

describe('the Save action', () => {
  it('is on ranked plans, and absent on the current plan and on a plan whose cap was not met', async () => {
    const user = userEvent.setup();
    render(panel(vi.fn(async () => true)));
    await showResults(user, withBreach());
    const grid = screen.getByRole('grid', { name: 'Roth conversion plan comparison' });
    const rows = within(grid).getAllByRole('row').slice(1);
    const bodies = rows.map((r) => ({
      name: within(r).getAllByRole('rowheader')[0].textContent ?? '',
      save: within(r).queryAllByRole('button', { name: SAVE }).length,
    }));
    expect(bodies.find((b) => b.name.startsWith('Current plan'))?.save).toBe(0);
    expect(bodies.find((b) => b.name.includes('Not ranked'))?.save).toBe(0);
    expect(bodies.some((b) => b.save === 1)).toBe(true);
    for (const b of bodies) {
      const savable = !b.name.startsWith('Current plan') && !b.name.includes('Not ranked');
      expect(b.save, b.name).toBe(savable ? 1 : 0);
    }
  });
});

describe('confirming a save', () => {
  it('writes the row ladder through the page save path, then shows the marker', async () => {
    const user = userEvent.setup();
    const persist = vi.fn<Persist>(async () => true);
    render(panel(persist));
    await showResults(user, baseResult);
    const target = firstSavable();
    if (target === undefined) throw new Error('no savable plan');
    const buttons = screen.getAllByRole('button', { name: SAVE });
    await user.click(buttons[0]);
    const dialog = screen.getByRole('dialog', { name: 'Save plan to scenario' });
    expect(dialog.textContent).toContain('roth');
    await user.click(within(dialog).getByRole('button', { name: 'Save to scenario' }));
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith({
      magiCap: { windows: buildSuggestionCapWindows(target.ladder) },
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    // The page's data has not reloaded in this harness, so the marker is read back from storage.
    expect(readSavedPlan('toy')).toMatchObject({
      label: expect.stringMatching(/^Fill the \d+% bracket/),
    });
  });

  it('keeps the dialog open and writes no marker when the save fails', async () => {
    const user = userEvent.setup();
    render(panel(vi.fn(async () => false)));
    await showResults(user, baseResult);
    await user.click(screen.getAllByRole('button', { name: SAVE })[0]);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save to scenario' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(readSavedPlan('toy')).toBeNull();
  });
});

describe('results that are out of date', () => {
  function edited() {
    return { ...projection, expenses: projection.expenses.map((e) => ({ ...e, version: e.version + 1 })) };
  }

  it('offer no Save action once the data changed after the run', async () => {
    const user = userEvent.setup();
    const { rerender } = render(panel(vi.fn(async () => true)));
    await showResults(user, baseResult);
    expect(screen.getAllByRole('button', { name: SAVE }).length).toBeGreaterThan(0);
    rerender(panel(vi.fn(async () => true), edited()));
    expect(screen.getByText(/Your data changed after this comparison ran/)).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: SAVE })).toHaveLength(0);
  });

  it('are not saved when the data changes under an open dialog, and no marker is written', async () => {
    const user = userEvent.setup();
    const persist = vi.fn<Persist>(async () => true);
    const { rerender } = render(panel(persist));
    await showResults(user, baseResult);
    await user.click(screen.getAllByRole('button', { name: SAVE })[0]);
    rerender(panel(persist, edited()));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save to scenario' }));
    expect(persist).not.toHaveBeenCalled();
    expect(readSavedPlan('toy')).toBeNull();
  });
});

describe('the saved-plan marker', () => {
  function savedScenario() {
    const ladder = firstSavable()?.ladder ?? [];
    const windows = buildSuggestionCapWindows(ladder);
    const saved = {
      ...projection,
      scenarios: projection.scenarios.map((s) => ({
        ...s,
        version: s.version + 1,
        payload: { ...s.payload, overrides: { ...s.payload.overrides, magiCap: { windows } } },
      })),
    };
    const record = buildSavedPlanRecord({
      data: projection,
      scenarioId: 'toy',
      label: 'Fill the 24% bracket, kept under both lines',
      ladder,
      now: new Date(2026, 4, 17),
    });
    return { saved, record };
  }

  it('shows without any results on screen, after a reload', () => {
    const { saved, record } = savedScenario();
    writeSavedPlan('toy', record);
    render(panel(vi.fn(async () => true), saved));
    expect(screen.queryByRole('grid')).toBeNull();
    expect(
      screen.getByText(/Saved plan: Fill the 24% bracket, kept under both lines, saved May 17, 2026\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Out of date/)).toBeNull();
  });

  it('reads out of date, in words, once an input changed', () => {
    const { saved, record } = savedScenario();
    writeSavedPlan('toy', record);
    const edited = { ...saved, expenses: saved.expenses.map((e) => ({ ...e, version: e.version + 1 })) };
    render(panel(vi.fn(async () => true), edited));
    expect(screen.getByText('Out of date.')).toBeInTheDocument();
  });

  it('is dropped when the scenario cap is no longer the saved plan', () => {
    const { record } = savedScenario();
    writeSavedPlan('toy', record);
    render(panel(vi.fn(async () => true)));
    expect(screen.queryByText(/Saved plan:/)).toBeNull();
  });
});
