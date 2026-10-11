/**
 * Tests for LifeExpectancyCard — base-scenario display behaviour.
 *
 * Pins the base-scenario rule:
 * on the base scenario the card shows its effective value even
 * with no local override ("To 95 years." when no override is configured),
 * and the accent tint (`bg-accent-subtle`) never appears on the base
 * scenario regardless of override state (tint guard).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LifeExpectancyOverride, ScenarioPayload } from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import { LifeExpectancyCard } from './ScenarioExpenseSubsectionCards';

const HH = 'hh-test';

const lifeScenario = (
  id: string,
  lifeExpectancy?: LifeExpectancyOverride,
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
    overrides: lifeExpectancy ? { lifeExpectancy } : {},
  } satisfies ScenarioPayload,
});

describe('LifeExpectancyCard — base scenario', () => {
  it('shows the effective default "To 95 years." on the base scenario when no override set', () => {
    const s = lifeScenario('s');
    render(
      <LifeExpectancyCard
        scenario={s}
        scenarios={[s]}
        primaryMember={null}
        secondaryMember={null}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(screen.getByText('To 95 years.')).toBeInTheDocument();
    expect(screen.queryByText('No scenario overrides.')).not.toBeInTheDocument();
  });

  it('shows "No scenario overrides." on a non-base scenario when no override set', () => {
    const s = lifeScenario('s', undefined, false);
    render(
      <LifeExpectancyCard
        scenario={s}
        scenarios={[s]}
        primaryMember={null}
        secondaryMember={null}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(screen.getByText('No scenario overrides.')).toBeInTheDocument();
  });

  it('does not apply the accent tint on the base scenario even with a local override', () => {
    const override: LifeExpectancyOverride = { primary: 90 };
    const s = lifeScenario('s', override);
    const { container } = render(
      <LifeExpectancyCard
        scenario={s}
        scenarios={[s]}
        primaryMember={null}
        secondaryMember={null}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    const card = container.querySelector('section');
    expect(card).not.toBeNull();
    expect(card?.className).not.toContain('bg-accent-subtle');
  });
});
