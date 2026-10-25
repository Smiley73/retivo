// WithdrawalStrategyCard: summary strings per strategy kind, cost-basis and MAGI values, parent-chain inheritance display, Configure, and Reset visibility.
import 'fake-indexeddb/auto';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WithdrawalStrategyCard,
  TaxAssumptionsCard,
} from './ScenarioWithdrawalStrategyCards';
import { clearAllStores } from '../db/store';
import { expectNoA11yViolations } from '../test/a11y';
import type { ScenarioPayload } from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

const HH = 'hh-test';

function makeScenario(
  id: string,
  overrides: ScenarioPayload['overrides'] = {},
  isPrimary = false,
  parentScenarioId: string | null = isPrimary ? null : 'parent',
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

describe('WithdrawalStrategyCard — summary strings', () => {
  it('shows "Tax-efficient (default)" when no strategy override', () => {
    const scenario = makeScenario('sc-1', {}, true, null);
    render(
      <MemoryRouter>
        <WithdrawalStrategyCard
          scenario={scenario}
          scenarios={[scenario]}
          onConfigure={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Tax-efficient (default)')).toBeTruthy();
  });

  it.each([
    ['taxEfficient', 'Tax-efficient'],
    ['proportional', 'Proportional'],
    ['rothFirst', 'Roth first'],
    ['customOrder', 'Custom order'],
  ] as const)(
    'shows "%s" label when strategy is %s',
    (kind, label) => {
      const scenario = makeScenario('sc-1', { withdrawalStrategy: { kind } }, true, null);
      render(
        <MemoryRouter>
          <WithdrawalStrategyCard
            scenario={scenario}
            scenarios={[scenario]}
            onConfigure={vi.fn()}
          />
        </MemoryRouter>,
      );
      expect(screen.getByText(new RegExp(label))).toBeTruthy();
    },
  );

  it('shows cost-basis and MAGI-bootstrap values in summary when set', async () => {
    const scenario = makeScenario('sc-1', {
      withdrawalStrategy: { kind: 'taxEfficient' },
      assumedCostBasisFractionOfTaxableWithdrawal: 0.6,
      magiBootstrapLookbackMinus2: 52000,
      magiBootstrapLookbackMinus1: 52000,
    }, true, null);
    const { container } = render(
      <MemoryRouter>
        <WithdrawalStrategyCard
          scenario={scenario}
          scenarios={[scenario]}
          onConfigure={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Return of principal: 60\.0%/)).toBeTruthy();
    expect(screen.getByText(/Pre-retirement income: \$52,000/)).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it('shows "(inherited from <parentName>)" suffix when values come from parent chain', () => {
    const parent = makeScenario('parent-1', {
      withdrawalStrategy: { kind: 'taxEfficient' },
    }, true, null);
    parent.payload.name = 'Base Plan';
    const child = makeScenario('child-1', {}, false, 'parent-1');
    child.payload.name = 'Child Plan';
    render(
      <MemoryRouter>
        <WithdrawalStrategyCard
          scenario={child}
          scenarios={[parent, child]}
          onConfigure={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/inherited from Base Plan/)).toBeTruthy();
  });

  it('does NOT show "(inherited from …)" when values are locally overridden', () => {
    const parent = makeScenario('parent-1', {
      withdrawalStrategy: { kind: 'taxEfficient' },
    }, true, null);
    parent.payload.name = 'Base Plan';
    const child = makeScenario('child-1', {
      withdrawalStrategy: { kind: 'rothFirst' },
    }, false, 'parent-1');
    render(
      <MemoryRouter>
        <WithdrawalStrategyCard
          scenario={child}
          scenarios={[parent, child]}
          onConfigure={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/inherited from/)).toBeNull();
  });
});

describe('WithdrawalStrategyCard — Configure button', () => {
  it('Configure button fires onConfigure callback', () => {
    const scenario = makeScenario('sc-1', {}, true, null);
    const onConfigure = vi.fn();
    render(
      <MemoryRouter>
        <WithdrawalStrategyCard
          scenario={scenario}
          scenarios={[scenario]}
          onConfigure={onConfigure}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /configure/i }));
    expect(onConfigure).toHaveBeenCalledOnce();
  });
});

describe('WithdrawalStrategyCard — Reset', () => {
  it('shows no Reset button on a primary scenario', () => {
    const scenario = makeScenario('sc-1', {
      withdrawalStrategy: { kind: 'taxEfficient' },
    }, true, null);
    render(
      <MemoryRouter>
        <WithdrawalStrategyCard
          scenario={scenario}
          scenarios={[scenario]}
          onConfigure={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: /reset/i })).toBeNull();
  });

  it('Reset on non-primary fires onResetToInherited callback', () => {
    const scenario = makeScenario('sc-1', {
      withdrawalStrategy: { kind: 'taxEfficient' },
      assumedCostBasisFractionOfTaxableWithdrawal: 0.6,
      magiBootstrapLookbackMinus2: 52000,
      magiBootstrapLookbackMinus1: 52000,
    }, false, 'parent');
    const onReset = vi.fn();
    render(
      <MemoryRouter>
        <WithdrawalStrategyCard
          scenario={scenario}
          scenarios={[scenario]}
          onConfigure={vi.fn()}
          onResetToInherited={onReset}
        />
      </MemoryRouter>,
    );
    const resetBtn = screen.getByRole('button', { name: /reset/i });
    expect(resetBtn).toBeTruthy();
    fireEvent.click(resetBtn);
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('shows no Reset button on a non-primary scenario with no local overrides', () => {
    // canResetToInherited = isOverriddenLocally && !isPrimary; empty overrides give no Reset regardless of isPrimary.
    const scenario = makeScenario('sc-2', {}, false, 'parent');
    render(
      <MemoryRouter>
        <WithdrawalStrategyCard
          scenario={scenario}
          scenarios={[scenario]}
          onConfigure={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: /reset/i })).toBeNull();
  });
});

describe('WithdrawalStrategyCard — mutation shape', () => {
  // onResetToInherited (wired in ScenarioDetailPage) saves one payload with all withdrawal-strategy overrides deleted; replicate ScenarioDetailPage.handleResetWithdrawal exactly to test the mutation shape (the MAGI bootstrap is two split lookback fields, so six chained resets).
  it('should_reset_all_five_withdrawal_strategy_fields_in_one_mutation', async () => {
    const { saveScenario } = await import('../lib/scenario-mutations');
    const { resetField } = await import('../lib/scenario-resolution');
    const { listPendingMutations } = await import('../db/store');

    const scenario = makeScenario('sc-reset', {
      withdrawalStrategy: { kind: 'taxEfficient' },
      assumedCostBasisFractionOfTaxableWithdrawal: 0.6,
      magiBootstrapLookbackMinus2: 52000,
      magiBootstrapLookbackMinus1: 52000,
      customDrawdownOrder: { tiers: [['a1']], excludedAccountIds: [] },
      magiCap: { windows: [{ start: { kind: 'retirementStart' }, end: { kind: 'age', memberId: 'primary', years: 65, months: 0 }, magiCeilingAnnualDollars: 10000, capMode: 'minimize', capMagiLine: 'irmaa' }] },
    }, false, 'parent');

    let payload = resetField(scenario.payload, 'withdrawalStrategy');
    payload = resetField(payload, 'assumedCostBasisFractionOfTaxableWithdrawal');
    payload = resetField(payload, 'magiBootstrapLookbackMinus2');
    payload = resetField(payload, 'magiBootstrapLookbackMinus1');
    payload = resetField(payload, 'customDrawdownOrder');
    payload = resetField(payload, 'magiCap');
    await saveScenario({ scenario, payload, householdId: HH });

    const pending = await listPendingMutations();
    const resetMuts = pending.filter((m) => m.aggregateId === 'sc-reset');
    expect(resetMuts).toHaveLength(1);

    const saved = resetMuts[0].payload as import('../db/types').ScenarioPayload;
    expect(saved.overrides.withdrawalStrategy).toBeUndefined();
    expect(saved.overrides.assumedCostBasisFractionOfTaxableWithdrawal).toBeUndefined();
    expect(saved.overrides.magiBootstrapLookbackMinus2).toBeUndefined();
    expect(saved.overrides.magiBootstrapLookbackMinus1).toBeUndefined();
    expect(saved.overrides.customDrawdownOrder).toBeUndefined();
    expect(saved.overrides.magiCap).toBeUndefined();
  });
});

describe('TaxAssumptionsCard', () => {
  it('shows the emergency-HSA qualified percent (emergency withdrawals only) and penalty-exempt account count', async () => {
    const scenario = makeScenario(
      'sc-1',
      {
        hsaQualifiedMedicalExpensePct: 80,
        earlyWithdrawalPenaltyExemptAccountIds: ['a1', 'a2'],
      },
      true,
      null,
    );
    render(
      <MemoryRouter>
        <TaxAssumptionsCard
          scenario={scenario}
          scenarios={[scenario]}
          onConfigure={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Emergency HSA withdrawals treated as qualified: 80\.0%/)).toBeTruthy();
    expect(screen.getByText(/2 accounts penalty-exempt/)).toBeTruthy();
  });

  it('shows "No scenario overrides." when nothing is set locally', () => {
    // No local override gives the neutral message, not the resolved or inherited value, like the other override-summary cards.
    const scenario = makeScenario('sc-2', {}, true, null);
    render(
      <MemoryRouter>
        <TaxAssumptionsCard
          scenario={scenario}
          scenarios={[scenario]}
          onConfigure={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No scenario overrides\./)).toBeTruthy();
    expect(screen.queryByText(/Emergency HSA withdrawals treated as qualified/)).toBeNull();
  });

  it('Configure fires onConfigure', () => {
    const scenario = makeScenario('sc-3', {}, true, null);
    const onConfigure = vi.fn();
    render(
      <MemoryRouter>
        <TaxAssumptionsCard
          scenario={scenario}
          scenarios={[scenario]}
          onConfigure={onConfigure}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /configure/i }));
    expect(onConfigure).toHaveBeenCalledOnce();
  });

  it('shows no Reset button on a primary scenario', () => {
    const scenario = makeScenario(
      'sc-pri',
      { hsaQualifiedMedicalExpensePct: 80 },
      true,
      null,
    );
    render(
      <MemoryRouter>
        <TaxAssumptionsCard
          scenario={scenario}
          scenarios={[scenario]}
          onConfigure={vi.fn()}
          onResetToInherited={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: /reset/i })).toBeNull();
  });

  it('shows no Reset button on a non-primary scenario with no local overrides', () => {
    const scenario = makeScenario('sc-clean', {}, false, null);
    render(
      <MemoryRouter>
        <TaxAssumptionsCard
          scenario={scenario}
          scenarios={[scenario]}
          onConfigure={vi.fn()}
          onResetToInherited={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: /reset/i })).toBeNull();
  });

  it('Reset on a non-primary scenario with a local override fires onResetToInherited', () => {
    const scenario = makeScenario(
      'sc-reset',
      { earlyWithdrawalPenaltyExemptAccountIds: ['a1'] },
      false,
      null,
    );
    const onReset = vi.fn();
    render(
      <MemoryRouter>
        <TaxAssumptionsCard
          scenario={scenario}
          scenarios={[scenario]}
          onConfigure={vi.fn()}
          onResetToInherited={onReset}
        />
      </MemoryRouter>,
    );
    const resetBtn = screen.getByRole('button', { name: /reset/i });
    fireEvent.click(resetBtn);
    expect(onReset).toHaveBeenCalledOnce();
  });
});
