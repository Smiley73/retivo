// LifeExpectancyCard base-scenario display (effective "To 95 years." with no override, no `bg-accent-subtle` tint) and summary copy.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Aggregate, HouseholdMemberPayload, LifeExpectancyOverride, ScenarioPayload } from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import { LifeExpectancyCard, LifeExpectancyModal } from './ScenarioExpenseSubsectionCards';

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

const member = (id: string, isPrimary: boolean, firstName: string): Aggregate<HouseholdMemberPayload> => ({
  id,
  householdId: HH,
  aggregateType: 'householdMember',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'dev-1',
  payload: { isPrimary, firstName, lastName: '', email: '', birthdate: '1960-01-01' },
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

describe('LifeExpectancyCard — summary copy', () => {
  it.each([
    ['capitalises the leading sentence when firstName is blank', '', '', { primary: 90, secondary: 88 }, 'Primary to 90 years, secondary to 88 years.'],
    ['keeps firstName as-is at the leading position', 'Robert', 'Jane', { primary: 92, secondary: 90 }, 'Robert to 92 years, Jane to 90 years.'],
  ])('%s', (_title, primaryName, secondaryName, override, text) => {
    const s = lifeScenario('s', override);
    render(
      <LifeExpectancyCard
        scenario={s}
        scenarios={[s]}
        primaryMember={member('m1', true, primaryName)}
        secondaryMember={member('m2', false, secondaryName)}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});

describe('LifeExpectancyModal — intro copy', () => {
  it('renders a plain-English intro paragraph at text-sm', () => {
    render(
      <LifeExpectancyModal
        scenario={lifeScenario('s')}
        primaryMember={member('m1', true, 'Robert')}
        secondaryMember={null}
        householdId={HH}
        onClose={() => {}}
      />,
    );
    const intro = screen.getByText(/Set how long to plan for each member to live/i);
    expect(intro.tagName).toBe('P');
    expect(intro).toHaveClass('text-sm');
  });
});
