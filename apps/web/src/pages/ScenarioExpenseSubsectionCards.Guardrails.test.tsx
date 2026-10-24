// DownturnGuardrailsCard and Modal: the enable toggle and band/step/cap fields, validation rejection (inverted or out-of-range bands block Save) and the save→IndexedDB round trip.
import 'fake-indexeddb/auto';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllStores, listAggregates, putAggregate } from '../db/store';
import type { DownturnGuardrailsOverride, ScenarioPayload } from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import { setRegisteredDeviceId } from '../sync/device-id';
import { expectNoA11yViolations } from '../test/a11y';

vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import { useSync } from '../sync/SyncContext';
import {
  DownturnGuardrailsCard,
  DownturnGuardrailsModal,
} from './ScenarioExpenseSubsectionCards';

const HH = 'hh-test';

function setupSync() {
  (useSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    notifyPending: vi.fn(),
    state: { kind: 'synced', lastSyncedAt: null },
  });
}

const scenario = (
  id: string,
  guardrails?: DownturnGuardrailsOverride,
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
    overrides: guardrails ? { downturnGuardrails: guardrails } : {},
  } as ScenarioPayload,
});

const ON: DownturnGuardrailsOverride = {
  enabled: true,
  lowerBandPct: 85,
  upperBandPct: 115,
  stepPct: 10,
  maxRaisePct: 120,
};

describe('DownturnGuardrailsCard', () => {
  beforeEach(() => setupSync());

  it('renders the card title', () => {
    const s = scenario('s');
    render(
      <DownturnGuardrailsCard scenario={s} scenarios={[s]} onConfigure={() => {}} onResetToInherited={() => {}} />,
    );
    expect(screen.getByText('Spending guardrails')).toBeInTheDocument();
  });

  it('shows the ON summary with the configured bands and the discretionary floor', () => {
    // ON carries no discretionaryFloorPct, so the summary and slider fall back to the default (50).
    const s = scenario('s', ON);
    render(
      <DownturnGuardrailsCard scenario={s} scenarios={[s]} onConfigure={() => {}} onResetToInherited={() => {}} />,
    );
    expect(
      screen.getByText(
        'On — cut below 85% (keep 50% discretionary), raise above 115%, 10% steps, raise cap 120%.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the configured discretionary floor in the ON summary when set explicitly', () => {
    const s = scenario('s', { ...ON, discretionaryFloorPct: 25 });
    render(
      <DownturnGuardrailsCard scenario={s} scenarios={[s]} onConfigure={() => {}} onResetToInherited={() => {}} />,
    );
    expect(
      screen.getByText(
        'On — cut below 85% (keep 25% discretionary), raise above 115%, 10% steps, raise cap 120%.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the OFF summary on the base scenario when unset', () => {
    const s = scenario('s');
    render(
      <DownturnGuardrailsCard scenario={s} scenarios={[s]} onConfigure={() => {}} onResetToInherited={() => {}} />,
    );
    expect(
      screen.getByText('Off — spending stays fixed regardless of market ups and downs.'),
    ).toBeInTheDocument();
  });
});

describe('DownturnGuardrailsModal', () => {
  beforeEach(async () => {
    setRegisteredDeviceId('dev-test');
    setupSync();
    await clearAllStores();
  });
  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders a plain-English intro paragraph at text-sm', () => {
    const s = scenario('s');
    render(<DownturnGuardrailsModal scenario={s} householdId={HH} onClose={() => {}} />);
    const intro = screen.getByText(/Guardrails automatically trim your spending/i);
    expect(intro.tagName).toBe('P');
    expect(intro).toHaveClass('text-sm');
  });

  it('persists an enabled guardrail config to IndexedDB and reloads it', async () => {
    const s = scenario('s');
    await putAggregate('scenario', s);
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DownturnGuardrailsModal scenario={s} householdId={HH} onClose={onClose} />);

    await user.click(screen.getByRole('switch', { name: /Use spending guardrails/i }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const scenarios = (await listAggregates('scenario')) as ScenarioAggregate[];
      const cfg = scenarios[0]?.payload.overrides.downturnGuardrails;
      expect(cfg?.enabled).toBe(true);
      expect(cfg?.lowerBandPct).toBe(85);
      expect(cfg?.upperBandPct).toBe(115);
    });
    // The persist gate does not imply the close callback has fired (it runs after the save resolves), so re-query rather than assert once.
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
  });

  it('adjusts a band via the slider (keyboard) and persists the new value', async () => {
    const s = scenario('s', ON);
    await putAggregate('scenario', s);
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DownturnGuardrailsModal scenario={s} householdId={HH} onClose={onClose} />);

    const lowerBandSlider = screen.getByRole('slider', {
      name: /Cut spending when savings cover below/i,
    });
    lowerBandSlider.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const scenarios = (await listAggregates('scenario')) as ScenarioAggregate[];
      const cfg = scenarios[0]?.payload.overrides.downturnGuardrails;
      expect(cfg?.lowerBandPct).toBe(88); // ON.lowerBandPct (85) + 3 ArrowRight steps of 1
      expect(cfg?.upperBandPct).toBe(ON.upperBandPct); // untouched
    });
    // Re-query: the close callback fires after the save resolves.
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
  });

  it('renders the discretionary-floor slider seeded from the default (50) and persists an adjusted value', async () => {
    const s = scenario('s', ON);
    await putAggregate('scenario', s);
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DownturnGuardrailsModal scenario={s} householdId={HH} onClose={onClose} />);

    const floorSlider = screen.getByRole('slider', {
      name: /Keep at least this much discretionary/i,
    });
    expect(floorSlider).toBeInTheDocument();
    floorSlider.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const scenarios = (await listAggregates('scenario')) as ScenarioAggregate[];
      const cfg = scenarios[0]?.payload.overrides.downturnGuardrails;
      expect(cfg?.discretionaryFloorPct).toBe(60); // 50 + 2 × step(5)
      expect(cfg?.maxRaisePct).toBe(ON.maxRaisePct); // untouched
    });
    // Re-query: the close callback fires after the save resolves.
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
  });

  it('REJECTS an inverted config (lower ≥ upper) while enabled — Save is blocked', async () => {
    const s = scenario('s', { ...ON, lowerBandPct: 130, upperBandPct: 110 });
    await putAggregate('scenario', s);
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DownturnGuardrailsModal scenario={s} householdId={HH} onClose={onClose} />);

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(
      screen.getByText(/lower band must be below the upper band/i),
    ).toBeInTheDocument();

    await user.click(save);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a11y: modal has no axe violations', async () => {
    const s = scenario('s', ON);
    const { container } = render(
      <DownturnGuardrailsModal scenario={s} householdId={HH} onClose={() => {}} />,
    );
    await expectNoA11yViolations(container);
  });
});
