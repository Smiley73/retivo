/**
 * Cash Balance Pension (CBP) handling in the custom drawdown-order editor.
 *
 * CBP accounts are never orderable — the engine pays them as monthly income
 * (annuity) or rolls them into a target account (lump sum), so they must not
 * appear as draggable tier items. They render in a read-only "not drawn down"
 * info section instead. These tests cover the seeding/prune rule, the
 * info-row builder, the save-validation split, the tier-editor info
 * section, the moved `incomeAddPath` helper, and the prune-opens-dirty flow.
 *
 * Sibling to ScenarioWithdrawalStrategyCards.editor.test.tsx (kept separate
 * because that file is already over the 800-line cap).
 */
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

// The discard-guard blocks below render under BrowserRouter (real
// window.history) so the editor's useUnsavedChangesGuard pushState patch
// actually intercepts the in-app navigation — MemoryRouter keeps its own
// in-memory stack and would bypass the patch. Capture the path to restore.
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

// ——— seedTierState: CBP never seeded / pruned ————————————————

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

// ——— buildCbpInfoRows: descriptor per election state ————————————

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

// ——— incomeAddPath (moved to cbp-resolution) ————————————————

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

// ——— Tier editor info section ————————————————————————————

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
    // CBP account is not a draggable grid row.
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
    // The affordance is a <button> — the navigation routes through the
    // page-level unsaved-changes guard when dirty (covered by the "Elect a
    // payout discard guard" describe block below).
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
    // The conflict remediation reviews the existing pensions; it must NOT offer
    // the create-new "Elect a payout" deep-link (that would deepen the duplication).
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

// ——— Save validation with CBP ————————————————————————

describe('WithdrawalStrategyEditor — validation with CBP', () => {
  it('save succeeds when only non-CBP accounts are placed (CBP unplaced is fine)', async () => {
    const onSaved = vi.fn();
    const scenario = makeScenario('sc-save', {
      withdrawalStrategy: { kind: 'customOrder' },
      // Saved order references a now-pruned CBP id → opens dirty (prune surfaced).
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
    // Pruned CBP id makes the draft dirty → Save enabled, no validation error.
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect(saveBtn).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const pending = await listPendingMutations();
    const mut = pending.find((p) => p.aggregateId === 'sc-save');
    const payload = mut!.payload as ScenarioPayload;
    // Re-saving does not write the CBP id back.
    expect(payload.overrides.customDrawdownOrder?.tiers.flat()).not.toContain('acct-cbp');
  });

  it('still blocks save when a non-CBP account is left unplaced', async () => {
    const scenario = makeScenario('sc-block', {
      withdrawalStrategy: { kind: 'customOrder' },
      // acct-other is active + non-CBP but not in any tier/excluded → unplaced.
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
    // The empty-tiers message renders in the validation Alert (role="alert").
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('alert')
          .some((a) => /place at least one account in a drawdown tier/i.test(a.textContent ?? '')),
      ).toBe(true),
    );
    // Not the "no accounts at all" guard — the household DOES have an account.
    expect(
      screen
        .queryAllByRole('alert')
        .some((a) => /Add at least one account before configuring/i.test(a.textContent ?? '')),
    ).toBe(false);
  });
});

// ——— Elect-a-payout discard guard ————————————————————
// The editor is an explicit-Save surface; navigating to the income-add flow
// unmounts it and would silently drop an in-progress draft. The "Elect a
// payout" affordance navigates directly; while dirty the page-level
// useUnsavedChangesGuard intercepts the pathname change and prompts Stay/Leave,
// and navigates directly when clean.

describe('WithdrawalStrategyEditor — Elect a payout discard guard', () => {
  // Surfaces the current pathname so the test can assert whether the
  // in-app navigation to /income/new actually happened.
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
    // BrowserRouter (real window.history) so the editor's guard pushState
    // patch can intercept the elect-a-payout navigation while dirty.
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

  // Saved order references a now-pruned CBP id → the draft opens dirty (the
  // prune is surfaced as an edit). No income stream → the CBP row is
  // the unconfigured variant carrying the "Elect a payout" affordance.
  const dirtyUnconfigured: ScenarioPayload['overrides'] = {
    withdrawalStrategy: { kind: 'customOrder' },
    customDrawdownOrder: { tiers: [['acct-401k', 'acct-cbp']], excludedAccountIds: [] },
  };
  // Saved order already pruned → no CBP id present, draft opens clean.
  const cleanUnconfigured: ScenarioPayload['overrides'] = {
    withdrawalStrategy: { kind: 'customOrder' },
    customDrawdownOrder: { tiers: [['acct-401k']], excludedAccountIds: [] },
  };

  async function openCustomTabAndElect(): Promise<void> {
    await screen.findByRole('tab', { name: /Strategy/ });
    await userEvent.click(screen.getByRole('tab', { name: /Custom order/i }));
    // Wait for the unconfigured CBP info row to render before electing.
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
    // Discard prompt is shown and navigation has NOT happened yet.
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
    // Confirm the discard → navigation proceeds to the income form.
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
    // No Stay/Leave prompt is opened; navigation reaches the income form
    // synchronously (the route renders its placeholder).
    expect(screen.queryByRole('button', { name: /^Leave$/i })).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('pathname').textContent).toBe('/income/new'),
    );
  });
});

