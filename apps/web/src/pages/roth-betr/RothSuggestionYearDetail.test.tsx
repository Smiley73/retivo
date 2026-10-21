/**
 * The year-by-year table behind each plan: opened from a toggle in the row,
 * one plan at a time, keyboard-only, with every year of the window a row and
 * the figures in each year's own dollars.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { formatCurrencyExact } from '../../lib/format-currency';
import { searchRothSuggestions } from '../../lib/roth-suggestion/search';
import { TOY_ROTH_ID, toyProjection } from '../../lib/roth-suggestion/test-fixtures';
import { expectNoA11yViolations } from '../../test/a11y';
import type { RothSuggestionWorkerResult } from '../../workers/roth-suggestion.worker';
import { buildSuggestionTable, type RothSuggestionRow } from './roth-suggestion-view-model';
import { RothSuggestionTable } from './RothSuggestionTable';

const TIMEOUT = { timeout: 60_000 };

let result: RothSuggestionWorkerResult;
let rows: readonly RothSuggestionRow[];

beforeAll(async () => {
  const searched = await searchRothSuggestions({
    projection: toyProjection({ iraBalance: 3_000_000 }),
    targetRothAccountId: TOY_ROTH_ID,
    leftoverTaxRate: 0.2,
    deathAges: { primary: 90, secondary: 90 },
  });
  if (searched.kind !== 'ok') throw new Error(`seed search gave ${searched.kind}`);
  result = { ...searched, candidates: searched.candidates.map(({ drawdownYears: _d, ...c }) => (void _d, c)) };
  const table = buildSuggestionTable(result, 0.2);
  if (table.kind !== 'rows') throw new Error('expected rows');
  rows = table.rows;
}, 60_000);

function toggleFor(plan: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`Why each year for ${plan}`) });
}

/** The way a keyboard user gets to a button in a grid cell: Tab into the table,
 *  then the arrow keys down to the plan's row and along it to the last cell. */
async function focusWithKeyboard(user: ReturnType<typeof userEvent.setup>, target: HTMLElement): Promise<void> {
  const grid = screen.getByRole('grid', { name: 'Roth conversion plan comparison' });
  for (let i = 0; i < 10 && !grid.contains(document.activeElement); i += 1) await user.tab();
  expect(grid.contains(document.activeElement)).toBe(true);
  const row = target.closest('[role="row"]');
  for (let i = 0; i < 40 && document.activeElement !== target; i += 1) {
    const active = document.activeElement;
    await user.keyboard(active?.closest('[role="row"]') === row ? '{ArrowRight}' : '{ArrowDown}');
  }
  expect(target).toHaveFocus();
}

const GUARDED_22 = 'Fill the 22% bracket, kept under both lines';

describe('the year-by-year toggle', () => {
  it('is reached from the table with the arrow keys, opens with Enter, announces its state, and closes with a second Enter', async () => {
    const user = userEvent.setup();
    render(<RothSuggestionTable rows={rows} leftoverTaxPct={20} />);
    const toggle = toggleFor(GUARDED_22);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await focusWithKeyboard(user, toggle);
    expect(toggle).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('grid', { name: `Year by year: ${GUARDED_22}` })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('grid', { name: /Year by year/ })).not.toBeInTheDocument();
  }, TIMEOUT.timeout);

  it('closes on Escape from inside the detail and gives focus back to its toggle', async () => {
    const user = userEvent.setup();
    render(<RothSuggestionTable rows={rows} leftoverTaxPct={20} />);
    await user.click(toggleFor(GUARDED_22));
    const grid = screen.getByRole('grid', { name: /Year by year/ });
    await user.click(within(grid).getAllByRole('rowheader')[0]);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('grid', { name: /Year by year/ })).not.toBeInTheDocument();
    expect(toggleFor(GUARDED_22)).toHaveFocus();
    expect(toggleFor(GUARDED_22)).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens one plan at a time', async () => {
    const user = userEvent.setup();
    render(<RothSuggestionTable rows={rows} leftoverTaxPct={20} />);
    await user.click(toggleFor(GUARDED_22));
    await user.click(toggleFor('Current plan'));
    expect(toggleFor(GUARDED_22)).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('grid', { name: /Year by year/ })).toHaveLength(1);
    expect(screen.getByRole('grid', { name: 'Year by year: Current plan, not assessed' })).toBeInTheDocument();
  });

  it('opens a plan whose cap could not be met', async () => {
    const user = userEvent.setup();
    const breached = rows.map((row) => (row.id === 'bracket-12-guarded' ? { ...row, notRanked: 'Not ranked: cap not met in 2 years', rank: null } : row));
    render(<RothSuggestionTable rows={breached} leftoverTaxPct={20} />);
    await user.click(toggleFor('Fill the 12% bracket, kept under both lines'));
    expect(screen.getByRole('grid', { name: /Year by year: Fill the 12% bracket/ })).toBeInTheDocument();
  });
});

