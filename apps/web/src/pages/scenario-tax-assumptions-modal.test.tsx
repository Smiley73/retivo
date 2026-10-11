/**
 * TaxAssumptionsModal — unit tests.
 *
 * The Tax assumptions editor is a STANDALONE modal (decoupled from the
 * withdrawal-strategy modal). Its two concerns are split into React Aria tabs
 * ("HSA" + "Penalty exemptions"), modelled after the withdrawal-strategy modal.
 * Covers: HSA slider persistence (default tab); per-account penalty-exempt
 * toggle (Penalty exemptions tab); non-penalty account types render no toggle;
 * Save writes ONLY the tax keys (unrelated overrides preserved); orphaned
 * (deleted-account) ids pruned on save; Save disabled when clean; a11y smoke.
 */
import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaxAssumptionsModal } from './ScenarioWithdrawalStrategyCards';
import { clearAllStores, listPendingMutations } from '../db/store';
import {
  openEndedStatusWindow,
  resolveFilingPlanForYear,
  summarizeFilingPlan,
  type FilingStatusWindow,
} from '../lib/filing-status';
import { expectNoA11yViolations } from '../test/a11y';
import type {
  AccountPayload,
  AccountType,
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

const HH = 'hh-test';
const NO_ACCOUNTS = [] as const;
const NO_MEMBERS = [] as const;

function makeMember(id: string, isPrimary: boolean): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      firstName: isPrimary ? 'Ada' : 'Grace',
      lastName: 'Tester',
      isPrimary,
      birthdate: isPrimary ? '1962-04-02' : '1963-09-11',
    } as HouseholdMemberPayload,
  };
}

const SOLO = [makeMember('m-primary', true)] as const;
const COUPLE = [makeMember('m-primary', true), makeMember('m-secondary', false)] as const;

function makeScenario(
  id: string,
  overrides: ScenarioPayload['overrides'] = {},
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
      parentScenarioId: null,
      isPrimary: false,
      notes: '',
      overrides,
    },
  };
}

function makeAccount(
  id: string,
  type: AccountType = 'RETIREMENT_401K',
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

beforeEach(async () => {
  await clearAllStores();
});

afterEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
});