// ——— Review-pensions (conflict) discard guard ————————————
// A CBP with more than one linked pension stream renders the read-only conflict
// info row, whose "Review pensions" control navigates to the income LIST
// (/income) so the user can remove the extra streams — NOT the income-add deep
// link (/income/new), which would deepen the duplication. Like the elect path
// it unmounts the explicit-Save editor, so the page-level guard intercepts the
// pathname change with the same Stay/Leave prompt while dirty and navigates
// directly when clean.

describe('WithdrawalStrategyEditor — Review pensions conflict discard guard', () => {
  // Surfaces the current pathname so the test can assert whether the in-app
  // navigation to /income actually happened (and that it is NOT /income/new).
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
    // BrowserRouter (real window.history) so the editor's guard pushState
    // patch can intercept the review-pensions navigation while dirty.
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

  // Two annuity streams link the same CBP → the conflict info row, which carries
  // the "Review pensions" control.
  const conflictStreams = [
    makePensionStream('inc-1', 'acct-cbp', 'annuity'),
    makePensionStream('inc-2', 'acct-cbp', 'annuity'),
  ];
  // Saved order references a now-pruned CBP id → the draft opens dirty (the
  // prune is surfaced as an edit).
  const dirtyConflict: ScenarioPayload['overrides'] = {
    withdrawalStrategy: { kind: 'customOrder' },
    customDrawdownOrder: { tiers: [['acct-401k', 'acct-cbp']], excludedAccountIds: [] },
  };
  // Saved order already pruned → no CBP id present, draft opens clean.
  const cleanConflict: ScenarioPayload['overrides'] = {
    withdrawalStrategy: { kind: 'customOrder' },
    customDrawdownOrder: { tiers: [['acct-401k']], excludedAccountIds: [] },
  };

  async function openCustomTabAndReview(): Promise<void> {
    await screen.findByRole('tab', { name: /Strategy/ });
    await userEvent.click(screen.getByRole('tab', { name: /Custom order/i }));
    // Wait for the conflict CBP info row to render before reviewing.
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
    // Discard prompt is shown and navigation has NOT happened yet.
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
    // Confirm the discard → navigation proceeds to the income LIST so the user
    // can remove the extra streams, never the create-new income form.
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
    // No Stay/Leave prompt is opened; navigation reaches the income list
    // synchronously, and never the create-new form.
    expect(screen.queryByRole('button', { name: /^Leave$/i })).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('pathname').textContent).toBe('/income'),
    );
    expect(screen.getByTestId('pathname').textContent).not.toBe('/income/new');
  });
});
