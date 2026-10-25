// WithdrawalStrategyEditor: strategy picker seeding, PercentInput ÷100 storage, MoneyInput dollar-verbatim storage, MAGI key omission, no-op Save, toggle pinning, the dirty-state guard, and inherited tier and cap handling.
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

// Empty account and member arrays satisfy the props shape for baseline tests; tests exercising the tier editor or MAGI cap supply populated arrays.
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
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));
    const slider = screen.getByRole('slider', { name: /Return of principal \(taxable accounts\)/i });
    expect(slider).toHaveValue('30');
  });
});

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
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

    // jsdom doesn't drive native range inputs from keyboard events, so simulate the value change directly; onChange snaps to the step (5).
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
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

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
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

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

describe('WithdrawalStrategyEditor — no-op Save behavior', () => {
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

    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect(saveBtn).toBeDisabled();
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    const pending = await listPendingMutations();
    expect(pending.filter((p) => p.aggregateId === 'sc-1').length).toBe(0);
    expect(onSaved).not.toHaveBeenCalled();
  });

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
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

    const toggle = screen.getByRole('switch', { name: /Use engine default/i });
    await userEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });
});

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
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

    const toggle = screen.getByRole('switch', { name: /Use engine default/i });
    await userEvent.click(toggle);
    const moneyInput = screen.getByLabelText(/Gross annual income/i);
    await userEvent.clear(moneyInput);
    await userEvent.type(moneyInput, '52000');
    fireEvent.blur(moneyInput);

    await userEvent.click(toggle);
    expect(screen.queryByLabelText(/Gross annual income/i)).toBeNull();

    await userEvent.click(toggle);
    const moneyInputAgain = screen.getByLabelText(/Gross annual income/i);
    expect(moneyInputAgain).toHaveValue('0.00');
  });
});

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
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

    const toggle = screen.getByRole('switch', { name: /Use engine default/i });
    await userEvent.click(toggle);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('Cancel leaves immediately via navigateUnguarded — no prompt (intentional discard)', async () => {
    const scenario = makeScenario('sc-1', {});
    renderEditorAt(scenario);
    await screen.findByRole('tab', { name: /Strategy/ });
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));
    const toggle = screen.getByRole('switch', { name: /Use engine default/i });
    await userEvent.click(toggle);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('pathname').textContent).toBe('/scenarios/sc-1'),
    );
    const pending = await listPendingMutations();
    expect(pending.filter((p) => p.aggregateId === 'sc-1').length).toBe(0);
  });
});

describe('WithdrawalStrategyEditor — MAGI bootstrap inheritance', () => {
  // The toggle seeds from local-override presence: a child with no local MAGI key starts ON (engine default), and the parent chain value is not surfaced as a local override.
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
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

    const toggle = screen.getByRole('switch', { name: /Use engine default/i });
    expect(toggle).toBeChecked();

    expect(screen.queryByRole('textbox', { name: /Gross annual income/i })).toBeNull();

    const resolved = resolveScenario('child-1', scenarios);
    expect(resolved.magiBootstrapLookbackMinus2).toBe(52000);
    expect(resolved.magiBootstrapLookbackMinus1).toBe(52000);
  });

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
    await userEvent.click(screen.getByRole('tab', { name: /Advanced/i }));

    const toggle = screen.getByRole('switch', { name: /Use engine default/i });
    expect(toggle).not.toBeChecked();

    expect(screen.getByRole('textbox', { name: /Gross annual income/i })).toHaveValue('35000.00');

    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());

    expect(screen.queryByRole('textbox', { name: /Gross annual income/i })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const mutations = await listPendingMutations();
    const saved = mutations.find((m) => m.aggregateId === 'child-1' && m.operation === 'update');
    expect(saved).toBeDefined();
    const overrides = (saved!.payload as ScenarioPayload).overrides;
    expect(overrides.magiBootstrapLookbackMinus2).toBeUndefined();
    expect(overrides.magiBootstrapLookbackMinus1).toBeUndefined();

    const updatedChild: typeof child = {
      ...child,
      payload: { ...child.payload, overrides: { ...overrides } },
    };
    const resolved = resolveScenario('child-1', [parent, updatedChild]);
    expect(resolved.magiBootstrapLookbackMinus2).toBe(52000);
    expect(resolved.magiBootstrapLookbackMinus1).toBe(52000);
  });
});

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

    expect(overrides.withdrawalStrategy).toEqual({ kind: 'rothFirst' });
    expect(overrides.assumedCostBasisFractionOfTaxableWithdrawal).toBeUndefined();
    expect(overrides.magiBootstrapLookbackMinus2).toBeUndefined();
    expect(overrides.magiBootstrapLookbackMinus1).toBeUndefined();
  });
});

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
    expect(payload.overrides.magiBootstrapLookbackMinus2).toBe(52001);
    expect(payload.overrides.magiBootstrapLookbackMinus1).toBe(52001);
    expect(Number.isInteger(payload.overrides.magiBootstrapLookbackMinus2)).toBe(true);
    expect(Number.isInteger(payload.overrides.magiBootstrapLookbackMinus1)).toBe(true);
  });
});

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
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('Save button enabled immediately when saved tiers contain a stale account', async () => {
    const acctA = makeAccount('acct-a');
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
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });
});

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

    expect(screen.queryByRole('slider', { name: /Return of principal/i })).toBeNull();
    expect(screen.queryByRole('switch', { name: /Use engine default/i })).toBeNull();

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
    // React Aria writes data-selected / data-disabled on tabs; the className uses `data-[selected]:` / `data-[disabled]:` variants, since bare `selected:` / `disabled:` don't match those attributes.
    expect(strategyTab).toHaveAttribute('data-selected', 'true');
    expect(customTab).toHaveAttribute('data-disabled', 'true');
    expect(strategyTab.className).toMatch(/data-\[selected\]:/);
    expect(strategyTab.className).toMatch(/data-\[disabled\]:/);
  });
});

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
    await userEvent.click(screen.getByRole('tab', { name: /Custom order/i }));
    await waitFor(() =>
      expect(screen.getByText(/place at least one account in a drawdown tier/i)).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('WithdrawalStrategyEditor — MAGI cap dollar = 0', () => {
  it('save with magiCap enabled and dollars=0 writes magiCeilingAnnualDollars=0 to mutation', async () => {
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

    await userEvent.click(screen.getByRole('tab', { name: /MAGI cap/i }));

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
    // magiCeilingAnnualDollars must be 0 (not null/undefined): a real cap, not the explicit-disable sentinel.
    const savedCap = payload.overrides.magiCap;
    expect(savedCap).toBeDefined();
    if (savedCap === undefined || isMagiCapDisabled(savedCap)) throw new Error('expected real cap');
    expect(savedCap.windows[0].magiCeilingAnnualDollars).toBe(0);
  });
});

describe('WithdrawalStrategyEditor — inherited customDrawdownOrder seeding', () => {
  // Regression: initTierState used localOverrides.customDrawdownOrder (undefined for a child) instead of the inherited effective value, so the child modal seeded the HSA/tier-0 default instead of the parent's layout.

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

    expect(result.current.draft.tiers).toHaveLength(2);
    expect(result.current.draft.tiers[0]).toContain('acct-a');
    expect(result.current.draft.tiers[1]).toContain('acct-b');
  });

  it('save_omits_customDrawdownOrder_when_tier_layout_is_inherited_unchanged', async () => {
    // When the inherited layout is unchanged in the draft, omit customDrawdownOrder from the child's saved overrides so future parent edits still propagate; the save once froze the inherited layout into the child.
    const parent = makeScenario('parent-1', {
      withdrawalStrategy: { kind: 'taxEfficient' },
      customDrawdownOrder: {
        tiers: [['acct-a'], ['acct-b']],
        excludedAccountIds: [],
      },
    }, true);
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

    await userEvent.click(screen.getByRole('radio', { name: /Custom order/i }));
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Custom order/i })).toBeChecked(),
    );

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
    expect(payload.overrides.customDrawdownOrder).toBeUndefined();
    expect(payload.overrides.withdrawalStrategy?.kind).toBe('customOrder');
  });
});