describe('TaxAssumptionsModal', () => {
  it('renders a plain-English intro paragraph at text-sm above the tabs', async () => {
    // Scenario-modal copy convention: the modal
    // opens with a `<p className="m-0 text-sm">` plain-English intro above the
    // tab strip (pinned body-copy size).
    const scenario = makeScenario('sc-intro');
    render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    const intro = screen.getByText(
      /Tell the projection how your withdrawals are taxed/i,
    );
    expect(intro.tagName).toBe('P');
    expect(intro).toHaveClass('text-sm');
  });

  it('opens on the HSA tab by default with an HSA + Penalty exemptions tab strip', async () => {
    const scenario = makeScenario('sc-open');
    const { container } = render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    // Two tabs, modelled after the withdrawal-strategy modal.
    expect(screen.getByRole('tab', { name: 'HSA' })).toHaveAttribute(
      'data-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /Penalty exemptions/i })).toBeTruthy();
    // HSA panel content is visible on first paint (default tab).
    expect(
      screen.getByRole('slider', {
        name: /Percent of emergency HSA withdrawals still backed by qualified medical care/i,
      }),
    ).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it('saves hsaQualifiedMedicalExpensePct from the slider', async () => {
    const scenario = makeScenario('sc-hsa');
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          onClose={onClose}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    // Slider defaults to 100; step is 5, so four ArrowLeft presses → 80.
    const pct = screen.getByRole('slider', {
      name: /Percent of emergency HSA withdrawals still backed by qualified medical care/i,
    });
    pct.focus();
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const pending = await listPendingMutations();
    const mut = pending.find((p) => p.aggregateId === 'sc-hsa');
    expect(mut).toBeTruthy();
    const payload = mut!.payload as ScenarioPayload;
    expect(payload.overrides.hsaQualifiedMedicalExpensePct).toBe(80);
  });

  it('toggles an account into earlyWithdrawalPenaltyExemptAccountIds', async () => {
    const acctA = makeAccount('acct-a');
    const scenario = makeScenario('sc-exempt');
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={[acctA]}
          members={NO_MEMBERS}
          onClose={onClose}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await userEvent.click(screen.getByRole('tab', { name: /Penalty exemptions/i }));

    const toggle = screen.getByRole('switch', {
      name: /Exempt acct-a from the early-withdrawal penalty/i,
    });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const pending = await listPendingMutations();
    const mut = pending.find((p) => p.aggregateId === 'sc-exempt');
    const payload = mut!.payload as ScenarioPayload;
    expect(payload.overrides.earlyWithdrawalPenaltyExemptAccountIds).toEqual(['acct-a']);
  });

  it('the penalty-exempt nudge states the app does not validate eligibility', async () => {
    const roth = makeAccount('roth-a', 'RETIREMENT_ROTH_IRA');
    const scenario = makeScenario('sc-nudge');
    render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={[roth]}
          members={NO_MEMBERS}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await userEvent.click(screen.getByRole('tab', { name: /Penalty exemptions/i }));
    // Nudge reads coherently for the Roth-IRA row: contributions penalty-free,
    // income tax on earnings still applies, and the app does not validate the
    // exemption eligibility rules. (The a11y scan lives in the dedicated
    // smoke describe below — one representative scan per the AGENTS rule.)
    expect(screen.getByText(/does not check those eligibility rules/i)).toBeTruthy();
    expect(screen.getByText(/your own contributions always come out penalty-free/i)).toBeTruthy();
  });

  it('renders a penalty toggle for a Roth IRA (Option A, earnings tranche)', async () => {
    // A pre-59½ Roth IRA earnings draw can incur the 10% penalty, so
    // the picker now lists Roth IRAs and toggling persists the id (waiving the
    // earnings-tranche penalty; the income tax on the earnings still applies).
    const roth = makeAccount('roth-a', 'RETIREMENT_ROTH_IRA');
    const scenario = makeScenario('sc-roth');
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={[roth]}
          members={NO_MEMBERS}
          onClose={onClose}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await userEvent.click(screen.getByRole('tab', { name: /Penalty exemptions/i }));
    const toggle = screen.getByRole('switch', {
      name: /Exempt roth-a from the early-withdrawal penalty/i,
    });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const pending = await listPendingMutations();
    const mut = pending.find((p) => p.aggregateId === 'sc-roth');
    const payload = mut!.payload as ScenarioPayload;
    expect(payload.overrides.earlyWithdrawalPenaltyExemptAccountIds).toEqual(['roth-a']);
  });

  it('Save writes ONLY the tax key, preserving an unrelated existing override', async () => {
    // Pre-existing withdrawal-strategy override must survive a tax-only save.
    const scenario = makeScenario('sc-preserve', {
      withdrawalStrategy: { kind: 'rothFirst' },
    });
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          onClose={onClose}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    const pct = screen.getByRole('slider', {
      name: /Percent of emergency HSA withdrawals still backed by qualified medical care/i,
    });
    pct.focus();
    await userEvent.keyboard('{ArrowLeft}'); // 100 → 95

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const pending = await listPendingMutations();
    const payload = pending.find((p) => p.aggregateId === 'sc-preserve')!
      .payload as ScenarioPayload;
    expect(payload.overrides.hsaQualifiedMedicalExpensePct).toBe(95);
    expect(payload.overrides.withdrawalStrategy).toEqual({ kind: 'rothFirst' });
    // The penalty key was never touched, so it stays absent.
    expect(
      Object.prototype.hasOwnProperty.call(
        payload.overrides,
        'earlyWithdrawalPenaltyExemptAccountIds',
      ),
    ).toBe(false);
  });

  it('prunes a deleted-account id from the exempt list on save', async () => {
    // Scenario locally exempts a live account + one that has since been
    // deleted (absent from `accounts`). Toggling the live account off then on
    // keeps the modal dirty; saving drops the orphan.
    const live = makeAccount('acct-live');
    const scenario = makeScenario('sc-prune', {
      earlyWithdrawalPenaltyExemptAccountIds: ['acct-live', 'acct-deleted'],
    });
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={[live]}
          members={NO_MEMBERS}
          onClose={onClose}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    // Nudge the HSA slider so the modal is dirty (the exempt list itself is
    // unchanged by the user, but prune-on-save still cleans the orphan).
    const pct = screen.getByRole('slider', {
      name: /Percent of emergency HSA withdrawals still backed by qualified medical care/i,
    });
    pct.focus();
    await userEvent.keyboard('{ArrowLeft}');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const pending = await listPendingMutations();
    const payload = pending.find((p) => p.aggregateId === 'sc-prune')!
      .payload as ScenarioPayload;
    expect(payload.overrides.earlyWithdrawalPenaltyExemptAccountIds).toEqual([
      'acct-live',
    ]);
  });

  it('Save is disabled when nothing changed', async () => {
    const scenario = makeScenario('sc-clean');
    render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={NO_MEMBERS}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('TaxAssumptionsModal — filing editor', () => {
  // -------------------------------------------------------------------------
  // Filing editor
  // -------------------------------------------------------------------------

  it('a couple defaults to filing together, with the exception list empty', async () => {
    const scenario = makeScenario('sc-filing-default');
    render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={COUPLE}
          initialTab="filing"
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByRole('radio', { name: /File together on one return/i })).toBeChecked();
    expect(
      screen.getByRole('radio', { name: /File apart on two returns/i }),
    ).not.toBeChecked();
    expect(
      screen.getByText(/every year after a death is filed single/i),
    ).toBeInTheDocument();
  });

  it('a one-member household shows no joint/separate choice', async () => {
    const scenario = makeScenario('sc-filing-solo');
    render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={SOLO}
          initialTab="filing"
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.queryByRole('radio', { name: /File together/i })).toBeNull();
    expect(
      screen.getByText(/only person in this plan, so every year is filed on your own/i),
    ).toBeInTheDocument();
  });

  it('switching to separate returns saves both MFS units, sizes, and lived-together', async () => {
    const scenario = makeScenario('sc-filing-separate');
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={COUPLE}
          initialTab="filing"
          onClose={onClose}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await userEvent.click(screen.getByRole('radio', { name: /File apart on two returns/i }));
    await userEvent.click(
      screen.getByRole('switch', { name: /lived together at some point during the year/i }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const pending = await listPendingMutations();
    const payload = pending.find((p) => p.aggregateId === 'sc-filing-separate')!
      .payload as ScenarioPayload;
    expect(payload.overrides.taxFilingPlan).toEqual({
      kind: 'separate',
      livedTogether: true,
      units: [
        { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
        { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
      ],
    });
  });

  it('resolving a legacy scalar saves a plan with NO filingStatus key and no stored null', async () => {
    // A two-member household carrying a `Single` scalar is the ambiguous case:
    // the resolver refuses it, the editor prompts, and saving must OMIT the
    // legacy key entirely rather than storing a `null` sentinel.
    const scenario = makeScenario('sc-filing-legacy', {
      filingStatus: 'Single',
      hsaQualifiedMedicalExpensePct: 70,
    });
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={COUPLE}
          initialTab="filing"
          onClose={onClose}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    // The resolution prompt is shown. Switching over is an EXPLICIT act —
    // Save stays disabled until the user actually uses the filing controls, so
    // the prompt carries a one-click "use the choice shown" affordance.
    expect(
      screen.getByText(/older filing setting that we cannot read for both of you/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /use the choice shown below/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const pending = await listPendingMutations();
    const payload = pending.find((p) => p.aggregateId === 'sc-filing-legacy')!
      .payload as ScenarioPayload;
    // The key is ABSENT, not present-and-null (a stored null would survive sync
    // as a dead key on every device).
    expect('filingStatus' in payload.overrides).toBe(false);
    expect(payload.overrides.filingStatus).toBeUndefined();
    expect(JSON.stringify(payload.overrides)).not.toContain('null');
    expect(payload.overrides.taxFilingPlan).toEqual({ kind: 'joint' });
    // Unrelated overrides survive untouched.
    expect(payload.overrides.hsaQualifiedMedicalExpensePct).toBe(70);
  });

  it('an HSA-only save invents no filing plan and keeps a resolvable legacy scalar', async () => {
    const scenario = makeScenario('sc-filing-untouched', { filingStatus: 'MFJ' });
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={COUPLE}
          onClose={onClose}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    const slider = screen.getByRole('slider', {
      name: /Percent of emergency HSA withdrawals/i,
    });
    slider.focus();
    await userEvent.keyboard('{ArrowLeft}');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const pending = await listPendingMutations();
    const payload = pending.find((p) => p.aggregateId === 'sc-filing-untouched')!
      .payload as ScenarioPayload;
    expect(payload.overrides.taxFilingPlan).toBeUndefined();
    expect(payload.overrides.filingStatus).toBe('MFJ');
  });

  it('adding then removing an exception window leaves the key absent (sparse-optional)', async () => {
    const scenario = makeScenario('sc-filing-windows');
    render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={COUPLE}
          initialTab="filing"
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: /Add an exception/i }));
    expect(
      screen.queryByText(/every year after a death is filed single/i),
    ).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Remove this exception/i }));
    expect(
      screen.getByText(/every year after a death is filed single/i),
    ).toBeInTheDocument();
  });

  it('the filing tab renders with no a11y violations (separate returns + an exception)', async () => {
    const scenario = makeScenario('sc-filing-a11y', {
      taxFilingPlan: {
        kind: 'separate',
        livedTogether: true,
        units: [
          { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
          { memberId: 'secondary', filingStatus: 'HoH', householdSize: 2 },
        ],
        statusWindows: [
          {
            status: 'QSS',
            start: { kind: 'year', year: 2040 },
            end: { kind: 'year', year: 2042 },
          },
        ],
      },
    });
    const { container } = render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={COUPLE}
          initialTab="filing"
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await expectNoA11yViolations(container);
  });
});

describe('TaxAssumptionsModal — filing editor (review fixes)', () => {
  const renderModal = (
    scenario: ScenarioAggregate,
    members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
    onClose: () => void,
    initialTab: 'hsa' | 'penalties' | 'filing' = 'hsa',
  ) =>
    render(
      <MemoryRouter>
        <TaxAssumptionsModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          accounts={NO_ACCOUNTS}
          members={members}
          initialTab={initialTab}
          onClose={onClose}
        />
      </MemoryRouter>,
    );
  /** React Aria `<Select>` — open the trigger, then pick the option by label. */
  const chooseOption = async (
    trigger: HTMLElement,
    optionName: string | RegExp,
  ): Promise<void> => {
    const user = userEvent.setup();
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: optionName }));
  };
  const savedOverrides = async (id: string): Promise<ScenarioPayload['overrides']> => {
    const pending = await listPendingMutations();
    const mut = pending.find((p) => p.aggregateId === id);
    expect(mut).toBeTruthy();
    return (mut!.payload as ScenarioPayload).overrides;
  };

  it('an HSA-only save keeps an AMBIGUOUS legacy scalar and writes no plan', async () => {
    // The regression: a two-member `Single` scalar is unresolvable, and the
    // editor used to treat its mere PRESENCE as "the filing editor changed
    // something" — so nudging the HSA slider on a tab the user never left
    // deleted `filingStatus` and stored a GUESSED `{ kind: 'joint' }` plan,
    // silently re-filing the whole projection as MFJ.
    const scenario = makeScenario('sc-f11-hsa-only', {
      filingStatus: 'Single',
      hsaQualifiedMedicalExpensePct: 80,
    });
    const onClose = vi.fn();
    renderModal(scenario, COUPLE, onClose);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    // Touch ONLY the HSA control.
    const slider = screen.getByRole('slider');
    await act(async () => {
      fireEvent.keyDown(slider, { key: 'ArrowLeft' });
      fireEvent.keyUp(slider, { key: 'ArrowLeft' });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const overrides = await savedOverrides('sc-f11-hsa-only');
    expect(overrides.filingStatus).toBe('Single');
    expect('taxFilingPlan' in overrides).toBe(false);
    expect(overrides.hsaQualifiedMedicalExpensePct).toBe(75);
  });

  it('the unsaved-changes guard does not fire on a read-only open and close', async () => {
    // `filingDirty` used to be unconditionally true for an unresolvable scalar,
    // so simply opening and closing the modal raised the discard prompt.
    const scenario = makeScenario('sc-f11-readonly', { filingStatus: 'Single' });
    const onClose = vi.fn();
    renderModal(scenario, COUPLE, onClose, 'filing');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('a one-member HoH scalar keeps head-of-household treatment on save', async () => {
    // A one-member `HoH` scalar RESOLVES cleanly (open-ended HoH), but the
    // editor used to seed a bare `{ kind: 'individual' }` plan — so the first
    // filing-adjacent save silently downgraded the household to Single
    // (2026: a $24,150 standard deduction drops to $16,100, plus narrower
    // brackets), with no warning and no control to re-express HoH.
    const scenario = makeScenario('sc-f12-hoh', { filingStatus: 'HoH' });
    const onClose = vi.fn();
    renderModal(scenario, SOLO, onClose, 'filing');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    // No resolution prompt — this scalar converts cleanly.
    expect(
      screen.queryByText(/older filing setting that we cannot read/i),
    ).not.toBeInTheDocument();
    // The standing-status control opens on Head of household.
    expect(screen.getByLabelText('Files as')).toHaveTextContent('Head of household');

    // Any filing edit (adding an exception window) must PRESERVE the HoH plan.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add an exception/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const overrides = await savedOverrides('sc-f12-hoh');
    expect('filingStatus' in overrides).toBe(false);
    const plan = overrides.taxFilingPlan;
    expect(plan?.kind).toBe('individual');
    expect(
      (plan?.statusWindows ?? []).some((w) => w.status === 'HoH' && w.end.kind === 'year'),
    ).toBe(true);
  });

  it('switching to separate returns persists both units and the round trip back', async () => {
    const scenario = makeScenario('sc-f129-units');
    const onClose = vi.fn();
    renderModal(scenario, COUPLE, onClose, 'filing');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /file apart on two returns/i }));
    });
    // Change the SECOND spouse's status + return size.
    await chooseOption(screen.getAllByLabelText('Files as')[1], 'Head of household');
    await chooseOption(
      screen.getAllByLabelText('People counted on this return')[1],
      '3',
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const overrides = await savedOverrides('sc-f129-units');
    expect(overrides.taxFilingPlan).toEqual({
      kind: 'separate',
      units: [
        { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
        { memberId: 'secondary', filingStatus: 'HoH', householdSize: 3 },
      ],
    });
  });

  it('lived-together is cleared by HoH and never stored as false', async () => {
    const scenario = makeScenario('sc-f120-hoh', {
      taxFilingPlan: {
        kind: 'separate',
        livedTogether: true,
        units: [
          { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
          { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
        ],
      },
    });
    const onClose = vi.fn();
    renderModal(scenario, COUPLE, onClose, 'filing');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    const toggle = screen.getByRole('switch', {
      name: /lived together at some point during the year/i,
    });
    expect(toggle).not.toBeDisabled();
    // §2(c)/§7703(b): HoH requires living APART for the last six months, so
    // selecting it must clear the contradictory fact and lock the toggle.
    await chooseOption(screen.getAllByLabelText('Files as')[0], 'Head of household');
    expect(
      screen.getByRole('switch', { name: /lived together at some point during the year/i }),
    ).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const overrides = await savedOverrides('sc-f120-hoh');
    const plan = overrides.taxFilingPlan;
    // The key is ABSENT (absent → lived apart), never an explicit `false`.
    expect(plan && 'livedTogether' in plan).toBe(false);
    expect(JSON.stringify(plan)).not.toContain('livedTogether');
  });

  it('a couple whose scenario holds a one-person plan can still choose how they file', async () => {
    // The household editor supports adding a spouse at any time, so an
    // `{ kind: 'individual' }` plan saved while the user was alone outlives the
    // household it described. The Filing tab used to render the one-person
    // "Files as" control for it — no joint/separate radios anywhere — leaving
    // the couple with no way to fix a plan that files ONE Single return for
    // both of them.
    const scenario = makeScenario('sc-f21-individual-couple', {
      taxFilingPlan: { kind: 'individual' },
    });
    const onClose = vi.fn();
    renderModal(scenario, COUPLE, onClose, 'filing');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    // The prompt explains the saved choice could not be used, and
    // the joint/separate control is reachable.
    expect(
      screen.getByText(/could not use the filing choice saved for this scenario/i),
    ).toBeInTheDocument();
    // The editor opens on the composition default (joint) and BOTH options are
    // reachable, so the couple can express either treatment.
    expect(screen.getByRole('radio', { name: /file together on one return/i })).toBeChecked();
    const separate = screen.getByRole('radio', { name: /file apart on two returns/i });
    await act(async () => {
      fireEvent.click(separate);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect((await savedOverrides('sc-f21-individual-couple')).taxFilingPlan).toEqual({
      kind: 'separate',
      units: [
        { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
        { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
      ],
    });
  });

  it('a lone member with a stored couple plan sees the one-person control', async () => {
    // The mirror of the case above (the spouse was removed after the plan was
    // saved). Which picker renders follows the household that exists NOW, so a
    // one-person household never sees a joint/separate choice — and the
    // one-person "Files as" control stays reachable. The stored joint plan needs
    // no reset: with no spouse it already resolves to the sole member's Single
    // return.
    const scenario = makeScenario('sc-f21-joint-solo', {
      taxFilingPlan: { kind: 'joint' },
    });
    renderModal(scenario, SOLO, vi.fn(), 'filing');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(
      screen.queryByRole('radio', { name: /file together on one return/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Files as')).toHaveTextContent('Single');
    expect(screen.queryByText(/could not use the filing choice/i)).not.toBeInTheDocument();
  });

  it('a corrupt separate payload opens on a sane default instead of throwing', async () => {
    // `taxFilingPlan` is user/sync data with no runtime schema behind it, and
    // the separate-returns controls index `units[0]`/`units[1]` directly — so a
    // short payload crashed the render of the very tab the resolution prompt deep-links
    // to for repairing it.
    const scenario = makeScenario('sc-f22-corrupt', {
      taxFilingPlan: {
        kind: 'separate',
        units: [{ memberId: 'primary', filingStatus: 'MFS', householdSize: 1 }],
      } as unknown as ScenarioPayload['overrides']['taxFilingPlan'],
    });
    const onClose = vi.fn();
    expect(() => renderModal(scenario, COUPLE, onClose, 'filing')).not.toThrow();
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    // Opened on the composition default (joint), with the reset explained.
    expect(
      screen.getByText(/could not use the filing choice saved for this scenario/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /file together on one return/i })).toBeChecked();
    // No half-rendered separate editor.
    expect(
      screen.queryByRole('switch', { name: /lived together at some point during the year/i }),
    ).not.toBeInTheDocument();

    // And the user can repair it from here — adopting the shown choice saves.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /use the choice shown below/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect((await savedOverrides('sc-f22-corrupt')).taxFilingPlan).toEqual({ kind: 'joint' });
  });

  it('a stored filing plan that is not an object opens on a sane default', async () => {
    // `taxFilingPlan: null` (and a list, and a bare string) all cleared the
    // `!== undefined` boundary check and then threw on the first `.kind` read,
    // so the Filing tab — the one surface that can repair the data — crashed on
    // open instead of falling back like every other unusable payload.
    for (const [index, stored] of [null, [{ kind: 'joint' }], 'joint', 7].entries()) {
      const scenario = makeScenario(`sc-f31-corrupt-${index}`, {
        taxFilingPlan: stored as unknown as ScenarioPayload['overrides']['taxFilingPlan'],
      });
      const view = renderModal(scenario, COUPLE, vi.fn(), 'filing');
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
      expect(
        screen.getByText(/could not use the filing choice saved for this scenario/i),
      ).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /file together on one return/i })).toBeChecked();
      view.unmount();
    }
  });

  it('a stored separate plan on a solo household shows only one-person controls', async () => {
    // The spouse was removed after the plan was saved. The filing-status picker already picked the
    // one-person picker from CURRENT membership, but the kind-specific
    // sub-editor still followed the stored `separate` kind — so the two-return
    // editor (two "Files as" selects, the lived-together toggle) rendered
    // directly beneath it, describing a spouse who is no longer in the plan.
    const scenario = makeScenario('sc-f36-separate-solo', {
      taxFilingPlan: {
        kind: 'separate',
        units: [
          { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
          { memberId: 'secondary', filingStatus: 'HoH', householdSize: 2 },
        ],
        livedTogether: true,
      },
    });
    renderModal(scenario, SOLO, vi.fn(), 'filing');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    // No two-return editor: no lived-together toggle, no per-spouse returns.
    expect(
      screen.queryByRole('switch', { name: /lived together at some point during the year/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/'s return/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/people counted on this return/i)).not.toBeInTheDocument();
    // No spouse-death copy for a household with no spouse.
    expect(screen.queryByText(/the year a spouse dies/i)).not.toBeInTheDocument();
    // Only the one-person control, and no joint/separate radios.
    expect(screen.getByLabelText('Files as')).toBeInTheDocument();
    expect(
      screen.queryByRole('radio', { name: /file apart on two returns/i }),
    ).not.toBeInTheDocument();
  });

  it('a QSS window longer than two tax years is flagged', async () => {
    const scenario = makeScenario('sc-f121-qss', {
      taxFilingPlan: {
        kind: 'joint',
        statusWindows: [
          { status: 'QSS', start: { kind: 'year', year: 2030 }, end: { kind: 'year', year: 2040 } },
        ],
      },
    });
    renderModal(scenario, COUPLE, vi.fn(), 'filing');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(
      screen.getByText(/lasts at most 2 tax years after the year your spouse dies/i),
    ).toBeInTheDocument();
  });

  it('a standing status set while the spouse was away still matches what the engine files', async () => {
    // The reachable sequence behind the bug: a JOINT plan, the spouse is removed
    // for a while (so the one-person "Files as" control is the only filing
    // control on the tab), head of household is chosen there, and the spouse is
    // added back later. The stored plan is still `joint` — the radios were never
    // touched — but it now carries an OPEN-ENDED head-of-household window that
    // the couple's controls neither show nor list, while the resolver files the
    // survivor's return under it forever after a later death. The summary used to
    // promise "later years file single" regardless.
    const solo = makeScenario('sc-f41-standing', { taxFilingPlan: { kind: 'joint' } });
    const onClose = vi.fn();
    const soloView = renderModal(solo, SOLO, onClose, 'filing');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await chooseOption(screen.getByLabelText('Files as'), 'Head of household');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    const stored = (await savedOverrides('sc-f41-standing')).taxFilingPlan;
    expect(stored).toEqual({ kind: 'joint', statusWindows: [openEndedStatusWindow('HoH')] });
    soloView.unmount();

    // The spouse is back: the couple's editor offers the joint/separate radios,
    // no standing-status control, and no exception row for that window.
    const couple = makeScenario('sc-f41-standing-couple', { taxFilingPlan: stored });
    renderModal(couple, COUPLE, vi.fn(), 'filing');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByRole('radio', { name: /file together on one return/i })).toBeChecked();
    expect(screen.queryByLabelText('Files as')).not.toBeInTheDocument();
    expect(screen.getByText(/no exception years/i)).toBeInTheDocument();

    // So the summary is the only surface left that can disclose it — and it must
    // say exactly what the resolver files for the survivor.
    const summary = summarizeFilingPlan({
      taxFilingPlan: stored,
      hasSecondaryMember: true,
      taxYear: 2030,
    });
    expect(summary.afterADeath).toMatch(/later years file head of household/i);
    expect(
      resolveFilingPlanForYear({
        taxFilingPlan: stored,
        hasSecondaryMember: true,
        primaryAlive: true,
        secondaryAlive: false,
        taxYear: 2035,
      }),
    ).toEqual({
      kind: 'resolved',
      taxUnits: [{ memberIds: ['primary'], filingStatus: 'HoH' }],
    });
  });

  it('switching how a couple files drops a leftover standing status', async () => {
    // A couple's plan has no standing status of its own, so an open-ended window
    // on one can only be a leftover from a spell when the spouse was removed.
    // Choosing how the two of them file no longer carries it into the new plan —
    // the year-bounded exception the user really entered still comes across.
    const exception: FilingStatusWindow = {
      status: 'QSS',
      start: { kind: 'year', year: 2036 },
      end: { kind: 'year', year: 2038 },
    };
    const scenario = makeScenario('sc-f41-kind-switch', {
      taxFilingPlan: {
        kind: 'joint',
        statusWindows: [openEndedStatusWindow('HoH'), exception],
      },
    });
    const onClose = vi.fn();
    renderModal(scenario, COUPLE, onClose, 'filing');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /file apart on two returns/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect((await savedOverrides('sc-f41-kind-switch')).taxFilingPlan).toEqual({
      kind: 'separate',
      units: [
        { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
        { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
      ],
      statusWindows: [exception],
    });
  });

  it('an exception added to a standing head-of-household plan really is filed', async () => {
    // The bug, end to end through the editor: a one-person plan that files head of
    // household every year, then a qualifying-surviving-spouse exception added on
    // top. The row rendered and the plan saved, but the standing head-of-household
    // window covers every tax year — stored ahead of the exception it shadowed it,
    // so those years were still filed head of household with nothing on any screen
    // saying so.
    const scenario = makeScenario('sc-f51-inert-exception', {
      taxFilingPlan: { kind: 'individual', statusWindows: [openEndedStatusWindow('HoH')] },
    });
    const onClose = vi.fn();
    renderModal(scenario, SOLO, onClose, 'filing');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add an exception/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    // The fresh exception row is the two calendar years starting next year.
    const firstExceptionYear = new Date().getFullYear() + 1;
    const stored = (await savedOverrides('sc-f51-inert-exception')).taxFilingPlan!;
    expect(stored).toEqual({
      kind: 'individual',
      statusWindows: [
        {
          status: 'QSS',
          start: { kind: 'year', year: firstExceptionYear },
          end: { kind: 'year', year: firstExceptionYear + 2 },
        },
        // Stored LAST: the standing status is the fallback the exceptions above
        // interrupt, so the array reads in the order the resolver applies it.
        openEndedStatusWindow('HoH'),
      ],
    });

    // What the engines file for the SAVED plan: the exception years, then the
    // standing status again.
    const statusIn = (taxYear: number): string | undefined => {
      const res = resolveFilingPlanForYear({
        taxFilingPlan: stored,
        hasSecondaryMember: false,
        primaryAlive: true,
        secondaryAlive: false,
        taxYear,
      });
      return res.kind === 'resolved' ? res.taxUnits[0]?.filingStatus : undefined;
    };
    expect(statusIn(firstExceptionYear)).toBe('QSS');
    expect(statusIn(firstExceptionYear + 1)).toBe('QSS');
    expect(statusIn(firstExceptionYear - 1)).toBe('HoH');
    expect(statusIn(firstExceptionYear + 2)).toBe('HoH');
  });

  it('the editor copy names the standing status instead of promising single', async () => {
    // A plan whose standing status is head of household: the fallback the editor
    // describes must be that status, not a hardcoded "single" the resolver never
    // files. Same rule the report card and PDF sentence already follow.
    const solo = makeScenario('sc-f52-copy-solo', {
      taxFilingPlan: { kind: 'individual', statusWindows: [openEndedStatusWindow('HoH')] },
    });
    const soloView = renderModal(solo, SOLO, vi.fn(), 'filing');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(
      screen.getByText(/after a spouse dies the projection files head of household/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/every year after a death is filed head of household/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/filed single/i)).not.toBeInTheDocument();
    soloView.unmount();

    // The couple's intro sentence names it too — the standing window a joint plan
    // can still carry from a spell when the spouse was away.
    renderModal(
      makeScenario('sc-f52-copy-couple', {
        taxFilingPlan: { kind: 'joint', statusWindows: [openEndedStatusWindow('HoH')] },
      }),
      COUPLE,
      vi.fn(),
      'filing',
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(
      screen.getByText(/later years fall back to filing head of household/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/fall back to filing single/i)).not.toBeInTheDocument();
  });

  it('a plan with no standing status still describes the single fallback', async () => {
    renderModal(makeScenario('sc-f52-copy-single'), COUPLE, vi.fn(), 'filing');
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(
      screen.getByText(/later years fall back to filing single/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/every year after a death is filed single/i),
    ).toBeInTheDocument();
  });
});
