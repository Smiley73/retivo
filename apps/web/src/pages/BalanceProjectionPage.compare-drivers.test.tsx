/**
 * The Compare tab's Drivers table, its note and horizon sentence, and the
 * identical-results state, on the demo dataset (Base > {Retire early at 62 >
 * Funds Run Out, Delay — work to 70}). Selection, gating and the headline are
 * pinned in `BalanceProjectionPage.compare.test.tsx`.
 */
import 'fake-indexeddb/auto';
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllStores, listAggregates } from '../db/store';
import type { ScenarioPayload } from '../db/types';
import { ACCOUNT_BUCKET_LABEL } from '../lib/account-bucket';
import { formatCurrencyShort } from '../lib/format-currency';
import { formatSignedDifference } from '../lib/signed-difference';
import { expectNoA11yViolations } from '../test/a11y';
import { buildCompareData } from './balance-projection-compare-data';
import { loadPageData, type PipelineData } from './balance-projection-page-data';
import {
  BASE,
  DELAY,
  EARLY,
  WAIT,
  comparePath,
  renderComparePage,
  resetDemo,
  seedChild,
} from './__fixtures__/compare-page';

vi.mock('./balance-projection-page-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./balance-projection-page-data')>();
  return { ...actual, loadPageData: vi.fn(actual.loadPageData) };
});
const loadSpy = vi.mocked(loadPageData);

/** Wording that would claim a row caused, explains or is responsible for the gap. */
const CAUSAL = /caused|because of|explains|accounts for|responsible for|due to/i;
const DRIVERS_NOTE =
  'These are differences between the totals of two complete projections. The ' +
  'model does not apportion the gap among them, and one change usually moves ' +
  'several lines at once, so read each row as a total, not as a share of the gap.';

async function renderCompare(viewed: string, withId?: string): Promise<HTMLElement> {
  return (await renderComparePage(viewed, { path: comparePath(withId) })).panel;
}

async function renderDrivers(viewed: string, withId?: string): Promise<HTMLElement> {
  const panel = await renderCompare(viewed, withId);
  await within(panel).findByRole('row', { name: /Federal income tax/ }, WAIT);
  return panel;
}

function projected(id: string): PipelineData {
  const at = loadSpy.mock.calls.findIndex(([o]) => o.selectedScenarioId === id);
  return loadSpy.mock.results[at]!.value as PipelineData;
}

const rowCells = (panel: HTMLElement, name: RegExp): string[] =>
  within(within(panel).getByRole('row', { name }))
    .getAllByRole('gridcell')
    .map((c) => c.textContent ?? '');

const IDENTICAL = /The Planned projections of (.+) and (.+) are identical/;

