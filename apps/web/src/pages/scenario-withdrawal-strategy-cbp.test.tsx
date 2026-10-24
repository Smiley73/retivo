// CBP handling in the custom drawdown-order editor: CBP accounts are never orderable (the engine pays them as monthly income or rolls them into a target account), so they render in a read-only "not drawn down" info section instead of as draggable tier items.
// Covers the seeding/prune rule, the info-row builder, the save-validation split, the tier-editor info section, the moved `incomeAddPath` helper and the prune-opens-dirty flow.
import 'fake-indexeddb/auto';
import { render } from '@testing-library/react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WithdrawalStrategyEditor } from './scenario-withdrawal-strategy-editor';
import {
  buildCbpInfoRows,
  seedTierState,
} from './scenario-withdrawal-strategy-shared';
import { incomeAddPath } from '../lib/cbp-resolution';
import { CbpRemediationBanner } from '../components/CbpRemediationBanner';
import { clearAllStores, listPendingMutations } from '../db/store';
import { expectNoA11yViolations } from '../test/a11y';
import type {
  AccountPayload,
  AccountType,
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

const HH = 'hh-cbp';
const NO_MEMBERS: Aggregate<HouseholdMemberPayload>[] = [];
const NO_INCOME: Aggregate<IncomeStreamPayload>[] = [];

function makeScenario(
  id: string,
  overrides: ScenarioPayload['overrides'] = {},
  isPrimary = true,
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
    payload: { name: id, description: '', parentScenarioId, isPrimary, notes: '', overrides },
  };
}

function makeAccount(
  id: string,
  type: AccountType = 'RETIREMENT_401K',
  ownerId = 'member-1',
): Aggregate<AccountPayload> {
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
      ownerId,
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

function makePensionStream(
  id: string,
  linkedCbpAccountId: string,
  payoutType: 'annuity' | 'lumpSum',
  targetAccountId?: string,
  memberId = 'member-1',
): Aggregate<IncomeStreamPayload> {
  return {
    id,
    householdId: HH,
    aggregateType: 'incomeStream',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: id,
      memberId,
      kind: 'pension',
      payoutType,
      linkedCbpAccountId,
      ...(payoutType === 'lumpSum' ? { targetAccountId, lumpSumAmount: 100_000 } : { monthlyBenefit: 2_000 }),
    },
  };
}

function makeMember(id: string, isPrimary: boolean, firstName: string): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: { firstName, isPrimary } as unknown as HouseholdMemberPayload,
  };
}

// The discard-guard blocks render under BrowserRouter (real window.history) so the editor's useUnsavedChangesGuard pushState patch intercepts the in-app navigation; MemoryRouter keeps its own stack and would bypass it. Capture the path to restore.
const ROOT_PATH = window.location.pathname;

beforeEach(async () => {
  await clearAllStores();
});

afterEach(async () => {
  await clearAllStores();
  // Reset the URL so BrowserRouter-based tests don't leak path state.
  window.history.replaceState({}, '', ROOT_PATH);
  vi.clearAllMocks();
});