describe('the year-by-year table', () => {
  async function openDetail(plan: string): Promise<HTMLElement> {
    const user = userEvent.setup();
    render(<RothSuggestionTable rows={rows} leftoverTaxPct={20} />);
    await user.click(toggleFor(plan));
    return screen.getByRole('grid', { name: `Year by year: ${plan}` });
  }

  it('has a row for every year of the window and the year after, $0 years with their reason', async () => {
    const grid = await openDetail(GUARDED_22);
    const detail = result.candidates.find((c) => c.id === 'bracket-22-guarded')?.yearDetail ?? [];
    const body = within(grid).getAllByRole('row').slice(1);
    expect(body).toHaveLength(detail.length);
    expect(detail.some((r) => r.amountDollars === 0)).toBe(true);
    const lastRow = body[body.length - 1];
    expect(within(lastRow).getByText('Outside the window, no conversion tried')).toBeInTheDocument();
    // Each row whose Converted cell reads $0.00 names its reason in the Stopped by cell.
    const headers = within(grid).getAllByRole('columnheader').map((h) => h.textContent ?? '');
    const converted = headers.indexOf('Converted');
    const stoppedBy = headers.indexOf('Stopped by');
    expect(converted).toBeGreaterThan(-1);
    expect(stoppedBy).toBeGreaterThan(converted);
    const cellsOf = (r: HTMLElement): string[] =>
      Array.from(r.querySelectorAll('[role="rowheader"], [role="gridcell"]')).map((c) => c.textContent ?? '');
    const zero = body.filter((r) => cellsOf(r)[converted] === '$0.00');
    expect(zero).toHaveLength(detail.filter((r) => r.amountDollars === 0).length);
    const reasons: Partial<Record<(typeof detail)[number]['limitKind'], string>> = {
      'already-over': 'Already over the ceiling',
      'pre-tax-ran-out': 'Pre-tax money ran out',
      'outside-window': 'Outside the window, no conversion tried',
    };
    for (const r of zero) {
      const cells = cellsOf(r);
      const year = detail.find((d) => String(d.year) === cells[0]);
      const reason = year === undefined ? undefined : reasons[year.limitKind];
      expect(reason, `year ${cells[0]}`).toBeDefined();
      expect(cells[stoppedBy]).toBe(reason);
    }
  });

  it('shows each year in its own dollars and says the comparison above is in today’s', async () => {
    const grid = await openDetail(GUARDED_22);
    const first = result.candidates.find((c) => c.id === 'bracket-22-guarded')?.yearDetail[0];
    const today = result.candidates.find((c) => c.id === 'bracket-22-guarded')?.totals.totalConvertedTodayDollars;
    expect(first?.amountDollars).toBeGreaterThan(0);
    expect(within(grid).getAllByText(formatCurrencyExact(first?.amountDollars ?? NaN)).length).toBeGreaterThan(0);
    expect(today).toBeDefined();
    expect(screen.getByText(/in that year.s own dollars/)).toBeInTheDocument();
    expect(screen.getByText(/The comparison above is in today.s dollars/)).toBeInTheDocument();
  });

  it('writes the cliff note and its full-value label on a cliff-stopped year only', async () => {
    const grid = await openDetail(GUARDED_22);
    const detail = result.candidates.find((c) => c.id === 'bracket-22-guarded')?.yearDetail ?? [];
    const cliffYears = detail.filter((r) => r.crossingNote !== null).length;
    expect(cliffYears).toBeGreaterThan(0);
    expect(within(grid).getAllByText(/ACA credit lost, at full value/)).toHaveLength(cliffYears);
    expect(within(grid).getAllByText(/Medicare surcharge two years later/)).toHaveLength(cliffYears);
  });

  it('has no note on a plan that stops at the bracket top', async () => {
    const grid = await openDetail('Fill the 22% bracket, not limited');
    expect(within(grid).queryByText(/at full value/)).not.toBeInTheDocument();
  });

  it('never says Medicare surcharge line as the bare acronym', async () => {
    const grid = await openDetail(GUARDED_22);
    for (const cell of within(grid).getAllByRole('columnheader')) {
      expect(cell.textContent).not.toMatch(/\bIRMAA\b|\bMAGI\b/);
    }
  });

  it('passes the accessibility smoke with a plan open', async () => {
    const user = userEvent.setup();
    const { container } = render(<RothSuggestionTable rows={rows} leftoverTaxPct={20} />);
    await user.click(toggleFor(GUARDED_22));
    await expectNoA11yViolations(container);
  });
});