describe('Compare tab — drivers', () => {
  beforeEach(async () => {
    await resetDemo();
    loadSpy.mockClear();
  });
  afterEach(async () => {
    cleanup();
    await clearAllStores();
  });

  it('renders each scenario’s totals in its own column, with an uncoloured signed difference', async () => {
    const panel = await renderDrivers(EARLY);
    const compare = buildCompareData({
      viewed: projected(EARLY),
      comparison: projected(BASE),
      stressCacheKeys: { viewed: null, comparison: null },
    });
    const v = compare.viewed.drivers!;
    const c = compare.comparison.drivers!;
    expect(v.federalTax).not.toBe(c.federalTax);
    const headers = within(panel).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.slice(-4)).toEqual(['Driver', 'Retire early at 62', 'Base', 'Difference']);

    for (const [name, key] of [
      [/^Federal income tax/, 'federalTax'],
      [/^Medicare surcharges/, 'irmaaSurcharge'],
      [/^ACA health credits/, 'acaPtcCredit'],
    ] as const) {
      const [viewedCell, comparisonCell, diff] = rowCells(panel, name);
      expect(viewedCell).toBe(formatCurrencyShort(v[key]));
      expect(comparisonCell).toBe(formatCurrencyShort(c[key]));
      expect(diff).toBe(formatSignedDifference('money', v[key], c[key]));
    }
    const diffCell = within(within(panel).getByRole('row', { name: /^Federal income tax/ }))
      .getAllByRole('gridcell')[2]!;
    expect(diffCell.textContent).toMatch(/^[+−]\$.+ (more|less)$/);
    expect(diffCell.outerHTML).not.toMatch(/success|danger|error|warning|positive|negative|green|red/);
  });

  it('reads the years-of-withdrawals rows in years, not dollars', async () => {
    const panel = await renderDrivers(EARLY);
    const label = ACCOUNT_BUCKET_LABEL.pretax;
    const [viewed, comparison, diff] = rowCells(panel, new RegExp(`Years of withdrawals: ${label}`));
    expect(viewed).toMatch(/^\d+$/);
    expect(comparison).toMatch(/^\d+$/);
    expect(diff).toMatch(/^(No difference|[+−]\d+ years? (more|less))$/);
    expect(diff).not.toMatch(/\$/);
  });

  it('shows the note with the table and no sentence anywhere claims a row caused the gap', async () => {
    const panel = await renderDrivers(EARLY);
    expect(within(panel).getByText(DRIVERS_NOTE)).toBeInTheDocument();
    expect(within(panel).getByText(DRIVERS_NOTE).tagName).toBe('P');
    expect(panel.textContent).not.toMatch(CAUSAL);
    expect(within(panel).getByText(/Total Roth converted is in each year's own dollars/)).toBeInTheDocument();
  });

  it.each([
    ['viewed', 'long-life', undefined],
    ['compared', BASE, 'long-life'],
  ])('names the longer-running scenario and its year when it is the %s one', async (_which, viewed, withId) => {
    // The demo's "Funds Run Out" sets life expectancy 95, the default, so it
    // shares its parent's horizon; a child living to 100 runs five years longer.
    await seedChild('long-life', BASE, { lifeExpectancy: { primary: 100 } });
    const panel = await renderDrivers(viewed, withId);
    const text = within(panel).getByText(/runs longer/).textContent!;
    const [, longerYear, otherYear] =
      /^long-life runs longer than Base, to (\d{4}) instead of (\d{4}), so its lifetime totals cover those extra years\.$/.exec(
        text,
      )!;
    expect(Number(longerYear)).toBe(Number(otherYear) + 5);
  });

  it('says nothing about a longer horizon when both end in the same year', async () => {
    const panel = await renderDrivers(EARLY);
    expect(within(panel).queryByText(/runs longer/)).toBeNull();
  });

  it('has no accessibility violations with the table', async () => {
    await expectNoA11yViolations(await renderDrivers(EARLY));
  });
});

describe('Compare tab — identical results', () => {
  beforeEach(async () => {
    await resetDemo();
    loadSpy.mockClear();
  });
  afterEach(async () => {
    cleanup();
    await clearAllStores();
  });

  async function findIdentical(panel: HTMLElement): Promise<void> {
    await within(panel).findByText(IDENTICAL, undefined, WAIT);
    expect(within(panel).queryByRole('row')).toBeNull();
    expect(within(panel).queryByText(DRIVERS_NOTE)).toBeNull();
    expect(panel.textContent).not.toMatch(CAUSAL);
  }

  it('gives the same sentence and grouped list from either side', async () => {
    const early = (await listAggregates('scenario')).find((s) => s.id === EARLY)!;
    await seedChild('same-age', EARLY, {
      retirementAge: (early.payload as ScenarioPayload).overrides.retirementAge,
    });
    const reads: string[] = [];
    for (const [viewed, withId] of [['same-age', undefined], [EARLY, 'same-age']] as const) {
      const panel = await renderCompare(viewed, withId);
      await findIdentical(panel);
      const sentence = within(panel).getByText(IDENTICAL).textContent!;
      expect(sentence).toMatch(/identical: every year of both comes out the same/);
      expect(within(panel).getByText('What same-age changes from Retire early at 62:')).toBeInTheDocument();
      const item = within(panel).getByRole('listitem');
      expect(item).toHaveTextContent('Timing & longevity: Retirement age');
      reads.push(item.textContent!);
      cleanup();
    }
    expect(reads[0]).toBe(reads[1]);
  });

  it.each([
    ['no overrides', {}],
    ['only an empty expenses inventory', { expenses: { disabledIds: [], patches: {}, added: [] } }],
  ])('reads a child with %s as changing nothing', async (_label, overrides) => {
    await seedChild('child', BASE, overrides);
    const panel = await renderCompare('child');
    await findIdentical(panel);
    expect(within(panel).getByText('child changes nothing from Base.')).toBeInTheDocument();
    expect(within(panel).queryByRole('listitem')).toBeNull();
  });

  it('lists a card set only by the intermediate scenario of a grandchild', async () => {
    const guardrails = { enabled: true, lowerBandPct: 85, upperBandPct: 115, stepPct: 10, maxRaisePct: 100 };
    await seedChild('middle', BASE, { downturnGuardrails: guardrails });
    await seedChild('grandchild', 'middle', {});
    const panel = await renderCompare('grandchild', BASE);
    await findIdentical(panel);
    expect(within(panel).getByRole('listitem')).toHaveTextContent('Income & expenses: Spending guardrails');
  });

  it('gives the sentence alone for two siblings with equal results', async () => {
    await seedChild('sibling-a', BASE, {});
    await seedChild('sibling-b', BASE, {});
    const panel = await renderCompare('sibling-a', 'sibling-b');
    await findIdentical(panel);
    expect(within(panel).queryByText(/changes/)).toBeNull();
    expect(within(panel).queryByRole('list')).toBeNull();
  });

  it('keeps the identical state off pairs whose results differ', async () => {
    const panel = await renderCompare(EARLY, DELAY);
    await within(panel).findByRole('row', { name: /Federal income tax/ }, WAIT);
    await waitFor(() => expect(within(panel).queryByText(IDENTICAL)).toBeNull());
  });

  it('has no accessibility violations in the identical state', async () => {
    await seedChild('child', BASE, {});
    const panel = await renderCompare('child');
    await findIdentical(panel);
    await expectNoA11yViolations(panel);
  });
});
