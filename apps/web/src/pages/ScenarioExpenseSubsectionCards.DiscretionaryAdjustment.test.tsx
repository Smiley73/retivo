// DiscretionaryAdjustmentCard and Modal: the bipolar slider domain (-100..+100), formatValue / formatAriaValue contracts, summary copy and the save→IndexedDB round trip.
import 'fake-indexeddb/auto';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  listAggregates,
  putAggregate,
} from '../db/store';
import type { ScenarioPayload } from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import { setRegisteredDeviceId } from '../sync/device-id';
import { expectNoA11yViolations } from '../test/a11y';

vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import { useSync } from '../sync/SyncContext';
import {
  DiscretionaryAdjustmentCard,
  DiscretionaryAdjustmentModal,
} from './ScenarioExpenseSubsectionCards';

const HH = 'hh-test';

function setupSync() {
  (useSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    notifyPending: vi.fn(),
    state: { kind: 'synced', lastSyncedAt: null },
  });
}

const discScenario = (
  id: string,
  discretionarySpending?: ScenarioPayload['overrides']['discretionarySpending'],
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
    overrides: discretionarySpending ? { discretionarySpending } : {},
  },
});

describe('DiscretionaryAdjustmentCard', () => {
  beforeEach(() => {
    setupSync();
  });

  it('renders card title "Discretionary adjustment"', () => {
    const s = discScenario('s');
    render(
      <DiscretionaryAdjustmentCard
        scenario={s}
        scenarios={[s]}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(screen.getByText('Discretionary adjustment')).toBeInTheDocument();
  });

  it('shows "No scenario overrides." on a non-base scenario when no override set', () => {
    const s = discScenario('s', undefined, false);
    render(
      <DiscretionaryAdjustmentCard
        scenario={s}
        scenarios={[s]}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(screen.getByText('No scenario overrides.')).toBeInTheDocument();
  });

  it('shows effective default "No discretionary adjustment." on the base scenario when no override set', () => {
    const s = discScenario('s');
    render(
      <DiscretionaryAdjustmentCard
        scenario={s}
        scenarios={[s]}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(screen.getByText('No discretionary adjustment.')).toBeInTheDocument();
    expect(screen.queryByText('No scenario overrides.')).not.toBeInTheDocument();
  });

  // Minus is U+2212; stored values outside -100..+100 are clamped to match the projection math.
  it.each([
    ['bumpPct=0', { bumpPct: 0, durationYears: null }, 'No discretionary adjustment.'],
    ['a positive bumpPct with a "+" prefix', { bumpPct: 25, durationYears: null }, '+25% on discretionary spending, whole retirement.'],
    ['a negative bumpPct with U+2212', { bumpPct: -25, durationYears: null }, '−25% on discretionary spending, whole retirement.'],
    ['durationYears when set', { bumpPct: 10, durationYears: 3 }, '+10% on discretionary spending for the first 3 years.'],
    ['a stored bumpPct=200 clamped to +100%', { bumpPct: 200, durationYears: null }, '+100% on discretionary spending, whole retirement.'],
    ['a stored bumpPct=-150 clamped to −100%', { bumpPct: -150, durationYears: null }, '−100% on discretionary spending, whole retirement.'],
  ])('summarises %s', (_title, override, text) => {
    const s = discScenario('s', override);
    render(
      <DiscretionaryAdjustmentCard
        scenario={s}
        scenarios={[s]}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});

describe('DiscretionaryAdjustmentModal', () => {
  beforeEach(async () => {
    setRegisteredDeviceId('dev-test');
    setupSync();
    await clearAllStores();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders modal title "Discretionary spending adjustment"', async () => {
    const s = discScenario('s');
    const { container } = render(
      <DiscretionaryAdjustmentModal
        scenario={s}
        householdId={HH}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Discretionary spending adjustment')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('renders a plain-English intro paragraph at text-sm before the controls', () => {
    const s = discScenario('s');
    render(
      <DiscretionaryAdjustmentModal
        scenario={s}
        householdId={HH}
        onClose={() => {}}
      />,
    );
    const intro = screen.getByText(
      /Raise or lower your optional, non-essential spending/i,
    );
    expect(intro.tagName).toBe('P');
    expect(intro).toHaveClass('text-sm');
  });

  it('renders FieldGroup legend "Adjustment amount"', () => {
    const s = discScenario('s');
    render(
      <DiscretionaryAdjustmentModal
        scenario={s}
        householdId={HH}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Adjustment amount')).toBeInTheDocument();
  });

  it('slider has aria-label "Discretionary adjustment percentage"', () => {
    const s = discScenario('s');
    render(
      <DiscretionaryAdjustmentModal
        scenario={s}
        householdId={HH}
        onClose={() => {}}
      />,
    );
    expect(
      screen.getByRole('slider', { name: 'Discretionary adjustment percentage' }),
    ).toBeInTheDocument();
  });

  it('slider domain is min=-100 max=100 step=5', () => {
    const s = discScenario('s');
    render(
      <DiscretionaryAdjustmentModal
        scenario={s}
        householdId={HH}
        onClose={() => {}}
      />,
    );
    const slider = screen.getByRole('slider', {
      name: 'Discretionary adjustment percentage',
    });
    expect(slider).toHaveAttribute('min', '-100');
    expect(slider).toHaveAttribute('max', '100');
    expect(slider).toHaveAttribute('step', '5');
  });

  it.each([
    [0, 'No adjustment'],
    [25, '+25%'],
    [-25, '−25%'],
    [100, '+100%'],
    [-100, '−100%'],
  ] as [number, string][])(
    'formatValue(%i) → "%s"',
    (value, expected) => {
      const s = discScenario('s', { bumpPct: value, durationYears: null });
      render(
        <DiscretionaryAdjustmentModal
          scenario={s}
          householdId={HH}
          onClose={() => {}}
        />,
      );
      // The visible badge renders the formatValue output (aria-hidden); getAllByText covers the sr-only plus visible duplicate for value=0.
      expect(screen.getAllByText(expected).length).toBeGreaterThanOrEqual(1);
    },
  );

  it.each([
    [0, 'No adjustment'],
    [25, 'plus 25 percent'],
    [-25, 'minus 25 percent'],
  ] as [number, string][])(
    'formatAriaValue(%i) → "%s" (accessible description)',
    (value, expected) => {
      const s = discScenario('s', { bumpPct: value, durationYears: null });
      render(
        <DiscretionaryAdjustmentModal
          scenario={s}
          householdId={HH}
          onClose={() => {}}
        />,
      );
      const slider = screen.getByRole('slider', {
        name: 'Discretionary adjustment percentage',
      });
      expect(slider).toHaveAccessibleDescription(expected);
    },
  );

  it('Duration FieldGroup is enabled (not disabled) for negative bumpPct', () => {
    const s = discScenario('s', { bumpPct: -25, durationYears: null });
    render(
      <DiscretionaryAdjustmentModal
        scenario={s}
        householdId={HH}
        onClose={() => {}}
      />,
    );
    const group = screen.getByRole('group', { name: 'Duration' });
    expect(group).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('Save persists discretionarySpending override to IndexedDB', async () => {
    const s = discScenario('s');
    await putAggregate('scenario', s);

    const user = userEvent.setup();
    render(
      <DiscretionaryAdjustmentModal
        scenario={s}
        householdId={HH}
        onClose={() => {}}
      />,
    );

    const slider = screen.getByRole('slider', {
      name: 'Discretionary adjustment percentage',
    });
    slider.focus();
    for (let i = 0; i < 5; i++) {
      await user.keyboard('{ArrowRight}');
    }

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const scenarios = await listAggregates('scenario');
      const saved = scenarios.find((a) => a.id === 's');
      expect((saved?.payload as ScenarioPayload).overrides.discretionarySpending?.bumpPct).toBe(25);
    });
  });

  it('Save persists negative bumpPct and durationYears to IndexedDB', async () => {
    const s = discScenario('s', { bumpPct: -50, durationYears: 5 });
    await putAggregate('scenario', s);

    const user = userEvent.setup();
    render(
      <DiscretionaryAdjustmentModal
        scenario={s}
        householdId={HH}
        onClose={() => {}}
      />,
    );

    // Seeded with durationYears=5, so the modal starts on "First N years"; switch away and back to prove the radio is interactive.
    await user.click(screen.getByRole('radio', { name: 'Whole retirement' }));
    await user.click(screen.getByRole('radio', { name: 'First N years' }));

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const scenarios = await listAggregates('scenario');
      const saved = scenarios.find((a) => a.id === 's');
      const override = (saved?.payload as ScenarioPayload).overrides.discretionarySpending;
      expect(override?.bumpPct).toBe(-50);
      expect(override?.durationYears).toBe(5);
    });
  });

});
