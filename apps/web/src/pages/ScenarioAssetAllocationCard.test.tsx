// AssetAllocationCard and AssetAllocationModal: base-scenario display (effective value with no override, no `bg-accent-subtle` tint), the intro paragraph and one-decimal percent formats.
import 'fake-indexeddb/auto';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AssetAllocationCard,
  AssetAllocationModal,
} from './ScenarioAssetAllocationCard';
import { clearAllStores } from '../db/store';
import type {
  Aggregate,
  HouseholdMemberPayload,
  RetirementAllocationOverride,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

const HH = 'hh-test';

function makeMember(): Aggregate<HouseholdMemberPayload> {
  return {
    id: 'hm-primary',
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary: true,
      firstName: 'Alex',
      lastName: 'Demo',
      email: 'alex@example.test',
      birthdate: '1960-04-15',
    },
  };
}

function makeScenario(
  allocation?: RetirementAllocationOverride,
): ScenarioAggregate {
  return {
    id: 'sc-base',
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
      isPrimary: true,
      notes: '',
      overrides: allocation ? { retirementAllocation: allocation } : {},
    },
  };
}

const allocScenario = (
  id: string,
  retirementAllocation?: RetirementAllocationOverride,
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
    overrides: retirementAllocation ? { retirementAllocation } : {},
  } satisfies ScenarioPayload,
});

afterEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
});

describe('AssetAllocationCard — base scenario', () => {
  it('shows the effective default "Off" on the base scenario when no override set', () => {
    const s = allocScenario('s');
    render(
      <AssetAllocationCard
        scenario={s}
        scenarios={[s]}
        primaryMember={null}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.queryByText('No scenario overrides.')).not.toBeInTheDocument();
  });

  it('does not apply the accent tint on the base scenario even with a local override', () => {
    const override: RetirementAllocationOverride = {
      growthRatePct: 7,
      incomeRatePct: 3,
      startGrowthPct: 50,
      endGrowthPct: null,
      endYear: null,
    };
    const s = allocScenario('s', override);
    const { container } = render(
      <AssetAllocationCard
        scenario={s}
        scenarios={[s]}
        primaryMember={null}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    const card = container.querySelector('section');
    expect(card).not.toBeNull();
    expect(card?.className).not.toContain('bg-accent-subtle');
  });
});

describe('AssetAllocationModal — intro copy', () => {
  it('renders a plain-English intro paragraph at text-sm', () => {
    const scenario = makeScenario();
    render(
      <AssetAllocationModal
        scenario={scenario}
        scenarios={[scenario]}
        primaryMember={makeMember()}
        householdId={HH}
        onClose={vi.fn()}
      />,
    );
    const intro = screen.getByText(/Split your retirement savings/i);
    expect(intro.tagName).toBe('P');
    expect(intro).toHaveClass('text-sm');
  });
});

describe('AssetAllocationModal — income-share format', () => {
  it('shows the initial income share with one decimal (formatPercent)', () => {
    const scenario = makeScenario({
      growthRatePct: 7,
      incomeRatePct: 3,
      startGrowthPct: 75,
      endGrowthPct: null,
      endYear: null,
      glideStartYear: null,
      incomeOnlyYear: null,
    });
    render(
      <AssetAllocationModal
        scenario={scenario}
        scenarios={[scenario]}
        primaryMember={makeMember()}
        householdId={HH}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('25.0% income')).toBeInTheDocument();
    expect(screen.queryByText('25% income')).not.toBeInTheDocument();
  });

  it('shows the glide end income share with one decimal (formatPercent)', () => {
    const scenario = makeScenario({
      growthRatePct: 7,
      incomeRatePct: 3,
      startGrowthPct: 50,
      endGrowthPct: 30,
      endYear: 2050,
      glideStartYear: 2030,
      incomeOnlyYear: null,
    });
    render(
      <AssetAllocationModal
        scenario={scenario}
        scenarios={[scenario]}
        primaryMember={makeMember()}
        householdId={HH}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('70.0% income')).toBeInTheDocument();
    expect(screen.queryByText('70% income')).not.toBeInTheDocument();
  });
});

describe('AssetAllocationModal — slider aria-valuetext format', () => {
  // RangeSlider exposes the spoken value through `aria-describedby` (a visually hidden span holding `formatAriaValue(value)`), not `aria-valuetext`, so the announced value is the slider's accessible description. These tests pin it to the one-decimal badge format (`50.0% growth`).
  it('initial growth slider announces one-decimal growth value (formatAriaValue)', () => {
    const scenario = makeScenario({
      growthRatePct: 7,
      incomeRatePct: 3,
      startGrowthPct: 50,
      endGrowthPct: null,
      endYear: null,
      glideStartYear: null,
      incomeOnlyYear: null,
    });
    render(
      <AssetAllocationModal
        scenario={scenario}
        scenarios={[scenario]}
        primaryMember={makeMember()}
        householdId={HH}
        onClose={vi.fn()}
      />,
    );
    const slider = screen.getByRole('slider', {
      name: 'Initial growth allocation',
    });
    expect(slider).toHaveAccessibleDescription('50.0% growth');
  });

  it('glide end growth slider announces one-decimal growth value (formatAriaValue)', () => {
    const scenario = makeScenario({
      growthRatePct: 7,
      incomeRatePct: 3,
      startGrowthPct: 50,
      endGrowthPct: 30,
      endYear: 2050,
      glideStartYear: 2030,
      incomeOnlyYear: null,
    });
    render(
      <AssetAllocationModal
        scenario={scenario}
        scenarios={[scenario]}
        primaryMember={makeMember()}
        householdId={HH}
        onClose={vi.fn()}
      />,
    );
    const slider = screen.getByRole('slider', {
      name: 'End growth percentage',
    });
    expect(slider).toHaveAccessibleDescription('30.0% growth');
  });
});
