// InflationCard base-scenario display: the effective per-category summary with no local override (Medical defaults to general + 2pp), and no `bg-accent-subtle` tint on the base scenario.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { InflationOverride, ScenarioPayload } from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import { InflationCard } from './ScenarioExpenseSubsectionCards';

const HH = 'hh-test';

const inflationScenario = (
  id: string,
  inflation?: InflationOverride,
  isPrimary = true,
): ScenarioAggregate => ({
  id,
  householdId: HH,
  aggregateType: 'scenario',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'dev-1',
  payload: {
    name: 'Base',
    description: '',
    parentScenarioId: null,
    isPrimary,
    notes: '',
    overrides: inflation ? { inflation } : {},
  } satisfies ScenarioPayload,
});

describe('InflationCard — base scenario', () => {
  it('shows the per-category summary on the base scenario when no override set', () => {
    const s = inflationScenario('s');
    render(
      <InflationCard
        scenario={s}
        scenarios={[s]}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(screen.getByText('General 3.0% · Medical 5.0%')).toBeInTheDocument();
    expect(screen.queryByText('No scenario overrides.')).not.toBeInTheDocument();
  });

  it('summarises an explicit general rate + a custom category override', () => {
    const s = inflationScenario('s', {
      ratePct: 4,
      categoryRates: { 'cat-food': 2 },
    });
    render(
      <InflationCard
        scenario={s}
        scenarios={[s]}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(
      screen.getByText('General 4.0% · Medical 6.0% · +1 custom'),
    ).toBeInTheDocument();
  });

  it('shows "No scenario overrides." on a non-base scenario when no override set', () => {
    const s = inflationScenario('s', undefined, false);
    render(
      <InflationCard
        scenario={s}
        scenarios={[s]}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(screen.getByText('No scenario overrides.')).toBeInTheDocument();
  });

  it('does not apply the accent tint on the base scenario even with a local override', () => {
    const override: InflationOverride = { ratePct: 4 };
    const s = inflationScenario('s', override);
    const { container } = render(
      <InflationCard
        scenario={s}
        scenarios={[s]}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    const card = container.querySelector('section');
    expect(card).not.toBeNull();
    expect(card?.className).not.toContain('bg-accent-subtle');
  });
});
