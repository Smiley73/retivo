// WithdrawalStrategyEditor Strategy-tab description: the seeded strategy's plain-English description below the picker, swapped on switching, and non-empty for every StrategyKind. The page-level intro (the PageHeader subtitle) is asserted in ScenarioWithdrawalStrategyPage.test.
import 'fake-indexeddb/auto';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WithdrawalStrategyEditor } from './scenario-withdrawal-strategy-editor';
import {
  STRATEGY_DESCRIPTIONS,
  STRATEGY_LABELS,
} from './scenario-withdrawal-strategy-shared';
import type { StrategyKind } from './scenario-withdrawal-strategy-shared';
import { clearAllStores } from '../db/store';
import { expectNoA11yViolations } from '../test/a11y';
import type { ScenarioPayload } from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

const HH = 'hh-test';
const NO_ACCOUNTS = [] as const;
const NO_MEMBERS = [] as const;

function makeScenario(
  id: string,
  overrides: ScenarioPayload['overrides'] = {},
): ScenarioAggregate {
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
      overrides,
    },
  };
}

function renderModalForKind(kind: StrategyKind): { container: HTMLElement } {
  const scenario = makeScenario('sc-1', { withdrawalStrategy: { kind } });
  return render(
    <MemoryRouter>
      <WithdrawalStrategyEditor
        scenario={scenario}
        scenarios={[scenario]}
        householdId={HH}
        accounts={NO_ACCOUNTS}
        members={NO_MEMBERS}
        incomeStreams={[]}
        backPath="/scenarios/sc"

        onSaved={vi.fn()}
      />
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  await clearAllStores();
});

afterEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
});

describe('WithdrawalStrategyEditor — Strategy-tab description', () => {
  it('renders the seeded strategy kind description below the picker', async () => {
    renderModalForKind('taxEfficient');
    await screen.findByRole('tab', { name: /Strategy/ });
    const description = screen.getByText(STRATEGY_DESCRIPTIONS.taxEfficient);
    expect(description).toBeTruthy();
    expect(description).toHaveClass('text-sm');
  });

  it('swaps the description text when the picker selects a different kind', async () => {
    // Seed proportional (whose description shares no substring with rothFirst's) so the post-switch assertion can't false-pass on shared copy.
    renderModalForKind('proportional');
    await screen.findByRole('tab', { name: /Strategy/ });
    expect(screen.getByText(STRATEGY_DESCRIPTIONS.proportional)).toBeTruthy();

    await userEvent.click(
      screen.getByRole('radio', { name: STRATEGY_LABELS.rothFirst }),
    );

    expect(screen.getByText(STRATEGY_DESCRIPTIONS.rothFirst)).toBeTruthy();
    expect(screen.queryByText(STRATEGY_DESCRIPTIONS.proportional)).toBeNull();
  });

  it.each(
    (['taxEfficient', 'proportional', 'rothFirst', 'customOrder'] as StrategyKind[]).map(
      (kind) => ({ kind }),
    ),
  )('renders the description for $kind', async ({ kind }) => {
    const description = STRATEGY_DESCRIPTIONS[kind];
    expect(description.length).toBeGreaterThan(0);
    renderModalForKind(kind);
    await screen.findByRole('tab', { name: /Strategy/ });
    expect(screen.getByText(description)).toBeTruthy();
  });

  it('passes expectNoA11yViolations on the rendered editor', async () => {
    const { container } = renderModalForKind('taxEfficient');
    await screen.findByRole('tab', { name: /Strategy/ });
    await expectNoA11yViolations(container);
  });
});
