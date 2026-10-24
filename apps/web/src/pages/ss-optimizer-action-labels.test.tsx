// Scoped action-label invariant for the claim-age comparison table: no action control reads `Apply` or `Applied` in any state. `SsOptimizerPage.test.tsx` asserts the new labels only where a control was already queried, so a control left on the old wording is invisible to it.
// This file drives `OptimizerResultsTable` directly through every reachable state of both action buttons and the four disabled row variants, by exact accessible name; a branch added later has to be added here too.
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import {
  OptimizerResultsTable,
  type OptimizerAggregates,
  type ScenarioRow,
} from './ss-optimizer-page-chrome';
import type { OptimizerWorkerOutbound } from '../workers/claim-age-optimizer.worker';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type { Aggregate, HouseholdMemberPayload } from '../db/types';

const HH = 'hh-labels';

function member(id: string, firstName: string): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary: true,
      firstName,
      lastName: 'Demo',
      email: `${id}@example.test`,
      birthdate: '1965-01-01',
    },
  };
}

function scenario(id: string, name: string, claimAge: number | null): ScenarioAggregate {
  return {
    id,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name,
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides:
        claimAge === null
          ? {}
          : { socialSecurity: { primary: { ageYears: claimAge, ageMonths: 0 } } },
    },
  };
}

function winnerResult(scenarioId: string): OptimizerWorkerOutbound {
  return {
    kind: 'result',
    runId: 'run-1',
    scenarioId,
    winner: {
      primaryAgeYears: 70,
      secondaryAgeYears: null,
      metricValue: 1_200_000,
      alreadyAtOptimum: false,
    },
    partial: false,
    missingPiaMembers: [],
    baselineMetricValue: 1_000_000,
  };
}

// One scenario per row variant, so a single render covers every branch of the action column: Enabled and Already (ApplyButton's default and `alreadyAtOptimum` states), Missing PIAs, Past window, Unsupported, No retirement (the disabled row variants), and Methods (the two MethodChildRows).
const SCENARIOS: ScenarioAggregate[] = [
  scenario('s-enabled', 'Enabled', 62),
  scenario('s-already', 'Already', 70),
  scenario('s-missing-pia', 'Missing PIAs', 62),
  scenario('s-past-window', 'Past window', 62),
  scenario('s-unsupported', 'Unsupported', 62),
  scenario('s-empty', 'No retirement', 62),
  scenario('s-methods', 'Methods', 62),
];

const AGGREGATES: OptimizerAggregates = {
  scenarios: SCENARIOS,
  members: [member('m1', 'Alex')],
  accounts: [],
  balances: [],
  ssBenefits: [],
  expenses: [],
  incomeStreams: [],
  medicalCategoryIds: [],
};

function row(scenarioId: string, result: OptimizerWorkerOutbound): ScenarioRow {
  const s = SCENARIOS.find((entry) => entry.id === scenarioId);
  if (!s) throw new Error(`No scenario fixture: ${scenarioId}`);
  return { scenario: s, parentName: null, result, loading: false };
}

function allRows(): ScenarioRow[] {
  return [
    row('s-enabled', winnerResult('s-enabled')),
    row('s-already', winnerResult('s-already')),
    {
      ...row('s-missing-pia', {
        ...(winnerResult('s-missing-pia') as Extract<
          OptimizerWorkerOutbound,
          { kind: 'result' }
        >),
        missingPiaMembers: ['m1'],
      }),
    },
    row('s-past-window', {
      ...(winnerResult('s-past-window') as Extract<
        OptimizerWorkerOutbound,
        { kind: 'result' }
      >),
      winner: null,
    }),
    row('s-unsupported', {
      kind: 'unsupported',
      runId: 'run-1',
      scenarioId: 's-unsupported',
      reason: 'cbp-unconfigured',
    }),
    row('s-empty', {
      kind: 'empty',
      runId: 'run-1',
      scenarioId: 's-empty',
      reason: 'no-retirement-date',
    }),
    {
      ...row('s-methods', winnerResult('s-methods')),
      methods: {
        planned: { loading: false, result: winnerResult('s-methods') },
        twr: { loading: false, result: winnerResult('s-methods') },
      },
    },
  ];
}

