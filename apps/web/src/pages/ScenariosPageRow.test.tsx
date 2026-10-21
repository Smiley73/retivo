/**
 * Row-level render tests for the scenario card's Historical column.
 *
 * The full-page ScenariosPage tests leave the deterministic projection null,
 * so they only assert the Historical *label* renders — never a populated
 * Historical dollar value or the TWR-unavailable `—`/no-sparkline state.
 * These render `ScenariosPageRow` directly with a constructed
 * `ScenarioCardMetrics` to cover both wiring paths cheaply (no seeded
 * household + deterministic projection).
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../test/a11y';
import { ScenariosPageRow } from './ScenariosPageRow';
import type { ScenarioCardMetrics } from './scenarios-page-metrics';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

const SCENARIO: ScenarioAggregate = {
  id: 'sc-1',
  householdId: 'hh-test',
  aggregateType: 'scenario',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'dev-1',
  payload: {
    name: 'Historical row',
    description: '',
    parentScenarioId: null,
    isPrimary: true,
    notes: '',
    overrides: {},
  },
} as unknown as ScenarioAggregate;

/** A fully-resolved metrics object with the MC + plan-success fields left in
 *  their miss/empty state so only the Historical column varies per test. */
function metricsWith(
  historicalEndingBalance: number | null,
  historicalSeries: ReadonlyArray<number>,
): ScenarioCardMetrics {
  return {
    endingBalance: null,
    series: [],
    historicalEndingBalance,
    historicalSeries,
    planSuccessPct: null,
    typicalAtHorizon: null,
    pessimisticAtHorizon: null,
    typicalSeries: [],
    pessimisticSeries: [],
    planSuccessState: 'missing',
    canRunMc: false,
  };
}

function renderRow(
  metrics: ScenarioCardMetrics | undefined,
  compareWithParent: { parentName: string; onActivate: () => void } | null = null,
  scenario: ScenarioAggregate = SCENARIO,
): HTMLElement {
  render(
    <MemoryRouter>
      <ScenariosPageRow
        scenario={scenario}
        ancestorIsLast={[true]}
        isSelected={false}
        metrics={metrics}
        onDelete={null}
        onRecalc={null}
        isRecalculating={false}
        recalcDone={0}
        recalcTotal={0}
        compareWithParent={compareWithParent}
      />
    </MemoryRouter>,
  );
  return screen.getByText(scenario.payload.name).closest(
    '.scenario-tree__row',
  ) as HTMLElement;
}

/** The footer group whose label matches `label`. */
function metricGroup(row: HTMLElement, label: string): HTMLElement {
  return within(row).getByText(label).closest('div') as HTMLElement;
}

describe('ScenariosPageRow — Historical column', () => {
  it('renders the Historical dollar value + sparkline when TWR is populated', () => {
    const row = renderRow(metricsWith(1_200_000, [800_000, 1_000_000, 1_200_000]));
    const group = metricGroup(row, 'Historical');
    // Positive at-horizon value renders in short-form currency.
    expect(within(group).getByText('$1.2M')).toBeInTheDocument();
    // A >=2-point series paints the decorative sparkline.
    expect(group.querySelector('svg')).not.toBeNull();
  });

  it('renders the "—" placeholder and no sparkline when TWR is unavailable', () => {
    const row = renderRow(metricsWith(null, []));
    const group = metricGroup(row, 'Historical');
    // null historical → muted dash, no money string.
    expect(within(group).getByText('—')).toBeInTheDocument();
    expect(within(group).queryByText(/\$/)).toBeNull();
    // Empty series → the sparkline is not painted.
    expect(group.querySelector('svg')).toBeNull();
  });
});

describe('ScenariosPageRow — Compare with parent', () => {
  const CHILD = {
    ...SCENARIO,
    id: 'sc-2',
    payload: { ...SCENARIO.payload, name: 'Retire at 67', parentScenarioId: 'sc-1', isPrimary: false },
  } as unknown as ScenarioAggregate;

  it('renders the visible control with an accessible name naming both scenarios', () => {
    const row = renderRow(undefined, { parentName: 'Historical row', onActivate: vi.fn() }, CHILD);
    const button = within(row).getByRole('button', {
      name: 'Compare Retire at 67 with parent Historical row',
    });
    expect(button).toHaveTextContent('Compare with parent');
    // Always visible: not inside the hover-revealed icon cluster.
    expect(button.closest('.row-actions')).toBeNull();
  });

  it('renders nothing when no handler is supplied (Base card)', () => {
    const row = renderRow(undefined);
    expect(within(row).queryByText('Compare with parent')).toBeNull();
    expect(within(row).queryByRole('button', { name: /Compare/ })).toBeNull();
  });

  it('calls the handler on click and on keyboard activation', async () => {
    const onActivate = vi.fn();
    const user = userEvent.setup();
    const row = renderRow(undefined, { parentName: 'Historical row', onActivate }, CHILD);
    const button = within(row).getByRole('button', { name: /Compare Retire at 67/ });
    await user.click(button);
    expect(onActivate).toHaveBeenCalledTimes(1);
    button.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  it('has no a11y violations with the control present', async () => {
    renderRow(undefined, { parentName: 'Historical row', onActivate: vi.fn() }, CHILD);
    await expectNoA11yViolations(document.body);
  });
});
