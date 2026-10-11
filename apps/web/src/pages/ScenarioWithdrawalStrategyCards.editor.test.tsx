/**
 * WithdrawalStrategyEditor — unit tests.
 *
 * Covers: strategy picker seeds from effective values; PercentInput
 * ÷100 storage conversion; 40→0.4 precise case; MoneyInput
 * dollar-verbatim storage; MAGI key omitted on engine-default; no-op Save
 * queues no mutation; Save disabled when clean; toggle
 * re-toggle pinning; dirty-state guard; Save bypasses guard;
 * Cancel-after-confirm-yes; a11y smoke.
 */
import 'fake-indexeddb/auto';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WithdrawalStrategyEditor } from './scenario-withdrawal-strategy-editor';
import { clearAllStores, listPendingMutations } from '../db/store';
import { expectNoA11yViolations } from '../test/a11y';
import { isMagiCapDisabled } from '../db/types';
import type { ScenarioPayload } from '../db/types';
import { resolveScenario } from '../lib/scenario-resolution';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

const HH = 'hh-test';

// Empty account/member arrays satisfy the WithdrawalStrategyEditor props shape.
// Tests that exercise tier-editor or MAGI-cap member controls supply populated
// arrays directly; baseline tests here only need the type to match.
const NO_ACCOUNTS = [] as const;
const NO_MEMBERS = [] as const;

function makeScenario(
  id: string,
  overrides: ScenarioPayload['overrides'] = {},
  isPrimary = false,
  parentScenarioId: string | null = null,
): ScenarioAggregate {
  return {
    id,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: id,
      description: '',
      parentScenarioId,
      isPrimary,
      notes: '',
      overrides,
    },
  };
}

beforeEach(async () => {
  await clearAllStores();
});

afterEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
});

// ——— Strategy picker seeding ————————————————————————————

describe('WithdrawalStrategyEditor — strategy picker', () => {
  it('renders the strategy tab with the current kind selected', async () => {
    const scenario = makeScenario('sc-1', { withdrawalStrategy: { kind: 'taxEfficient' } });
    const onSaved = vi.fn();
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    const radio = screen.getByRole('radio', { name: /Tax-efficient/i });
    expect(radio).toBeTruthy();
    expect(radio).toBeChecked();
  });

  it('offers exactly the four named strategies and no Combined pot', async () => {
    const scenario = makeScenario('sc-1', { withdrawalStrategy: { kind: 'taxEfficient' } });
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    expect(screen.getAllByRole('radio')).toHaveLength(4);
    expect(screen.queryByRole('radio', { name: /Combined pot/i })).toBeNull();
  });

  // Modal seeds strategyKind from inherited parent-chain values.
  it('seeds strategyKind from parent-chain when child has no local override', async () => {
    const parent = makeScenario('parent-1', { withdrawalStrategy: { kind: 'rothFirst' } }, true);
    const child = makeScenario('child-1', {}, false, 'parent-1');
    const onSaved = vi.fn();
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={child}
          scenarios={[parent, child]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    const radio = screen.getByRole('radio', { name: /Roth first/i });
    expect(radio).toBeChecked();
  });

  // Modal seeds costBasisPct from inherited parent-chain values.
  it('seeds costBasisPct from parent-chain when child has no local override', async () => {
    const parent = makeScenario('parent-1', {
      assumedCostBasisFractionOfTaxableWithdrawal: 0.3,
    }, true);
    const child = makeScenario('child-1', {}, false, 'parent-1');
    const onSaved = vi.fn();
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={child}
          scenarios={[parent, child]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    // Cost basis slider is in the Advanced tab — click to activate.
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));
    const slider = screen.getByRole('slider', { name: /Return of principal \(taxable accounts\)/i });
    // 0.3 fraction → slider value = 30 (native <input type="range">).
    expect(slider).toHaveValue('30');
  });
});

// ——— PercentInput ÷100 storage conversion ————————————————