function renderTable(running: boolean) {
  return render(
    <MemoryRouter>
      <OptimizerResultsTable
        rows={allRows()}
        aggregates={AGGREGATES}
        metric="balance"
        onApply={() => {}}
        running={running}
      />
    </MemoryRouter>,
  );
}

function tableRow(label: string): HTMLElement {
  const cell = screen.getByText(label);
  const found = cell.closest('[role="row"]');
  if (!found) throw new Error(`No table row rendering "${label}"`);
  return found as HTMLElement;
}

function actionButton(label: string): HTMLElement {
  return within(tableRow(label)).getByRole('button');
}

function expectNoRetiredActionLabels(): void {
  expect(screen.queryAllByRole('button', { name: 'Apply' })).toHaveLength(0);
  expect(screen.queryAllByRole('button', { name: 'Applied' })).toHaveLength(0);
}

describe('SS claim-age comparison action labels', () => {
  it('should_label_every_idle_state_save_to_scenario_or_already_set', () => {
    renderTable(false);

    expect(actionButton('Enabled')).toHaveAccessibleName('Save to scenario');
    expect(actionButton('Enabled')).not.toBeDisabled();
    expect(actionButton('Already')).toHaveAccessibleName('Already set');
    expect(actionButton('Already')).toBeDisabled();

    // All four disabled row variants carry the renamed label too; none is reachable from the page test's queries.
    for (const label of ['Missing PIAs', 'Past window', 'Unsupported', 'No retirement']) {
      expect(actionButton(label)).toHaveAccessibleName('Save to scenario');
      expect(actionButton(label)).toBeDisabled();
    }

    expect(actionButton('Planned')).toHaveAccessibleName('Save to scenario');
    expect(actionButton('Planned')).not.toBeDisabled();
    expect(actionButton('Historical')).toHaveAccessibleName('Save to scenario');

    expectNoRetiredActionLabels();
  });

  it('should_label_the_in_flight_state_save_to_scenario_on_both_buttons', () => {
    // `running === true` is a third state neither the enabled nor the already-set row covers: every row reads it for the whole of a deterministic or Monte Carlo sweep.
    renderTable(true);

    expect(actionButton('Enabled')).toHaveAccessibleName('Save to scenario');
    expect(actionButton('Enabled')).toBeDisabled();
    expect(actionButton('Planned')).toHaveAccessibleName('Save to scenario');
    expect(actionButton('Planned')).toBeDisabled();
    expect(actionButton('Historical')).toHaveAccessibleName('Save to scenario');
    expect(actionButton('Historical')).toBeDisabled();
    expect(actionButton('Already')).toHaveAccessibleName('Already set');

    expectNoRetiredActionLabels();
  });

  it('should_label_the_already_set_state_on_the_method_child_rows', () => {
    // `MethodApplyButton` derives `alreadyAtOptimum` itself, so its already-set branch needs its own scenario.
    render(
      <MemoryRouter>
        <OptimizerResultsTable
          rows={[
            {
              ...row('s-already', winnerResult('s-already')),
              methods: {
                planned: { loading: false, result: winnerResult('s-already') },
                twr: { loading: false, result: winnerResult('s-already') },
              },
            },
          ]}
          aggregates={AGGREGATES}
          metric="balance"
          onApply={() => {}}
          running={false}
        />
      </MemoryRouter>,
    );

    expect(actionButton('Planned')).toHaveAccessibleName('Already set');
    expect(actionButton('Planned')).toBeDisabled();
    expect(actionButton('Historical')).toHaveAccessibleName('Already set');

    expectNoRetiredActionLabels();
  });
});