describe('WithdrawalStrategyEditor — inherited MAGI cap (override + disable)', () => {
  // A child with no local magiCap under a parent that sets one shows the "Inherited from <name>" hint and keeps the toggle enabled so it can override or disable the inherited cap.
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

    await userEvent.click(screen.getByRole('tab', { name: /MAGI cap/i }));

    expect(
      screen.getByText(/MAGI cap inherited from Base Plan/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Editing here overrides it for this scenario only/i),
    ).toBeTruthy();

    const toggle = screen.getByRole('switch', {
      name: /Limit pre-tax withdrawals with a MAGI cap schedule/i,
    });
    expect(toggle).not.toBeDisabled();
  });

  // Turning the toggle off on a child with an inherited cap stores the explicit-disable sentinel; the parent's cap is unchanged.
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
    expect(payload.overrides.magiCap).toEqual({ disabled: true });
    const updatedChild: typeof child = {
      ...child,
      payload: { ...child.payload, overrides: payload.overrides },
    };
    const resolved = resolveScenario('child-cap', [parent, updatedChild]);
    expect(isMagiCapDisabled(resolved.magiCap)).toBe(true);
  });

  // An unrelated change must not pollute the child's local magiCap, which stays undefined so inheritance keeps working.
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
    expect(payload.overrides.magiCap).toBeUndefined();
    expect(payload.overrides.assumedCostBasisFractionOfTaxableWithdrawal).toBeCloseTo(
      0.6,
      5,
    );
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

  // The dollar, member and end-age fields are editable on a child with an inherited cap; editing persists a real child override.
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

    await userEvent.click(screen.getByRole('tab', { name: /MAGI cap/i }));

    const capInput = screen.getByLabelText(/annual max/i);
    expect(
      capInput.getAttribute('aria-disabled') === 'true' ||
        (capInput as HTMLInputElement).disabled === true,
    ).toBe(false);

    // The cap end anchor is the shared ScheduleAnchorPicker (a collapsible AnchorCard) whose summary names the inherited end age.
    expect(screen.getByText(/Cap ends/i)).toBeTruthy();

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
    const savedCap = payload.overrides.magiCap;
    expect(savedCap).toBeDefined();
    if (savedCap === undefined || isMagiCapDisabled(savedCap)) throw new Error('expected real cap');
    expect(savedCap.windows[0].magiCeilingAnnualDollars).toBe(60_000);
    expect(savedCap.windows[0].end).toEqual({ kind: 'age', memberId: 'primary', years: 65, months: 0 });
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
