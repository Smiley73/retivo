/**
 * Tests for DiscretionaryAdjustmentCard and DiscretionaryAdjustmentModal.
 *
 * Pins the bipolar slider domain (-100..+100), formatValue /
 * formatAriaValue contracts, active-state card summary copy (U+2212 minus
 * sign, clamped stored values), and save→IndexedDB round-trip via
 * fake-indexeddb.
 */
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

  it('shows active summary with "No discretionary adjustment." for bumpPct=0', () => {
    const s = discScenario('s', { bumpPct: 0, durationYears: null });
    render(
      <DiscretionaryAdjustmentCard
        scenario={s}
        scenarios={[s]}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(screen.getByText('No discretionary adjustment.')).toBeInTheDocument();
  });

  it('shows positive bumpPct with "+" prefix in summary', () => {
    const s = discScenario('s', { bumpPct: 25, durationYears: null });
    render(
      <DiscretionaryAdjustmentCard
        scenario={s}
        scenarios={[s]}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    // Contains "+25%" (whole retirement)
    expect(
      screen.getByText('+25% on discretionary spending, whole retirement.'),
    ).toBeInTheDocument();
  });

  it('shows negative bumpPct with U+2212 minus sign in summary', () => {
    const s = discScenario('s', { bumpPct: -25, durationYears: null });
    render(
      <DiscretionaryAdjustmentCard
        scenario={s}
        scenarios={[s]}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    // U+2212 (−) not ASCII hyphen (-)
    expect(
      screen.getByText('−25% on discretionary spending, whole retirement.'),
    ).toBeInTheDocument();
  });

  it('shows duration in summary when durationYears set', () => {
    const s = discScenario('s', { bumpPct: 10, durationYears: 3 });
    render(
      <DiscretionaryAdjustmentCard
        scenario={s}
        scenarios={[s]}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(
      screen.getByText('+10% on discretionary spending for the first 3 years.'),
    ).toBeInTheDocument();
  });

  it('clamps stored bumpPct=200 to +100% in summary', () => {
    // Legacy stored value outside the UI domain → card must show clamped value
    // matching the projection math, not the raw stored "+200%".
    const s = discScenario('s', { bumpPct: 200, durationYears: null });
    render(
      <DiscretionaryAdjustmentCard
        scenario={s}
        scenarios={[s]}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(
      screen.getByText('+100% on discretionary spending, whole retirement.'),
    ).toBeInTheDocument();
  });

  it('clamps stored bumpPct=-150 to −100% in summary', () => {
    // U+2212 (−) not ASCII hyphen (-); clamped to −100 not −150.
    const s = discScenario('s', { bumpPct: -150, durationYears: null });
    render(
      <DiscretionaryAdjustmentCard
        scenario={s}
        scenarios={[s]}
        onConfigure={() => {}}
        onResetToInherited={() => {}}
      />,
    );
    expect(
      screen.getByText('−100% on discretionary spending, whole retirement.'),
    ).toBeInTheDocument();
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
    // Scenario-modal copy convention: the modal
    // opens with a `<p className="m-0 text-sm">` plain-English intro before any
    // form control (pinned body-copy size).
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
      // The visible badge span renders the formatValue output (aria-hidden).
      // getAllByText handles the sr-only + visible duplicate for value=0.
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
    // When bumpPct !== 0 the Duration group should NOT carry aria-disabled.
    // The FieldGroup renders a div with role="group"; check it lacks aria-disabled.
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

    // Slider starts at 0 — step up 5 ticks to reach +25
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
    // Seed modal with bumpPct=-50, durationYears=5, switch to "First N
    // years", save, assert the persisted override is { bumpPct: -50, durationYears: 5 }.
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

    // The scenario is seeded with durationYears=5, so the modal initialises
    // to "First N years" already. Switch to "Whole retirement" then back to
    // "First N years" to confirm the Duration radio is interactive.
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
