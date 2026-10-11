/**
 * FutureContributionsCard — interactive summary card (reset button +
 * ToggleSwitch), pulled out of ScenarioDetailPage.tsx to keep that file
 * under the shape limit. Per AGENTS.md's a11y-smoke rule, an interactive
 * component landing in a new file under `components/` needs its own
 * `expectNoA11yViolations` assertion — `ScenarioDetailPage.test.tsx`
 * doesn't carry one.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ScenarioAggregate } from '../../lib/scenario-resolution';
import { FutureContributionsCard } from './FutureContributionsCard';
import { expectNoA11yViolations } from '../../test/a11y';

function makeScenario(over: Partial<ScenarioAggregate['payload']> = {}): ScenarioAggregate {
  return {
    id: 'scn-1',
    householdId: 'hh-1',
    schemaVersion: 1,
    version: 1,
    updatedAt: new Date().toISOString(),
    deviceId: 'dev-1',
    aggregateType: 'scenario',
    payload: {
      name: 'Base',
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {},
      ...over,
    },
  } as ScenarioAggregate;
}

describe('FutureContributionsCard', () => {
  it('has no a11y violations', async () => {
    const { container } = render(
      <FutureContributionsCard
        scenario={makeScenario()}
        scenarios={[makeScenario()]}
        onToggle={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    await expectNoA11yViolations(container);
  });

  it('reflects the effective stopContributionsToday value on the toggle', () => {
    const scenario = makeScenario({
      overrides: { contributions: { stopContributionsToday: true } },
    });
    render(
      <FutureContributionsCard
        scenario={scenario}
        scenarios={[scenario]}
        onToggle={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(
      screen.getByRole('switch', { name: 'Stop contributing today' }),
    ).toBeChecked();
  });

  it('fires onToggle(next) when the switch is clicked', async () => {
    const onToggle = vi.fn();
    const scenario = makeScenario({
      overrides: { contributions: { stopContributionsToday: false } },
    });
    const user = userEvent.setup();
    render(
      <FutureContributionsCard
        scenario={scenario}
        scenarios={[scenario]}
        onToggle={onToggle}
        onResetToInherited={() => {}}
      />,
    );
    await user.click(screen.getByRole('switch', { name: 'Stop contributing today' }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});