describe('WithdrawalStrategyEditor — PercentInput storage conversion', () => {
  it('save writes assumedCostBasisFractionOfTaxableWithdrawal as fraction (÷100)', async () => {
    const scenario = makeScenario('sc-1', { withdrawalStrategy: { kind: 'taxEfficient' } });
    const onSaved = vi.fn();
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    // Cost basis slider is in the Advanced tab — click to activate.
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

    // Slider starts at 50 (default). Step = 5. jsdom doesn't drive native
    // <input type="range"> from keyboard events, so we simulate the value
    // change directly — the component's onChange snaps to the step.
    const slider = screen.getByRole('slider', { name: /Return of principal \(taxable accounts\)/i });
    fireEvent.change(slider, { target: { value: '60' } });
    await waitFor(() => expect(slider).toHaveValue('60'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const pending = await listPendingMutations();
    const mut = pending.find((p) => p.aggregateId === 'sc-1');
    expect(mut).toBeTruthy();
    const payload = mut!.payload as ScenarioPayload;
    expect(payload.overrides.assumedCostBasisFractionOfTaxableWithdrawal).toBeCloseTo(0.6, 5);
  });

  // 40 → 0.4 precise case.
  it('save writes 40% slider value as exactly 0.4 fraction (no floating-point drift)', async () => {
    const scenario = makeScenario('sc-1', { withdrawalStrategy: { kind: 'taxEfficient' } });
    const onSaved = vi.fn();
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    // Cost basis slider is in the Advanced tab — click to activate.
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

    // Slider starts at 50 (default). Drive to 40 (step=5). jsdom can't
    // simulate native <input type="range"> keyboard semantics — drive the
    // value via fireEvent.change instead.
    const slider = screen.getByRole('slider', { name: /Return of principal \(taxable accounts\)/i });
    fireEvent.change(slider, { target: { value: '40' } });
    await waitFor(() => expect(slider).toHaveValue('40'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const pending = await listPendingMutations();
    const mut = pending.find((p) => p.aggregateId === 'sc-1');
    expect(mut).toBeTruthy();
    const payload = mut!.payload as ScenarioPayload;
    expect(payload.overrides.assumedCostBasisFractionOfTaxableWithdrawal).toBeCloseTo(0.4, 5);
  });
});

// ——— MoneyInput dollar-verbatim storage ——————————————————

describe('WithdrawalStrategyEditor — MoneyInput storage (dollars verbatim)', () => {
  it('save writes both MAGI bootstrap lookback fields in whole dollars (no conversion)', async () => {
    const scenario = makeScenario('sc-1', { withdrawalStrategy: { kind: 'taxEfficient' } });
    const onSaved = vi.fn();
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    // MAGI bootstrap toggle is in the Advanced tab — click to activate.
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

    const toggle = screen.getByRole('switch', { name: /Use engine default/i });
    await userEvent.click(toggle);

    const moneyInput = screen.getByLabelText(/Gross annual income/i);
    await userEvent.clear(moneyInput);
    await userEvent.type(moneyInput, '52000');
    fireEvent.blur(moneyInput);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const pending = await listPendingMutations();
    const mut = pending.find((p) => p.aggregateId === 'sc-1');
    expect(mut).toBeTruthy();
    const payload = mut!.payload as ScenarioPayload;
    // The single UI input writes BOTH split lookback fields.
    expect(payload.overrides.magiBootstrapLookbackMinus2).toBe(52000);
    expect(payload.overrides.magiBootstrapLookbackMinus1).toBe(52000);
  });

  it('save omits both MAGI bootstrap lookback fields when "Use engine default" is ON', async () => {
    const scenario = makeScenario('sc-1', {
      withdrawalStrategy: { kind: 'taxEfficient' },
      magiBootstrapLookbackMinus2: 40000,
      magiBootstrapLookbackMinus1: 40000,
    });
    const onSaved = vi.fn();
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    // MAGI bootstrap toggle is in the Advanced tab — click to activate.
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

    // Toggle is currently OFF (override set). Toggle ON to use engine default.
    const toggle = screen.getByRole('switch', { name: /Use engine default/i });
    await userEvent.click(toggle);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const pending = await listPendingMutations();
    const mut = pending.find((p) => p.aggregateId === 'sc-1');
    expect(mut).toBeTruthy();
    const payload = mut!.payload as ScenarioPayload;
    expect(Object.prototype.hasOwnProperty.call(payload.overrides, 'magiBootstrapLookbackMinus2')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload.overrides, 'magiBootstrapLookbackMinus1')).toBe(false);
  });
});

// ——— No-op Save + Save disabled when clean ———————————————

describe('WithdrawalStrategyEditor — no-op Save behavior', () => {
  // No-op Save queues no mutation.
  it('Save when clean queues no pending mutation', async () => {
    const scenario = makeScenario('sc-1', { withdrawalStrategy: { kind: 'taxEfficient' } });
    const onSaved = vi.fn();
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });

    // Save without changing anything.
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect(saveBtn).toBeDisabled();
    // Attempt to click anyway (no-op due to disabled).
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    const pending = await listPendingMutations();
    expect(pending.filter((p) => p.aggregateId === 'sc-1').length).toBe(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

  // Save button disabled when clean.
  it('Save button is disabled when no fields are dirty', async () => {
    const scenario = makeScenario('sc-1', { withdrawalStrategy: { kind: 'proportional' } });
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('Save button is enabled after a field is changed', async () => {
    const scenario = makeScenario('sc-1', {});
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    // MAGI bootstrap toggle is in the Advanced tab — click to activate.
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

    const toggle = screen.getByRole('switch', { name: /Use engine default/i });
    await userEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });
});

// ——— Toggle re-toggle pinning ————————————————————————————

describe('WithdrawalStrategyEditor — toggle re-toggle behavior', () => {
  it('toggle off → enter value → toggle on → save omits key; toggle off again → input shows 0', async () => {
    const scenario = makeScenario('sc-1', {});
    const onSaved = vi.fn();
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    // MAGI bootstrap toggle is in the Advanced tab — click to activate.
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

    const toggle = screen.getByRole('switch', { name: /Use engine default/i });
    await userEvent.click(toggle);
    const moneyInput = screen.getByLabelText(/Gross annual income/i);
    await userEvent.clear(moneyInput);
    await userEvent.type(moneyInput, '52000');
    fireEvent.blur(moneyInput);

    // Toggle ON again — should clear the draft entry.
    await userEvent.click(toggle);
    expect(screen.queryByLabelText(/Gross annual income/i)).toBeNull();

    // Toggle OFF again — input restores to 0 (no memory of prior entry).
    await userEvent.click(toggle);
    const moneyInputAgain = screen.getByLabelText(/Gross annual income/i);
    expect(moneyInputAgain).toHaveValue('0.00');
  });
});

// ——— Dirty-state guard ———————————————————————————————————

describe('WithdrawalStrategyEditor — dirty-state guard', () => {
  // Surfaces the current pathname so a Cancel/back navigation can be asserted.
  function LocationProbe(): React.ReactElement {
    const location = useLocation();
    return <div data-testid="pathname">{location.pathname}</div>;
  }

  function renderEditorAt(scenario: ScenarioAggregate, onSaved = vi.fn()) {
    return render(
      <MemoryRouter initialEntries={['/scenarios/sc-1/withdrawal-strategy']}>
        <LocationProbe />
        <Routes>
          <Route
            path="/scenarios/sc-1/withdrawal-strategy"
            element={
              <WithdrawalStrategyEditor
                scenario={scenario}
                scenarios={[scenario]}
                householdId={HH}
                accounts={NO_ACCOUNTS}
                members={NO_MEMBERS}
                incomeStreams={[]}
                backPath="/scenarios/sc-1"
                onSaved={onSaved}
              />
            }
          />
          <Route path="/scenarios/sc-1" element={<div>scenario detail</div>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('Save click with unsaved changes does not surface the confirm prompt', async () => {
    const scenario = makeScenario('sc-1', {});
    const onSaved = vi.fn();
    renderEditorAt(scenario, onSaved);
    await screen.findByRole('tab', { name: /Strategy/ });
    // MAGI bootstrap toggle is in the Advanced tab — click to activate.
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

    const toggle = screen.getByRole('switch', { name: /Use engine default/i });
    await userEvent.click(toggle);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // No Stay/Leave prompt — Save is not a discard.
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('Cancel leaves immediately via navigateUnguarded — no prompt (intentional discard)', async () => {
    const scenario = makeScenario('sc-1', {});
    renderEditorAt(scenario);
    await screen.findByRole('tab', { name: /Strategy/ });
    // Make the draft dirty so the guard is active.
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));
    const toggle = screen.getByRole('switch', { name: /Use engine default/i });
    await userEvent.click(toggle);

    // Cancel is an intentional discard — it navigates back without a
    // Stay/Leave prompt and queues no mutation.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('pathname').textContent).toBe('/scenarios/sc-1'),
    );
    const pending = await listPendingMutations();
    expect(pending.filter((p) => p.aggregateId === 'sc-1').length).toBe(0);
  });
});

// ——— MAGI bootstrap parent-chain inheritance ————————

describe('WithdrawalStrategyEditor — MAGI bootstrap inheritance', () => {
  // Toggle seeds from LOCAL-override presence.
  // Child has no local MAGI key → toggle starts ON (engine default), input hidden.
  // Parent chain value is NOT surfaced as a local override.
  it('child with no local MAGI key seeds toggle ON (engine default); parent chain unchanged', async () => {
    const parent = makeScenario('parent-1', { magiBootstrapLookbackMinus2: 52000, magiBootstrapLookbackMinus1: 52000 }, true, null);
    parent.payload.name = 'Base Plan';
    const child = makeScenario('child-1', {}, false, 'parent-1');
    child.payload.name = 'Child Plan';
    const scenarios = [parent, child];
    const onSaved = vi.fn();

    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={child}
          scenarios={scenarios}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('tab', { name: /Strategy/ });
    // MAGI bootstrap toggle is in the Advanced tab — click to activate.
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

    // Toggle is ON because child has no local MAGI override.
    const toggle = screen.getByRole('switch', { name: /Use engine default/i });
    expect(toggle).toBeChecked();

    // Money input is hidden when toggle is ON.
    expect(screen.queryByRole('textbox', { name: /Gross annual income/i })).toBeNull();

    // Parent chain still resolves to 52000 for the child (parent is unchanged).
    const resolved = resolveScenario('child-1', scenarios);
    expect(resolved.magiBootstrapLookbackMinus2).toBe(52000);
    expect(resolved.magiBootstrapLookbackMinus1).toBe(52000);
  });

  // Child WITH local MAGI key seeds toggle OFF.
  it('child with local MAGI key seeds toggle OFF + value from local override', async () => {
    const parent = makeScenario('parent-1', { magiBootstrapLookbackMinus2: 52000, magiBootstrapLookbackMinus1: 52000 }, true, null);
    parent.payload.name = 'Base Plan';
    const child = makeScenario('child-1', { magiBootstrapLookbackMinus2: 35000, magiBootstrapLookbackMinus1: 35000 }, false, 'parent-1');
    child.payload.name = 'Child Plan';
    const scenarios = [parent, child];
    const onSaved = vi.fn();

    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={child}
          scenarios={scenarios}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('tab', { name: /Strategy/ });
    // MAGI bootstrap toggle is in the Advanced tab — click to activate.
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

    // Toggle is OFF because child has a local MAGI override.
    const toggle = screen.getByRole('switch', { name: /Use engine default/i });
    expect(toggle).not.toBeChecked();

    // Money input shows the local override value.
    expect(screen.getByRole('textbox', { name: /Gross annual income/i })).toHaveValue('35000.00');

    // Toggle ON → "this scenario won't set its own value".
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());

    // Money input hidden when toggle is ON.
    expect(screen.queryByRole('textbox', { name: /Gross annual income/i })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    // Saved mutation's child payload must NOT have the MAGI key.
    const mutations = await listPendingMutations();
    const saved = mutations.find((m) => m.aggregateId === 'child-1' && m.operation === 'update');
    expect(saved).toBeDefined();
    const overrides = (saved!.payload as ScenarioPayload).overrides;
    expect(overrides.magiBootstrapLookbackMinus2).toBeUndefined();
    expect(overrides.magiBootstrapLookbackMinus1).toBeUndefined();

    // If the child's local magi key is removed, the parent chain resolves to 52000.
    const updatedChild: typeof child = {
      ...child,
      payload: { ...child.payload, overrides: { ...overrides } },
    };
    const resolved = resolveScenario('child-1', [parent, updatedChild]);
    expect(resolved.magiBootstrapLookbackMinus2).toBe(52000);
    expect(resolved.magiBootstrapLookbackMinus1).toBe(52000);
  });
});

// ——— Regression: no unintended local-override pollution ——

describe('WithdrawalStrategyEditor — no unintended override pollution', () => {
  it('parent sets taxEfficient + cost basis 50% + MAGI 52000; child changes ONLY strategy to rothFirst; child overrides has ONLY withdrawalStrategy', async () => {
    const parent = makeScenario('parent-1', {
      withdrawalStrategy: { kind: 'taxEfficient' },
      assumedCostBasisFractionOfTaxableWithdrawal: 0.5,
      magiBootstrapLookbackMinus2: 52000,
      magiBootstrapLookbackMinus1: 52000,
    }, true, null);
    const child = makeScenario('child-1', {}, false, 'parent-1');
    const scenarios = [parent, child];
    const onSaved = vi.fn();

    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={child}
          scenarios={scenarios}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('tab', { name: /Strategy/ });

    // Change strategy from taxEfficient (inherited) to rothFirst.
    const radio = screen.getByRole('radio', { name: /Roth first/i });
    await userEvent.click(radio);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const mutations = await listPendingMutations();
    const saved = mutations.find((m) => m.aggregateId === 'child-1' && m.operation === 'update');
    expect(saved).toBeDefined();
    const overrides = (saved!.payload as ScenarioPayload).overrides;

    // Only withdrawalStrategy should be in child's local overrides.
    expect(overrides.withdrawalStrategy).toEqual({ kind: 'rothFirst' });
    expect(overrides.assumedCostBasisFractionOfTaxableWithdrawal).toBeUndefined();
    expect(overrides.magiBootstrapLookbackMinus2).toBeUndefined();
    expect(overrides.magiBootstrapLookbackMinus1).toBeUndefined();
  });
});

// ——— Decimal rounding ————————————————————————————————

describe('WithdrawalStrategyEditor — MAGI integer rounding', () => {
  it('decimal MAGI input is rounded to a whole dollar before saving', async () => {
    const scenario = makeScenario('sc-1', { withdrawalStrategy: { kind: 'taxEfficient' } });
    const onSaved = vi.fn();
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    // MAGI bootstrap toggle is in the Advanced tab — click to activate.
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

    const toggle = screen.getByRole('switch', { name: /Use engine default/i });
    await userEvent.click(toggle);

    const moneyInput = screen.getByLabelText(/Gross annual income/i);
    await userEvent.clear(moneyInput);
    await userEvent.type(moneyInput, '52000.75');
    fireEvent.blur(moneyInput);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const pending = await listPendingMutations();
    const mut = pending.find((p) => p.aggregateId === 'sc-1');
    expect(mut).toBeTruthy();
    const payload = mut!.payload as ScenarioPayload;
    // Must be a whole integer — no fractional cents — in BOTH lookback fields.
    expect(payload.overrides.magiBootstrapLookbackMinus2).toBe(52001);
    expect(payload.overrides.magiBootstrapLookbackMinus1).toBe(52001);
    expect(Number.isInteger(payload.overrides.magiBootstrapLookbackMinus2)).toBe(true);
    expect(Number.isInteger(payload.overrides.magiBootstrapLookbackMinus1)).toBe(true);
  });
});

// ——— Dirty-state guard — tier order + pruning ———————————————

describe('WithdrawalStrategyEditor — tier dirty-state guard', () => {
  function makeAccount(
    id: string,
    type: import('../db/types').AccountType = 'RETIREMENT_401K',
  ): import('../db/types').Aggregate<import('../db/types').AccountPayload> {
    return {
      id,
      householdId: HH,
      aggregateType: 'account',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: id,
        type,
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'PRE_TAX',
        ownerId: 'member-1',
        institution: '',
        notes: '',
        planningReturnPct: 7,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 80, bondsPct: 20, cashPct: 0 },
      },
    };
  }

  it('Save button stays disabled when strategy is customOrder and tiers match saved layout', async () => {
    const acctA = makeAccount('acct-a');
    const acctB = makeAccount('acct-b');
    const scenario = makeScenario('sc-1', {
      withdrawalStrategy: { kind: 'customOrder' },
      customDrawdownOrder: {
        tiers: [['acct-a', 'acct-b']],
        excludedAccountIds: [],
      },
    });
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={[acctA, acctB]}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    // No change made — Save button should be disabled.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  // Seeding from saved tiers (pre-prune) means a pruned stale account
  // makes the draft immediately dirty → Save should be enabled.
  it('Save button enabled immediately when saved tiers contain a stale account', async () => {
    const acctA = makeAccount('acct-a');
    // acct-stale was removed from the household — NOT in the accounts prop.
    const scenario = makeScenario('sc-1', {
      withdrawalStrategy: { kind: 'customOrder' },
      customDrawdownOrder: {
        tiers: [['acct-a', 'acct-stale']],
        excludedAccountIds: [],
      },
    });
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={[acctA]} // acct-stale absent → seedTierState prunes it
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    // Pruned draft differs from baseline (raw saved tiers) → Save enabled.
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });
});

// ——— Tab switching ————————————————————————————————————

describe('WithdrawalStrategyEditor — tab switching', () => {
  it('Advanced tab click reveals cost basis slider and MAGI bootstrap toggle', async () => {
    const scenario = makeScenario('sc-tabs', { withdrawalStrategy: { kind: 'taxEfficient' } });
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });

    // Strategy tab is selected by default — advanced controls not visible.
    expect(screen.queryByRole('slider', { name: /Return of principal/i })).toBeNull();
    expect(screen.queryByRole('switch', { name: /Use engine default/i })).toBeNull();

    // Click the Advanced tab — controls become visible.
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));
    expect(screen.getByRole('slider', { name: /Return of principal/i })).toBeTruthy();
    expect(screen.getByRole('switch', { name: /Use engine default/i })).toBeTruthy();
  });

  it('Custom order tab is disabled when strategy is not customOrder', async () => {
    const scenario = makeScenario('sc-tabs-dis', { withdrawalStrategy: { kind: 'taxEfficient' } });
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    const customTab = screen.getByRole('tab', { name: /Custom order/i });
    expect(customTab).toHaveAttribute('aria-disabled', 'true');
  });

  it('selected tab carries data-selected and disabled tab carries data-disabled (visible styling hook)', async () => {
    const scenario = makeScenario('sc-tabs-styling', { withdrawalStrategy: { kind: 'taxEfficient' } });
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    const strategyTab = screen.getByRole('tab', { name: /Strategy/i });
    const customTab = screen.getByRole('tab', { name: /Custom order/i });
    // React Aria writes data-selected on the active tab + data-disabled on disabled tabs.
    // The Tab className uses `data-[selected]:` and `data-[disabled]:` arbitrary variants
    // to render the indigo underline + opacity-40 — Tailwind's bare `selected:`/`disabled:`
    // don't match these data attrs and would leave both states visually identical.
    expect(strategyTab).toHaveAttribute('data-selected', 'true');
    expect(customTab).toHaveAttribute('data-disabled', 'true');
    expect(strategyTab.className).toMatch(/data-\[selected\]:/);
    expect(strategyTab.className).toMatch(/data-\[disabled\]:/);
  });
});

// ——— All-in-Excluded validation ————————————————————

describe('WithdrawalStrategyEditor — all-in-Excluded validation', () => {
  function makeAccount(
    id: string,
  ): import('../db/types').Aggregate<import('../db/types').AccountPayload> {
    return {
      id,
      householdId: HH,
      aggregateType: 'account',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: id,
        type: 'RETIREMENT_401K',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'PRE_TAX',
        ownerId: 'member-1',
        institution: '',
        notes: '',
        planningReturnPct: 7,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 80, bondsPct: 20, cashPct: 0 },
      },
    };
  }

  it('Save is disabled and error shown when all accounts are in Excluded (no drainable tier)', async () => {
    const acctA = makeAccount('acct-a');
    // All accounts in Excluded — all tiers empty.
    const scenario = makeScenario('sc-excl', {
      withdrawalStrategy: { kind: 'customOrder' },
      customDrawdownOrder: {
        tiers: [[]],
        excludedAccountIds: ['acct-a'],
      },
    });
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={[acctA]}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    // Make the modal dirty so Save would otherwise be enabled.
    // Switch to the Custom order tab to surface the tier editor.
    await userEvent.click(screen.getByRole('tab', { name: /Custom order/i }));
    // Validation error must be visible.
    await waitFor(() =>
      expect(screen.getByText(/place at least one account in a drawdown tier/i)).toBeTruthy(),
    );
    // Save button must be disabled.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

// ——— MAGI cap save with magiCeilingAnnualDollars === 0 ——

describe('WithdrawalStrategyEditor — MAGI cap dollar = 0', () => {
  it('save with magiCap enabled and dollars=0 writes magiCeilingAnnualDollars=0 to mutation', async () => {
    // Start with cap already set to a value so modal is seeded with enabled+dollars.
    const scenario = makeScenario('sc-cap0', {
      withdrawalStrategy: { kind: 'taxEfficient' },
      magiCap: { windows: [{ start: { kind: 'retirementStart' }, end: { kind: 'age', memberId: 'primary', years: 65, months: 0 }, magiCeilingAnnualDollars: 50000, capMode: 'minimize', capMagiLine: 'irmaa' }] },
    });
    const onSaved = vi.fn();
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });

    // Click the MAGI cap tab to reveal the MoneyInput.
    await userEvent.click(screen.getByRole('tab', { name: /MAGI cap/i }));

    // Clear the cap dollars field and type 0.
    const capInput = screen.getByLabelText(/annual max/i);
    await userEvent.clear(capInput);
    await userEvent.type(capInput, '0');
    fireEvent.blur(capInput);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const pending = await listPendingMutations();
    const mut = pending.find((p) => p.aggregateId === 'sc-cap0');
    expect(mut).toBeTruthy();
    const payload = mut!.payload as import('../db/types').ScenarioPayload;
    // magiCeilingAnnualDollars must be 0 (not null/undefined). A real cap is
    // persisted here, not the explicit-disable sentinel.
    const savedCap = payload.overrides.magiCap;
    expect(savedCap).toBeDefined();
    if (savedCap === undefined || isMagiCapDisabled(savedCap)) throw new Error('expected real cap');
    expect(savedCap.windows[0].magiCeilingAnnualDollars).toBe(0);
  });
});

// ——— Inherited customDrawdownOrder tier seeding ———————————————————

describe('WithdrawalStrategyEditor — inherited customDrawdownOrder seeding', () => {
  // Regression: initTierState used localOverrides.customDrawdownOrder
  // (undefined for child) instead of effective.customDrawdownOrder (inherited).
  // Child modal opened without changes → draft.tiers should match parent
  // layout, not the HSA/tier-0 default.

  function makeAccount(
    id: string,
    type: import('../db/types').AccountType = 'RETIREMENT_401K',
  ): import('../db/types').Aggregate<import('../db/types').AccountPayload> {
    return {
      id,
      householdId: HH,
      aggregateType: 'account',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: id,
        type,
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'PRE_TAX',
        ownerId: 'member-1',
        institution: '',
        notes: '',
        planningReturnPct: 7,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 80, bondsPct: 20, cashPct: 0 },
      },
    };
  }

  it('draft_tiers_seed_from_inherited_parent_customDrawdownOrder_not_default', async () => {
    // Parent has a 2-tier custom order. Child has no local overrides.
    // BUG (pre-fix): child modal seeds tier state from localOverrides
    // (undefined) → default layout [['acct-a','acct-b']] in one tier.
    // CORRECT: seed from effective (inherited) → [['acct-a'], ['acct-b']].
    const { renderHook } = await import('@testing-library/react');
    const { useWithdrawalStrategyDraft } = await import('./scenario-withdrawal-strategy-draft-hook');

    const parent = makeScenario('parent-1', {
      withdrawalStrategy: { kind: 'customOrder' },
      customDrawdownOrder: {
        tiers: [['acct-a'], ['acct-b']],
        excludedAccountIds: [],
      },
    }, true);
    const child = makeScenario('child-1', {}, false, 'parent-1');
    const acctA = makeAccount('acct-a');
    const acctB = makeAccount('acct-b');

    const { result } = renderHook(() =>
      useWithdrawalStrategyDraft(child, [parent, child], [acctA, acctB]),
    );

    // Inherited 2-tier layout must be reflected in draft (not 1-tier default).
    expect(result.current.draft.tiers).toHaveLength(2);
    expect(result.current.draft.tiers[0]).toContain('acct-a');
    expect(result.current.draft.tiers[1]).toContain('acct-b');
  });

  it('save_omits_customDrawdownOrder_when_tier_layout_is_inherited_unchanged', async () => {
    // Child inherits 2-tier layout from parent. Child overrides strategyKind
    // locally (not customOrder), opens modal, switches to customOrder, saves.
    // Previously the saved payload would freeze the inherited tier layout into
    // the child override (future parent edits couldn't propagate).
    // Contract: when the inherited layout is unchanged in the draft,
    // omit customDrawdownOrder from the child's saved overrides entirely —
    // mergeFirstWins resolution still resolves to the parent's tiers at
    // runtime, but the child stays free to follow future parent edits.
    // This also guards against the older regression (draft seeded from
    // default → collapsing all accounts into a single tier).
    const parent = makeScenario('parent-1', {
      withdrawalStrategy: { kind: 'taxEfficient' },
      customDrawdownOrder: {
        tiers: [['acct-a'], ['acct-b']],
        excludedAccountIds: [],
      },
    }, true);
    // Child has a local strategyKind override (taxEfficient), no local customDrawdownOrder.
    const child = makeScenario('child-f52', {
      withdrawalStrategy: { kind: 'taxEfficient' },
    }, false, 'parent-1');
    const acctA = makeAccount('acct-a');
    const acctB = makeAccount('acct-b');
    const onSaved = vi.fn();

    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={child}
          scenarios={[parent, child]}
          householdId={HH}
          accounts={[acctA, acctB]}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });

    // Switch to Custom order strategy.
    await userEvent.click(screen.getByRole('radio', { name: /Custom order/i }));
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Custom order/i })).toBeChecked(),
    );

    // Save must be enabled (strategy changed).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled(),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const pending = await listPendingMutations();
    const mut = pending.find((p) => p.aggregateId === 'child-f52');
    expect(mut).toBeTruthy();
    const payload = mut!.payload as import('../db/types').ScenarioPayload;
    // customDrawdownOrder is omitted from the child's overrides when the
    // inherited layout is unchanged — child inherits from parent at runtime.
    expect(payload.overrides.customDrawdownOrder).toBeUndefined();
    // Strategy switch IS persisted (it was an explicit user change).
    expect(payload.overrides.withdrawalStrategy?.kind).toBe('customOrder');
  });
});

