/**
 * AssetAllocationCard and AssetAllocationModal — display and intro-copy contracts.
 *
 * AssetAllocationCard (base-scenario display behaviour):
 *   Pins the base-scenario rule:
 *   on the base scenario the card shows its effective value even
 *   with no local override ("Off" when no allocation is configured), and
 *   the accent tint (`bg-accent-subtle`) never appears on the base scenario
 *   regardless of override state (tint guard).
 *
 * AssetAllocationModal (intro-copy + percent-format contracts):
 *   Pins the scenario-modal copy convention:
 *   the modal opens with a plain-English
 *   `<p className="m-0 text-sm">` intro paragraph before any form control, at
 *   the page-baseline body-copy size (`text-sm` pinned-size rule).
 *   Percent-format consistency: the read-only income-share `Muted` labels
 *   route through `formatPercent()`, which always renders one decimal — so the
 *   derived share reads `25.0% income`, not `25% income`. The growth sliders'
 *   spoken value (formatAriaValue) is also aligned to one decimal, matching the
 *   visible badge format.
 */
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

// ── Factory helpers for AssetAllocationModal tests ──────────────────────────

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

// ── Factory helper for AssetAllocationCard tests ─────────────────────────────

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

// ── AssetAllocationCard — base-scenario display ───────────────────────────────

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

// ── AssetAllocationModal — intro copy ────────────────────────────────────────

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

// ── AssetAllocationModal — income-share format ────────────────────────────────

describe('AssetAllocationModal — income-share format', () => {
  it('shows the initial income share with one decimal (formatPercent)', () => {
    // startGrowthPct 75 → incomeShare 25 → "25.0% income", not "25% income".
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
    // endGrowthPct 30 → endIncomeShare 70 → "70.0% income".
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

// ── AssetAllocationModal — slider aria-valuetext format ───────────────────────

describe('AssetAllocationModal — slider aria-valuetext format', () => {
  // RangeSlider exposes the spoken value via an `aria-describedby` channel
  // (a visually-hidden sibling span holding `formatAriaValue(value)`), not
  // a native `aria-valuetext` attribute — see components/RangeSlider.tsx,
  // which deliberately keeps the value OUT of the slider's accessible NAME.
  // So the screen-reader-announced value is the slider's accessible
  // DESCRIPTION; `toHaveAccessibleDescription` resolves that channel.
  // These tests pin the growth sliders' announcement to the one-decimal
  // badge format (`50.0% growth`), guarding the formatAriaValue alignment
  // fix from silently regressing back to integer-only (`50 percent growth`).
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
    // endGrowthPct non-null + endYear seeds glideOn=true, mounting the
    // "End growth percentage" slider.
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