describe('seedTierState — CBP exclusion', () => {
  it('does not seed an active CBP account into tier 0 or Excluded (fresh)', () => {
    const result = seedTierState([makeAccount('acct-401k'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')], undefined);
    expect(result.tiers[0]).toEqual(['acct-401k']);
    expect(result.tiers.flat()).not.toContain('acct-cbp');
    expect(result.excludedAccountIds).not.toContain('acct-cbp');
  });

  it('prunes an active CBP id from a previously-saved order', () => {
    const result = seedTierState(
      [makeAccount('acct-401k'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')],
      { tiers: [['acct-401k', 'acct-cbp']], excludedAccountIds: [] },
    );
    expect(result.tiers[0]).toEqual(['acct-401k']);
    expect(result.tiers.flat()).not.toContain('acct-cbp');
  });

  it('still seeds HSAs to Excluded (unchanged rule)', () => {
    const result = seedTierState([makeAccount('acct-401k'), makeAccount('acct-hsa', 'HSA')], undefined);
    expect(result.tiers[0]).toEqual(['acct-401k']);
    expect(result.excludedAccountIds).toEqual(['acct-hsa']);
  });
});

describe('buildCbpInfoRows', () => {
  it('produces an annuity descriptor for an annuity-elected CBP account', () => {
    const cbp = makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE');
    const scenario = makeScenario('sc-1');
    const stream = makePensionStream('inc-1', 'acct-cbp', 'annuity');
    const rows = buildCbpInfoRows(scenario, [scenario], [cbp], [stream]);
    expect(rows).toEqual([{ accountId: 'acct-cbp', name: 'acct-cbp', kind: 'annuity' }]);
  });

  it('produces a lumpSum descriptor naming the target account', () => {
    const cbp = makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE');
    const target = makeAccount('acct-ira');
    const scenario = makeScenario('sc-1');
    const stream = makePensionStream('inc-1', 'acct-cbp', 'lumpSum', 'acct-ira');
    const rows = buildCbpInfoRows(scenario, [scenario], [cbp, target], [stream]);
    expect(rows).toEqual([
      { accountId: 'acct-cbp', name: 'acct-cbp', kind: 'lumpSum', targetName: 'acct-ira' },
    ]);
  });

  it('produces an unconfigured descriptor when no payout is elected', () => {
    const cbp = makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE');
    const scenario = makeScenario('sc-1');
    const rows = buildCbpInfoRows(scenario, [scenario], [cbp], NO_INCOME);
    expect(rows).toEqual([{ accountId: 'acct-cbp', name: 'acct-cbp', kind: 'unconfigured' }]);
  });

  it('produces a conflict descriptor when more than one stream links to the CBP', () => {
    const cbp = makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE');
    const scenario = makeScenario('sc-1');
    const streamA = makePensionStream('inc-1', 'acct-cbp', 'annuity');
    const streamB = makePensionStream('inc-2', 'acct-cbp', 'annuity');
    const rows = buildCbpInfoRows(scenario, [scenario], [cbp], [streamA, streamB]);
    expect(rows).toEqual([{ accountId: 'acct-cbp', name: 'acct-cbp', kind: 'conflict' }]);
  });

  it('omits non-CBP accounts entirely', () => {
    const scenario = makeScenario('sc-1');
    const rows = buildCbpInfoRows(scenario, [scenario], [makeAccount('acct-401k')], NO_INCOME);
    expect(rows).toEqual([]);
  });
});

describe('incomeAddPath', () => {
  it('builds the expected income deep-link from the account', () => {
    const path = incomeAddPath(makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE', 'member-9'));
    expect(path).toBe(
      '/income/new?kind=pension&payoutType=annuity&linkedCbpAccountId=acct-cbp&memberId=member-9',
    );
  });

  it('CbpRemediationBanner still links to the income form after the move', () => {
    const cbp = makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE');
    const member = makeMember('member-1', true, 'Alex');
    const { container } = render(
      <MemoryRouter>
        <CbpRemediationBanner
          validation={{
            ok: false,
            unconfigured: ['acct-cbp'],
            annuityMissingStream: [],
            annuityDuplicateStream: [],
          }}
          accounts={[cbp]}
          members={[member]}
        />
      </MemoryRouter>,
    );
    const link = container.querySelector('a[href*="linkedCbpAccountId=acct-cbp"]');
    expect(link).not.toBeNull();
  });
});

describe('WithdrawalStrategyEditor — CBP info section', () => {
  function renderModal(
    accounts: Aggregate<AccountPayload>[],
    incomeStreams: Aggregate<IncomeStreamPayload>[],
    overrides: ScenarioPayload['overrides'],
  ): ReturnType<typeof render> {
    const scenario = makeScenario('sc-cbp', overrides);
    return render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={accounts}
          members={NO_MEMBERS}
          incomeStreams={incomeStreams}
          backPath="/scenarios/sc"

          onSaved={vi.fn()}
        />
      </MemoryRouter>,
    );
  }

  const customOrder: ScenarioPayload['overrides'] = {
    withdrawalStrategy: { kind: 'customOrder' },
    customDrawdownOrder: { tiers: [['acct-401k']], excludedAccountIds: [] },
  };

  it('renders the annuity info-row variant and keeps the CBP out of the draggable lists', async () => {
    renderModal(
      [makeAccount('acct-401k'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')],
      [makePensionStream('inc-1', 'acct-cbp', 'annuity')],
      customOrder,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    await userEvent.click(screen.getByRole('tab', { name: /Custom order/i }));
    expect(screen.getByText(/paid as monthly income/i)).toBeTruthy();
    expect(screen.queryByRole('row', { name: /acct-cbp/i })).toBeNull();
  });

  it('renders the lump-sum info-row variant naming the target account', async () => {
    renderModal(
      [makeAccount('acct-401k'), makeAccount('acct-ira'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')],
      [makePensionStream('inc-1', 'acct-cbp', 'lumpSum', 'acct-ira')],
      { withdrawalStrategy: { kind: 'customOrder' }, customDrawdownOrder: { tiers: [['acct-401k', 'acct-ira']], excludedAccountIds: [] } },
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    await userEvent.click(screen.getByRole('tab', { name: /Custom order/i }));
    expect(screen.getByText(/rolled into/i)).toBeTruthy();
    expect(screen.getByText(/acct-ira at retirement/i)).toBeTruthy();
  });

  it('renders the unconfigured info-row variant with an elect-a-payout control', async () => {
    renderModal(
      [makeAccount('acct-401k'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')],
      NO_INCOME,
      customOrder,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    await userEvent.click(screen.getByRole('tab', { name: /Custom order/i }));
    expect(screen.getByText(/choose how this pension pays out/i)).toBeTruthy();
    // The affordance is a `<button>`: navigation routes through the page-level unsaved-changes guard when dirty (see the "Elect a payout discard guard" block).
    expect(
      screen.getByRole('button', { name: /Elect a payout/i }),
    ).toBeTruthy();
  });

  it('renders the conflict info-row variant with a review-pensions control, not elect-a-payout', async () => {
    renderModal(
      [makeAccount('acct-401k'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')],
      [
        makePensionStream('inc-1', 'acct-cbp', 'annuity'),
        makePensionStream('inc-2', 'acct-cbp', 'annuity'),
      ],
      customOrder,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    await userEvent.click(screen.getByRole('tab', { name: /Custom order/i }));
    expect(screen.getByText(/more than one pension income stream/i)).toBeTruthy();
    // The conflict remediation reviews the existing pensions and must not offer the create-new "Elect a payout" deep link (that would deepen the duplication).
    expect(
      screen.getByRole('button', { name: /Review pensions for acct-cbp/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Elect a payout/i }),
    ).toBeNull();
  });

  it('gives each unconfigured CBP row an account-specific elect-a-payout name', async () => {
    renderModal(
      [
        makeAccount('acct-401k'),
        makeAccount('acct-cbp-a', 'RETIREMENT_CASH_BALANCE'),
        makeAccount('acct-cbp-b', 'RETIREMENT_CASH_BALANCE'),
      ],
      NO_INCOME,
      customOrder,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    await userEvent.click(screen.getByRole('tab', { name: /Custom order/i }));
    expect(
      screen.getByRole('button', { name: /Elect a payout for acct-cbp-a/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Elect a payout for acct-cbp-b/i }),
    ).toBeTruthy();
  });

  it('CBP info section passes the a11y smoke', async () => {
    const { container } = renderModal(
      [makeAccount('acct-401k'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')],
      [makePensionStream('inc-1', 'acct-cbp', 'annuity')],
      customOrder,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    await userEvent.click(screen.getByRole('tab', { name: /Custom order/i }));
    await expectNoA11yViolations(container);
  });
});

describe('WithdrawalStrategyEditor — validation with CBP', () => {
  it('save succeeds when only non-CBP accounts are placed (CBP unplaced is fine)', async () => {
    const onSaved = vi.fn();
    const scenario = makeScenario('sc-save', {
      withdrawalStrategy: { kind: 'customOrder' },
      // A saved order referencing a now-pruned CBP id opens dirty (the prune is surfaced).
      customDrawdownOrder: { tiers: [['acct-401k', 'acct-cbp']], excludedAccountIds: [] },
    });
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={[makeAccount('acct-401k'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')]}
          members={NO_MEMBERS}
          incomeStreams={[makePensionStream('inc-1', 'acct-cbp', 'annuity')]}
          backPath="/scenarios/sc"

          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect(saveBtn).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const pending = await listPendingMutations();
    const mut = pending.find((p) => p.aggregateId === 'sc-save');
    const payload = mut!.payload as ScenarioPayload;
    expect(payload.overrides.customDrawdownOrder?.tiers.flat()).not.toContain('acct-cbp');
  });

  it('still blocks save when a non-CBP account is left unplaced', async () => {
    const scenario = makeScenario('sc-block', {
      withdrawalStrategy: { kind: 'customOrder' },
      customDrawdownOrder: { tiers: [['acct-401k']], excludedAccountIds: [] },
    });
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={[makeAccount('acct-401k'), makeAccount('acct-other'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')]}
          members={NO_MEMBERS}
          incomeStreams={[makePensionStream('inc-1', 'acct-cbp', 'annuity')]}
          backPath="/scenarios/sc"

          onSaved={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    await userEvent.click(screen.getByRole('tab', { name: /Custom order/i }));
    await waitFor(() =>
      expect(screen.getByText(/Place every account into a tier or the Excluded section/i)).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('all-CBP household surfaces the tier message, not "Add at least one account"', async () => {
    const scenario = makeScenario('sc-allcbp', {
      withdrawalStrategy: { kind: 'customOrder' },
      customDrawdownOrder: { tiers: [[]], excludedAccountIds: [] },
    });
    render(
      <MemoryRouter>
        <WithdrawalStrategyEditor
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={[makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')]}
          members={NO_MEMBERS}
          incomeStreams={[makePensionStream('inc-1', 'acct-cbp', 'annuity')]}
          backPath="/scenarios/sc"

          onSaved={vi.fn()}
        />
      </MemoryRouter>,
    );
    await screen.findByRole('tab', { name: /Strategy/ });
    await userEvent.click(screen.getByRole('tab', { name: /Custom order/i }));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('alert')
          .some((a) => /place at least one account in a drawdown tier/i.test(a.textContent ?? '')),
      ).toBe(true),
    );
    expect(
      screen
        .queryAllByRole('alert')
        .some((a) => /Add at least one account before configuring/i.test(a.textContent ?? '')),
    ).toBe(false);
  });
});

// The editor is an explicit-Save surface, and navigating to the income-add flow unmounts it and would silently drop an in-progress draft, so while dirty the page-level useUnsavedChangesGuard intercepts the pathname change and prompts Stay/Leave; when clean it navigates directly.

describe('WithdrawalStrategyEditor — Elect a payout discard guard', () => {
  // Surfaces the current pathname so the test can assert whether the in-app navigation to /income/new happened.
  function LocationProbe(): React.ReactElement {
    const location = useLocation();
    return <div data-testid="pathname">{location.pathname}</div>;
  }

  function renderModalAt(
    accounts: Aggregate<AccountPayload>[],
    incomeStreams: Aggregate<IncomeStreamPayload>[],
    overrides: ScenarioPayload['overrides'],
  ): ReturnType<typeof render> {
    const scenario = makeScenario('sc-elect', overrides);
    // BrowserRouter (real window.history) so the editor's guard pushState patch can intercept the navigation while dirty.
    window.history.replaceState({}, '', '/scenarios/sc-elect');
    return render(
      <BrowserRouter>
        <LocationProbe />
        <Routes>
          <Route
            path="/scenarios/sc-elect"
            element={
              <WithdrawalStrategyEditor
                scenario={scenario}
                scenarios={[scenario]}
                householdId={HH}
                accounts={accounts}
                members={NO_MEMBERS}
                incomeStreams={incomeStreams}
                backPath="/scenarios/sc"
                onSaved={vi.fn()}
              />
            }
          />
          <Route path="/income/new" element={<div>income form</div>} />
        </Routes>
      </BrowserRouter>,
    );
  }

  // A saved order referencing a now-pruned CBP id opens the draft dirty (the prune is surfaced as an edit); with no income stream the CBP row is the unconfigured variant carrying "Elect a payout".
  const dirtyUnconfigured: ScenarioPayload['overrides'] = {
    withdrawalStrategy: { kind: 'customOrder' },
    customDrawdownOrder: { tiers: [['acct-401k', 'acct-cbp']], excludedAccountIds: [] },
  };
  const cleanUnconfigured: ScenarioPayload['overrides'] = {
    withdrawalStrategy: { kind: 'customOrder' },
    customDrawdownOrder: { tiers: [['acct-401k']], excludedAccountIds: [] },
  };

  async function openCustomTabAndElect(): Promise<void> {
    await screen.findByRole('tab', { name: /Strategy/ });
    await userEvent.click(screen.getByRole('tab', { name: /Custom order/i }));
    await screen.findByText(/choose how this pension pays out/i);
    await userEvent.click(screen.getByRole('button', { name: /Elect a payout/i }));
  }

  it('prompts before navigating when the draft is dirty', async () => {
    renderModalAt(
      [makeAccount('acct-401k'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')],
      NO_INCOME,
      dirtyUnconfigured,
    );
    await openCustomTabAndElect();
    expect(
      screen.getByRole('heading', { name: /unsaved changes/i }),
    ).toBeTruthy();
    expect(screen.getByTestId('pathname').textContent).toBe('/scenarios/sc-elect');
  });

  it('navigates after the discard prompt is confirmed', async () => {
    renderModalAt(
      [makeAccount('acct-401k'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')],
      NO_INCOME,
      dirtyUnconfigured,
    );
    await openCustomTabAndElect();
    await userEvent.click(screen.getByRole('button', { name: /^Leave$/i }));
    await waitFor(() =>
      expect(screen.getByTestId('pathname').textContent).toBe('/income/new'),
    );
  });

  it('keeps the editor mounted when the discard prompt is dismissed', async () => {
    renderModalAt(
      [makeAccount('acct-401k'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')],
      NO_INCOME,
      dirtyUnconfigured,
    );
    await openCustomTabAndElect();
    await userEvent.click(screen.getByRole('button', { name: /^Stay$/i }));
    expect(screen.getByTestId('pathname').textContent).toBe('/scenarios/sc-elect');
  });

  it('navigates directly without prompting when the draft is clean', async () => {
    renderModalAt(
      [makeAccount('acct-401k'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')],
      NO_INCOME,
      cleanUnconfigured,
    );
    await openCustomTabAndElect();
    // No Stay/Leave prompt; navigation reaches the income form synchronously.
    expect(screen.queryByRole('button', { name: /^Leave$/i })).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('pathname').textContent).toBe('/income/new'),
    );
  });
});

// A CBP with more than one linked pension stream renders the read-only conflict row, whose "Review pensions" control navigates to the income list (/income) so the user can remove the extra streams, not the income-add deep link (/income/new), which would deepen the duplication. Like the elect path it unmounts the editor, so the page-level guard prompts while dirty and navigates directly when clean.

describe('WithdrawalStrategyEditor — Review pensions conflict discard guard', () => {
  // Surfaces the current pathname so the test can assert whether navigation to /income happened (and not /income/new).
  function LocationProbe(): React.ReactElement {
    const location = useLocation();
    return <div data-testid="pathname">{location.pathname}</div>;
  }

  function renderModalAt(
    accounts: Aggregate<AccountPayload>[],
    incomeStreams: Aggregate<IncomeStreamPayload>[],
    overrides: ScenarioPayload['overrides'],
  ): ReturnType<typeof render> {
    const scenario = makeScenario('sc-conflict', overrides);
    // BrowserRouter (real window.history) so the guard's pushState patch can intercept the navigation while dirty.
    window.history.replaceState({}, '', '/scenarios/sc-conflict');
    return render(
      <BrowserRouter>
        <LocationProbe />
        <Routes>
          <Route
            path="/scenarios/sc-conflict"
            element={
              <WithdrawalStrategyEditor
                scenario={scenario}
                scenarios={[scenario]}
                householdId={HH}
                accounts={accounts}
                members={NO_MEMBERS}
                incomeStreams={incomeStreams}
                backPath="/scenarios/sc"
                onSaved={vi.fn()}
              />
            }
          />
          {/* Distinct placeholders so a regression to /income/new is caught. */}
          <Route path="/income" element={<div>income list</div>} />
          <Route path="/income/new" element={<div>income form</div>} />
        </Routes>
      </BrowserRouter>,
    );
  }

  const conflictStreams = [
    makePensionStream('inc-1', 'acct-cbp', 'annuity'),
    makePensionStream('inc-2', 'acct-cbp', 'annuity'),
  ];
  const dirtyConflict: ScenarioPayload['overrides'] = {
    withdrawalStrategy: { kind: 'customOrder' },
    customDrawdownOrder: { tiers: [['acct-401k', 'acct-cbp']], excludedAccountIds: [] },
  };
  const cleanConflict: ScenarioPayload['overrides'] = {
    withdrawalStrategy: { kind: 'customOrder' },
    customDrawdownOrder: { tiers: [['acct-401k']], excludedAccountIds: [] },
  };

  async function openCustomTabAndReview(): Promise<void> {
    await screen.findByRole('tab', { name: /Strategy/ });
    await userEvent.click(screen.getByRole('tab', { name: /Custom order/i }));
    await screen.findByText(/more than one pension income stream/i);
    await userEvent.click(
      screen.getByRole('button', { name: /Review pensions for acct-cbp/i }),
    );
  }

  it('prompts before navigating when the draft is dirty', async () => {
    renderModalAt(
      [makeAccount('acct-401k'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')],
      conflictStreams,
      dirtyConflict,
    );
    await openCustomTabAndReview();
    expect(
      screen.getByRole('heading', { name: /unsaved changes/i }),
    ).toBeTruthy();
    expect(screen.getByTestId('pathname').textContent).toBe('/scenarios/sc-conflict');
  });

  it('navigates to /income (not /income/new) after the discard prompt is confirmed', async () => {
    renderModalAt(
      [makeAccount('acct-401k'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')],
      conflictStreams,
      dirtyConflict,
    );
    await openCustomTabAndReview();
    await userEvent.click(screen.getByRole('button', { name: /^Leave$/i }));
    await waitFor(() =>
      expect(screen.getByTestId('pathname').textContent).toBe('/income'),
    );
    expect(screen.getByTestId('pathname').textContent).not.toBe('/income/new');
  });

  it('keeps the editor mounted when the discard prompt is dismissed', async () => {
    renderModalAt(
      [makeAccount('acct-401k'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')],
      conflictStreams,
      dirtyConflict,
    );
    await openCustomTabAndReview();
    await userEvent.click(screen.getByRole('button', { name: /^Stay$/i }));
    expect(screen.getByTestId('pathname').textContent).toBe('/scenarios/sc-conflict');
  });

  it('navigates directly to /income without prompting when the draft is clean', async () => {
    renderModalAt(
      [makeAccount('acct-401k'), makeAccount('acct-cbp', 'RETIREMENT_CASH_BALANCE')],
      conflictStreams,
      cleanConflict,
    );
    await openCustomTabAndReview();
    expect(screen.queryByRole('button', { name: /^Leave$/i })).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('pathname').textContent).toBe('/income'),
    );
    expect(screen.getByTestId('pathname').textContent).not.toBe('/income/new');
  });
});