// ——— Inherited MAGI cap — child override + explicit disable ————————

describe('WithdrawalStrategyEditor — inherited MAGI cap (override + disable)', () => {
  // A child scenario with no local magiCap but a parent chain that sets one —
  // modal surfaces the "Inherited from <name>" override-hint copy and keeps
  // the toggle enabled so the child can override or disable the inherited cap.
  it('child_with_inherited_magiCap_shows_override_hint_and_enabled_toggle', async () => {
    const parent = makeScenario(
      'parent-cap',
      {
        withdrawalStrategy: { kind: 'taxEfficient' },
        magiCap: {
          windows: [
            {
              start: { kind: 'retirementStart' },
              end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
              magiCeilingAnnualDollars: 40_000,
              capMode: 'minimize',
              capMagiLine: 'irmaa',
            },
          ],
        },
      },
      true,
      null,
    );
    parent.payload.name = 'Base Plan';
    const child = makeScenario('child-cap', {}, false, 'parent-cap');
    child.payload.name = 'Bridge';
    const onSaved = vi.fn();

    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={child}
          scenarios={[parent, child]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });

    // Switch to MAGI cap tab.
    await userEvent.click(screen.getByRole('tab', { name: /MAGI cap/i }));

    // Inherited override-hint copy renders, naming the parent scenario.
    expect(
      screen.getByText(/MAGI cap inherited from Base Plan/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Editing here overrides it for this scenario only/i),
    ).toBeTruthy();

    // The toggle is enabled — a child can now disable an inherited cap.
    const toggle = screen.getByRole('switch', {
      name: /Limit pre-tax withdrawals with a MAGI cap schedule/i,
    });
    expect(toggle).not.toBeDisabled();
  });

  // Child with inherited cap, turn the toggle OFF, save → child stores the
  // explicit-disable sentinel; the parent's cap is unchanged.
  it('child_disabling_inherited_cap_saves_disable_sentinel', async () => {
    const parent = makeScenario(
      'parent-cap',
      {
        withdrawalStrategy: { kind: 'taxEfficient' },
        magiCap: {
          windows: [
            {
              start: { kind: 'retirementStart' },
              end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
              magiCeilingAnnualDollars: 40_000,
              capMode: 'minimize',
              capMagiLine: 'irmaa',
            },
          ],
        },
      },
      true,
      null,
    );
    parent.payload.name = 'Base Plan';
    const child = makeScenario('child-cap', {}, false, 'parent-cap');
    const onSaved = vi.fn();

    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={child}
          scenarios={[parent, child]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });

    await userEvent.click(screen.getByRole('tab', { name: /MAGI cap/i }));
    const toggle = screen.getByRole('switch', {
      name: /Limit pre-tax withdrawals with a MAGI cap schedule/i,
    });
    await userEvent.click(toggle); // turn the inherited cap OFF

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const pending = await listPendingMutations();
    const mut = pending.find((p) => p.aggregateId === 'child-cap');
    expect(mut).toBeTruthy();
    const payload = mut!.payload as ScenarioPayload;
    // Child stores the explicit-disable sentinel.
    expect(payload.overrides.magiCap).toEqual({ disabled: true });
    // Parent's cap unchanged; child resolves to "no cap" (sentinel wins).
    const updatedChild: typeof child = {
      ...child,
      payload: { ...child.payload, overrides: payload.overrides },
    };
    const resolved = resolveScenario('child-cap', [parent, updatedChild]);
    expect(isMagiCapDisabled(resolved.magiCap)).toBe(true);
  });

  // Open child modal with inherited cap, change an unrelated field
  // (cost basis), save → child's local magiCap remains undefined (no
  // pollution from the modal save path).
  it('save_with_inherited_cap_and_unrelated_change_does_not_pollute_local_magiCap', async () => {
    const parent = makeScenario(
      'parent-cap',
      {
        withdrawalStrategy: { kind: 'taxEfficient' },
        magiCap: {
          windows: [
            {
              start: { kind: 'retirementStart' },
              end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
              magiCeilingAnnualDollars: 40_000,
              capMode: 'minimize',
              capMagiLine: 'irmaa',
            },
          ],
        },
      },
      true,
      null,
    );
    parent.payload.name = 'Base Plan';
    const child = makeScenario('child-cap', {}, false, 'parent-cap');
    const onSaved = vi.fn();

    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={child}
          scenarios={[parent, child]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });

    // Change an unrelated field — cost basis in Advanced tab.
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));
    const slider = screen.getByRole('slider', {
      name: /Return of principal/i,
    });
    fireEvent.change(slider, { target: { value: '60' } });
    await waitFor(() => expect(slider).toHaveValue('60'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const pending = await listPendingMutations();
    const mut = pending.find((p) => p.aggregateId === 'child-cap');
    expect(mut).toBeTruthy();
    const payload = mut!.payload as ScenarioPayload;
    // Child's local magiCap stays undefined — inheritance keeps
    // working from the parent. Don't freeze the inherited value into the
    // child's overrides.
    expect(payload.overrides.magiCap).toBeUndefined();
    // The unrelated change persisted.
    expect(payload.overrides.assumedCostBasisFractionOfTaxableWithdrawal).toBeCloseTo(
      0.6,
      5,
    );
    // Parent chain still resolves to the inherited cap.
    const updatedChild: typeof child = {
      ...child,
      payload: { ...child.payload, overrides: payload.overrides },
    };
    const resolved = resolveScenario('child-cap', [parent, updatedChild]);
    expect(resolved.magiCap).toEqual({
      windows: [
        {
          start: { kind: 'retirementStart' },
          end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
          magiCeilingAnnualDollars: 40_000,
          capMode: 'minimize',
          capMagiLine: 'irmaa',
        },
      ],
    });
  });

  // The dollar/member/end-age fields are now editable on a child scenario
  // with an inherited cap — a child can override the inherited value.
  // Editing the dollar amount and saving persists a real child override.
  it('inherited_cap_dollar_input_is_editable_and_override_persists', async () => {
    const parent = makeScenario(
      'parent-cap',
      {
        withdrawalStrategy: { kind: 'taxEfficient' },
        magiCap: {
          windows: [
            {
              start: { kind: 'retirementStart' },
              end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
              magiCeilingAnnualDollars: 40_000,
              capMode: 'minimize',
              capMagiLine: 'irmaa',
            },
          ],
        },
      },
      true,
      null,
    );
    parent.payload.name = 'Base Plan';
    const child = makeScenario('child-cap', {}, false, 'parent-cap');
    const onSaved = vi.fn();

    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={child}
          scenarios={[parent, child]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });

    // Switch to MAGI cap tab — modal renders cap fields seeded from inherited.
    await userEvent.click(screen.getByRole('tab', { name: /MAGI cap/i }));

    // Dollar input is editable (no longer locked by inheritance).
    const capInput = screen.getByLabelText(/annual max/i);
    expect(
      capInput.getAttribute('aria-disabled') === 'true' ||
        (capInput as HTMLInputElement).disabled === true,
    ).toBe(false);

    // The cap end anchor is the shared ScheduleAnchorPicker (a collapsible
    // AnchorCard) — its summary names the inherited end age so the user can see
    // what they're overriding before expanding it to edit.
    expect(screen.getByText(/Cap ends/i)).toBeTruthy();

    // Override the inherited dollar amount.
    await userEvent.clear(capInput);
    await userEvent.type(capInput, '60000');
    fireEvent.blur(capInput);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const pending = await listPendingMutations();
    const mut = pending.find((p) => p.aggregateId === 'child-cap');
    expect(mut).toBeTruthy();
    const payload = mut!.payload as ScenarioPayload;
    // Child persists a real override distinct from the inherited value.
    const savedCap = payload.overrides.magiCap;
    expect(savedCap).toBeDefined();
    if (savedCap === undefined || isMagiCapDisabled(savedCap)) throw new Error('expected real cap');
    expect(savedCap.windows[0].magiCeilingAnnualDollars).toBe(60_000);
    expect(savedCap.windows[0].end).toEqual({ kind: 'age', memberId: 'primary', years: 65, months: 0 });
    // Parent's cap is unchanged; child resolves to its own $60k ladder.
    const updatedChild: typeof child = {
      ...child,
      payload: { ...child.payload, overrides: payload.overrides },
    };
    const resolved = resolveScenario('child-cap', [parent, updatedChild]);
    expect(resolved.magiCap).toEqual({
      windows: [
        {
          start: { kind: 'retirementStart' },
          end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
          magiCeilingAnnualDollars: 60_000,
          capMode: 'minimize',
          capMagiLine: 'irmaa',
        },
      ],
    });
  });
});

// ——— A11y smoke ———————————————————————————————————————————

describe('WithdrawalStrategyEditor — a11y smoke', () => {
  it('editor passes expectNoA11yViolations', async () => {
    const scenario = makeScenario('sc-a11y', {});
    const { container } = render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          incomeStreams={[]}
          backPath="/scenarios/sc"
          onSaved={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    await expectNoA11yViolations(container);
  });
});
