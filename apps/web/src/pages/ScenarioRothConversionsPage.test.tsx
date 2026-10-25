// ScenarioRothConversionsPage render, save and guard tests: add/edit/remove, sparse omit, orphan pruning, the Roth-IRA-only target picker, tax burden shown as amount × rate (not deducted), and the unsaved-change guard.
import 'fake-indexeddb/auto';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, Link } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllStores, getAggregate, putAggregate } from '../db/store';
import { expectNoA11yViolations } from '../test/a11y';
import type {
  AccountPayload,
  AccountType,
  AccountTaxTreatment,
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { ScenarioRothConversionsPage } from './ScenarioRothConversionsPage';

const HH = 'hh-test';
const SCENARIO_ID = 'sc-1';

function setupContexts(): void {
  (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    householdId: HH,
    me: { email: 'me@example.test', displayName: 'Me', roles: [], userId: 'u-1' },
    isAuthenticated: true,
  });
  (useSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    notifyPending: vi.fn(),
    state: { kind: 'synced', lastSyncedAt: null },
  });
}

// The jsdom `DisclosurePanel` keeps collapsed content mounted-but-hidden, so role queries return nothing until the row is expanded; call this first for any row internals.
function expandRow(label: string): void {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

function renderAt(scenarioId: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/scenarios/${scenarioId}/roth-conversions`]}>
      <Routes>
        <Route
          path="/scenarios/:id/roth-conversions"
          element={<ScenarioRothConversionsPage />}
        />
        <Route
          path="/scenarios/:id"
          element={<Link to="/scenarios">detail</Link>}
        />
        <Route path="/scenarios" element={<div>scenarios list</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function seedAccount(
  id: string,
  name: string,
  type: AccountType,
  taxTreatment: AccountTaxTreatment,
  active = true,
  ownerId = 'hm-1',
  extra: Partial<AccountPayload> = {},
): Promise<void> {
  const a: Aggregate<AccountPayload> = {
    id,
    householdId: HH,
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name,
      type,
      ownershipType: 'INDIVIDUAL',
      taxTreatment,
      ownerId,
      institution: 'Vanguard',
      notes: '',
      planningReturnPct: 7,
      active,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      ...extra,
    },
  };
  await putAggregate('account', a);
}

// Seed the source-account owner (`hm-1`) so the editor can resolve a retirement date and cap the pickers.
async function seedOwnerMember(birthdate = '1980-06-01'): Promise<void> {
  const m: Aggregate<HouseholdMemberPayload> = {
    id: 'hm-1',
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary: true,
      firstName: 'Owner',
      lastName: 'One',
      email: 'owner@example.test',
      birthdate,
    },
  };
  await putAggregate('householdMember', m);
}

async function seedScenario(
  overrides: ScenarioPayload['overrides'] = {},
  opts: { id?: string; parentScenarioId?: string | null; isPrimary?: boolean } = {},
): Promise<void> {
  const sc: Aggregate<ScenarioPayload> = {
    id: opts.id ?? SCENARIO_ID,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: 'Baseline',
      description: '',
      parentScenarioId: opts.parentScenarioId ?? null,
      isPrimary: opts.isPrimary ?? true,
      notes: '',
      overrides,
    },
  };
  await putAggregate('scenario', sc);
}

// A Roth 401k that the target picker must exclude.
async function seedAccounts(): Promise<void> {
  await seedAccount('acct-pretax', '401(k)', 'RETIREMENT_401K', 'PRE_TAX');
  await seedAccount('acct-roth-ira', 'Roth IRA', 'RETIREMENT_ROTH_IRA', 'ROTH');
  await seedAccount('acct-roth-401k', 'Roth 401(k)', 'RETIREMENT_401K', 'ROTH');
}

describe('ScenarioRothConversionsPage', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders at the route with no conversions; no a11y violations', async () => {
    await seedAccounts();
    await seedScenario();
    renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(screen.getByText(/No conversions yet/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('heading', { name: /Roth conversions while working/i }),
    ).toBeInTheDocument();
  });

  it('renders with a same-account MIXED in-plan conversion seeded (collapsed: name once + In-plan badge, no arrow); no a11y violations', async () => {
    await seedAccount('acct-mixed', 'MIXED 401(k)', 'RETIREMENT_401K', 'MIXED');
    await seedOwnerMember();
    await seedScenario({
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-mixed',
          targetRothAccountId: 'acct-mixed', // same id = in-plan
          annualAmountDollars: 20000,
          start: { kind: 'year', year: 2030 },
          end: { kind: 'year', year: 2034 },
        },
      ],
    });
    const { container } = renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Save/ })).toBeInTheDocument(),
    );
    expect(screen.getByText(/Conversion 1/i)).toBeInTheDocument();
    // Read the trigger's own accessible description: a page-wide text query would also match the collapsed-but-mounted body's Select trigger showing the same account name.
    const trigger = screen.getByRole('button', { name: 'Conversion 1' });
    const describedIds = trigger.getAttribute('aria-describedby')?.split(' ') ?? [];
    const summaryText = describedIds
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(summaryText).toContain('MIXED 401(k)');
    expect(summaryText).toContain('In-plan');
    expect(summaryText.split('MIXED 401(k)')).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: 'Convert starting' }),
    ).toBeNull();

    expandRow('Conversion 1');
    expect(screen.getByText(/Move pre-tax money from/i)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('target picker for a PRE_TAX source lists Roth IRA but excludes designated-Roth employer plans', async () => {
    const user = userEvent.setup();
    await seedAccounts();
    await seedScenario();
    renderAt(SCENARIO_ID);

    const add = await screen.findByRole('button', { name: /Add a conversion/i });
    act(() => {
      fireEvent.click(add);
    });

    const trigger = await screen.findByRole('button', { name: /Into Roth account/i });
    await user.click(trigger);
    const listbox = await screen.findByRole('listbox');
    const labels = within(listbox)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toContain('Roth IRA');
    expect(labels).not.toContain('Roth 401(k)');
  });

  it('target picker does NOT offer a Roth IRA belonging to a different owner', async () => {
    // A Roth IRA belonging to another owner must not appear in the target picker (cross-owner conversions are invalid).
    const user = userEvent.setup();
    await seedAccount('acct-pretax', '401(k)', 'RETIREMENT_401K', 'PRE_TAX', true, 'hm-1');
    await seedAccount('acct-roth-ira-own', 'Roth IRA (mine)', 'RETIREMENT_ROTH_IRA', 'ROTH', true, 'hm-1');
    await seedAccount('acct-roth-ira-spouse', 'Roth IRA (spouse)', 'RETIREMENT_ROTH_IRA', 'ROTH', true, 'hm-2');
    await seedScenario();
    renderAt(SCENARIO_ID);

    const add = await screen.findByRole('button', { name: /Add a conversion/i });
    act(() => {
      fireEvent.click(add);
    });

    const trigger = await screen.findByRole('button', { name: /Into Roth account/i });
    await user.click(trigger);
    const listbox = await screen.findByRole('listbox');
    const labels = within(listbox)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toContain('Roth IRA (mine)');
    expect(labels).not.toContain('Roth IRA (spouse)');
  });

  it('add → Save persists the conversion entry + omits empty rate/basis (sparse)', async () => {
    await seedAccounts();
    await seedScenario();
    renderAt(SCENARIO_ID);

    const add = await screen.findByRole('button', { name: /Add a conversion/i });
    act(() => {
      fireEvent.click(add);
    });

    const save = await screen.findByRole('button', { name: /^Save$/i });
    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(async () => {
      const saved = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      const list = saved?.payload.overrides.preRetirementRothConversions;
      expect(list).toHaveLength(1);
      expect(list?.[0].sourceAccountId).toBe('acct-pretax');
      expect(list?.[0].targetRothAccountId).toBe('acct-roth-ira');
      // A fresh Add seeds $10k/yr over a one-year window at the current year.
      const thisYear = new Date().getFullYear();
      expect(list?.[0].annualAmountDollars).toBe(10000);
      expect(list?.[0].start).toEqual({ kind: 'year', year: thisYear });
      expect(list?.[0].end).toEqual({ kind: 'year', year: thisYear });
      expect(
        saved?.payload.overrides.preRetirementRothConversionTaxRatePct,
      ).toBeUndefined();
    });
  });

  it('persists the assumed rate when set', async () => {
    await seedAccounts();
    await seedScenario();
    renderAt(SCENARIO_ID);

    const add = await screen.findByRole('button', { name: /Add a conversion/i });
    act(() => {
      fireEvent.click(add);
    });

    const rate = screen.getByLabelText(
      /Assumed tax rate on converted money/i,
    ) as HTMLInputElement;
    act(() => {
      fireEvent.focus(rate);
      fireEvent.change(rate, { target: { value: '24' } });
      fireEvent.blur(rate);
    });

    const save = await screen.findByRole('button', { name: /^Save$/i });
    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(async () => {
      const saved = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      expect(
        saved?.payload.overrides.preRetirementRothConversionTaxRatePct,
      ).toBe(24);
    });
  });

  it('shows the per-year tax burden = amount × rate, not deducted', async () => {
    await seedAccounts();
    await seedScenario({
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2030 },
          end: { kind: 'year', year: 2030 },
        },
      ],
      preRetirementRothConversionTaxRatePct: 24,
    });
    renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Conversion 1' })).toBeInTheDocument(),
    );
    // The row is collapsed by default; the tax-burden hint lives in the expanded body, mounted-but-hidden, so assert `.not.toBeVisible()` rather than `.not.toBeInTheDocument()`.
    expect(
      screen.getByText(/Extra income tax this would create/i),
    ).not.toBeVisible();
    expandRow('Conversion 1');

    expect(screen.getByText(/Extra income tax this would create/i)).toBeInTheDocument();
    expect(screen.getByText('$2,400')).toBeInTheDocument();
    // The standalone "not deducted" disclosures were removed once the window pickers became bounded and must not render.
    expect(
      screen.queryByText(/subtracted from your projection/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/the actual tax is your responsibility/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/not taken out of the projection/i),
    ).not.toBeInTheDocument();
  });

  it('caps the "Convert through" year slider at the owner\'s last working year (retirementYear − 1)', async () => {
    await seedAccounts();
    // Owner born 1980-06-01 retiring at 60 retires in 2040, so the last convertible (strictly-before-retirement) year is 2039.
    await seedOwnerMember('1980-06-01');
    await seedScenario({
      retirementAge: { primary: { ageYears: 60, ageMonths: 0 } },
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2030 },
          end: { kind: 'year', year: 2030 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'Conversion 1' });
    expandRow('Conversion 1');
    const card = await screen.findByRole('button', { name: 'Convert through' });
    act(() => {
      fireEvent.click(card);
    });
    const slider = screen.getByRole('slider', { name: 'Convert through year' });
    expect(slider).toHaveAttribute('max', '2039');
  });

  it('an existing window stored beyond the cap still displays its real value (never-clamp guard)', async () => {
    await seedAccounts();
    await seedOwnerMember('1980-06-01');
    await seedScenario({
      retirementAge: { primary: { ageYears: 60, ageMonths: 0 } },
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2030 },
          end: { kind: 'year', year: 2050 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'Conversion 1' });
    expandRow('Conversion 1');
    const card = await screen.findByRole('button', { name: 'Convert through' });
    act(() => {
      fireEvent.click(card);
    });
    const slider = screen.getByRole('slider', { name: 'Convert through year' });
    expect(slider).toHaveAttribute('value', '2050');
    // The never-clamp guard raises the ceiling to the stored value.
    expect(slider).toHaveAttribute('max', '2050');
  });

  it('a backwards window (start year after end year) disables Save + shows an error; fixing it re-enables Save', async () => {
    await seedAccounts();
    await seedOwnerMember('1980-06-01');
    await seedScenario({
      retirementAge: { primary: { ageYears: 60, ageMonths: 0 } },
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2035 },
          end: { kind: 'year', year: 2030 },
        },
      ],
      preRetirementRothConversionTaxRatePct: 22,
    });
    renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(
        screen.getByText(
          /Conversion 1: the end year is before the start year/i,
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();

    expandRow('Conversion 1');
    const startCard = await screen.findByRole('button', {
      name: 'Convert starting',
    });
    act(() => {
      fireEvent.click(startCard);
    });
    const startSlider = screen.getByRole('slider', {
      name: 'Convert starting year',
    });
    act(() => {
      fireEvent.change(startSlider, { target: { value: '2030' } });
    });

    await waitFor(() =>
      expect(
        screen.queryByText(/the end year is before the start year/i),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled();
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });

  it('two same-account rows with overlapping windows disable Save + show an overlap error; moving one window apart re-enables Save', async () => {
    await seedAccounts();
    await seedScenario({
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2030 },
          end: { kind: 'year', year: 2033 },
        },
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 5000,
          start: { kind: 'year', year: 2032 },
          end: { kind: 'year', year: 2034 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(
        screen.getByText(
          /Conversions 1 and 2 convert from the same account in overlapping years/i,
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
    const row1 = screen.getByText('Conversion 1').closest('li') as HTMLElement;
    const row2 = screen.getByText('Conversion 2').closest('li') as HTMLElement;
    expect(within(row1).getByText('Needs attention')).toBeInTheDocument();
    expect(within(row2).getByText('Needs attention')).toBeInTheDocument();

    expandRow('Conversion 2');
    const startCard = within(row2).getByRole('button', { name: 'Convert starting' });
    act(() => {
      fireEvent.click(startCard);
    });
    const startSlider = within(row2).getByRole('slider', {
      name: 'Convert starting year',
    });
    act(() => {
      fireEvent.change(startSlider, { target: { value: '2034' } });
    });

    await waitFor(() =>
      expect(
        screen.queryByText(/convert from the same account in overlapping years/i),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled();
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });

  it('two same-account rows with the same overlapping window re-enable Save after switching one to a different eligible source account', async () => {
    await seedAccount('acct-pretax', 'Pre-tax One', 'RETIREMENT_401K', 'PRE_TAX');
    await seedAccount('acct-pretax-2', 'Pre-tax Two', 'RETIREMENT_403B', 'PRE_TAX');
    await seedAccount('acct-roth-ira', 'Roth IRA', 'RETIREMENT_ROTH_IRA', 'ROTH');
    await seedScenario({
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2031 },
          end: { kind: 'year', year: 2033 },
        },
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 5000,
          start: { kind: 'year', year: 2031 },
          end: { kind: 'year', year: 2033 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(
        screen.getByText(/convert from the same account in overlapping years/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();

    const user = userEvent.setup();
    const row2 = screen.getByText('Conversion 2').closest('li') as HTMLElement;
    expandRow('Conversion 2');
    const sourceTrigger = within(row2).getByRole('button', {
      name: /Move pre-tax money from/i,
    });
    await user.click(sourceTrigger);
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: 'Pre-tax Two' }));

    await waitFor(() =>
      expect(
        screen.queryByText(/convert from the same account in overlapping years/i),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled();
  });

  it('does NOT flag overlap for two rows with the same years but DIFFERENT source accounts', async () => {
    await seedAccount('acct-pretax', 'Pre-tax One', 'RETIREMENT_401K', 'PRE_TAX');
    await seedAccount('acct-pretax-2', 'Pre-tax Two', 'RETIREMENT_403B', 'PRE_TAX');
    await seedAccount('acct-roth-ira', 'Roth IRA', 'RETIREMENT_ROTH_IRA', 'ROTH');
    await seedScenario({
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2031 },
          end: { kind: 'year', year: 2033 },
        },
        {
          sourceAccountId: 'acct-pretax-2',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 5000,
          start: { kind: 'year', year: 2031 },
          end: { kind: 'year', year: 2033 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    const amount = (await screen.findByLabelText(
      /Amount to convert each year for conversion 1/i,
    )) as HTMLInputElement;
    act(() => {
      fireEvent.focus(amount);
      fireEvent.change(amount, { target: { value: '11000' } });
      fireEvent.blur(amount);
    });

    expect(
      screen.queryByText(/convert from the same account in overlapping years/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled();
  });

  it('the row-conflict alert renders between the conversion list and the tax-rate card', async () => {
    // A backwards window guarantees the alert renders; assert its DOM position after the entries list and before the tax-rate card.
    await seedAccounts();
    await seedScenario({
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2035 },
          end: { kind: 'year', year: 2030 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    const alert = await screen.findByText(
      /Conversion 1: the end year is before the start year/i,
    );
    const addButton = screen.getByRole('button', { name: /Add a conversion/i });
    const taxRateLabel = screen.getByText(/Assumed tax rate on converted money/i);

    expect(
      addButton.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      alert.compareDocumentPosition(taxRateLabel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('remove → Save drops the list entirely (sparse omit, key deleted)', async () => {
    await seedAccounts();
    await seedScenario({
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 5000,
          start: { kind: 'year', year: 2030 },
          end: { kind: 'year', year: 2030 },
        },
      ],
      preRetirementRothConversionTaxRatePct: 22,
    });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'Conversion 1' });
    expandRow('Conversion 1');
    const remove = await screen.findByRole('button', {
      name: /Remove conversion 1/i,
    });
    act(() => {
      fireEvent.click(remove);
    });

    const save = await screen.findByRole('button', { name: /^Save$/i });
    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(async () => {
      const saved = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      expect(
        saved?.payload.overrides.preRetirementRothConversions,
      ).toBeUndefined();
    });
  });

  it('edit an existing row (amount + target) → Save persists the edit', async () => {
    const user = userEvent.setup();
    await seedAccount('acct-pretax', '401(k)', 'RETIREMENT_401K', 'PRE_TAX');
    await seedAccount('acct-roth-ira', 'Roth IRA', 'RETIREMENT_ROTH_IRA', 'ROTH');
    await seedAccount('acct-roth-ira-2', 'Roth IRA #2', 'RETIREMENT_ROTH_IRA', 'ROTH');
    await seedScenario({
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 5000,
          start: { kind: 'year', year: 2030 },
          end: { kind: 'year', year: 2030 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'Conversion 1' });
    expandRow('Conversion 1');

    const amount = (await screen.findByLabelText(
      /Amount to convert each year for conversion 1/i,
    )) as HTMLInputElement;
    act(() => {
      fireEvent.focus(amount);
      fireEvent.change(amount, { target: { value: '12000' } });
      fireEvent.blur(amount);
    });

    const targetTrigger = screen.getByRole('button', { name: /Into Roth account/i });
    await user.click(targetTrigger);
    const option = await screen.findByRole('option', { name: 'Roth IRA #2' });
    await user.click(option);

    const save = await screen.findByRole('button', { name: /^Save$/i });
    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(async () => {
      const saved = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      const list = saved?.payload.overrides.preRetirementRothConversions;
      expect(list).toHaveLength(1);
      expect(list?.[0].annualAmountDollars).toBe(12000);
      expect(list?.[0].targetRothAccountId).toBe('acct-roth-ira-2');
      expect(list?.[0]).not.toHaveProperty('draftId');
    });
  });

  it('a child inheriting a parent conversion list shows the inherited banner naming the ancestor', async () => {
    await seedAccounts();
    // The banner names the nearest ancestor that sets the key (the grandparent), not the immediate parent.
    await seedScenario(
      {
        preRetirementRothConversions: [
          {
            sourceAccountId: 'acct-pretax',
            targetRothAccountId: 'acct-roth-ira',
            annualAmountDollars: 5000,
            start: { kind: 'year', year: 2030 },
            end: { kind: 'year', year: 2030 },
          },
        ],
      },
      { id: 'gp', isPrimary: true },
    );
    await seedScenario({}, { id: 'parent', parentScenarioId: 'gp', isPrimary: false });
    await seedScenario({}, { id: 'child', parentScenarioId: 'parent', isPrimary: false });
    renderAt('child');

    await waitFor(() =>
      expect(
        screen.getByText(/These conversions are inherited from Baseline/i),
      ).toBeInTheDocument(),
    );
  });

  it('a child that locally overrides the list shows NO inherited banner', async () => {
    await seedAccounts();
    await seedScenario(
      {
        preRetirementRothConversions: [
          {
            sourceAccountId: 'acct-pretax',
            targetRothAccountId: 'acct-roth-ira',
            annualAmountDollars: 5000,
            start: { kind: 'year', year: 2030 },
            end: { kind: 'year', year: 2030 },
          },
        ],
      },
      { id: 'gp', isPrimary: true },
    );
    await seedScenario(
      {
        preRetirementRothConversions: [
          {
            sourceAccountId: 'acct-pretax',
            targetRothAccountId: 'acct-roth-ira',
            annualAmountDollars: 9000,
            start: { kind: 'year', year: 2031 },
            end: { kind: 'year', year: 2031 },
          },
        ],
      },
      { id: 'child', parentScenarioId: 'gp', isPrimary: false },
    );
    renderAt('child');

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Conversion 1' }),
      ).toBeInTheDocument(),
    );
    expandRow('Conversion 1');
    expect(
      screen.getByRole('button', { name: /Remove conversion 1/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/These conversions are inherited from/i),
    ).not.toBeInTheDocument();
  });

  it('an in-app nav while dirty surfaces the Stay/Leave prompt (Stay blocks, Leave proceeds)', async () => {
    const user = userEvent.setup();
    await seedAccounts();
    await seedScenario();
    renderAt(SCENARIO_ID);

    const add = await screen.findByRole('button', { name: /Add a conversion/i });
    act(() => {
      fireEvent.click(add); // make the editor dirty
    });

    // MemoryRouter doesn't call window.history, so drive a cross-pathname pushState directly, as a real Link click under browser history does; the guard's patch intercepts it while dirty.
    act(() => {
      window.history.pushState({}, '', `/scenarios/${SCENARIO_ID}`);
    });

    const stay = await screen.findByRole('button', { name: /^Stay$/i });
    await user.click(stay);
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Add a conversion/i }),
    ).toBeInTheDocument();

    act(() => {
      window.history.pushState({}, '', `/scenarios/${SCENARIO_ID}`);
    });
    const leave = await screen.findByRole('button', { name: /^Leave$/i });
    await user.click(leave);
    await waitFor(() =>
      expect(screen.getByText('detail')).toBeInTheDocument(),
    );

    const saved = (await getAggregate('scenario', SCENARIO_ID)) as
      | Aggregate<ScenarioPayload>
      | null;
    expect(
      saved?.payload.overrides.preRetirementRothConversions,
    ).toBeUndefined();
  });

  it('prunes an orphan entry (dangling source/target id) at save', async () => {
    await seedAccounts();
    await seedScenario({
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 5000,
          start: { kind: 'year', year: 2030 },
          end: { kind: 'year', year: 2030 },
        },
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-deleted',
          annualAmountDollars: 3000,
          start: { kind: 'year', year: 2031 },
          end: { kind: 'year', year: 2031 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    const rate = (await screen.findByLabelText(
      /Assumed tax rate on converted money/i,
    )) as HTMLInputElement;
    act(() => {
      fireEvent.focus(rate);
      fireEvent.change(rate, { target: { value: '20' } });
      fireEvent.blur(rate);
    });
    const save = await screen.findByRole('button', { name: /^Save$/i });
    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(async () => {
      const saved = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      const list = saved?.payload.overrides.preRetirementRothConversions;
      expect(list).toHaveLength(1);
      expect(list?.[0].targetRothAccountId).toBe('acct-roth-ira');
    });
  });

  it('registers a beforeunload guard while the editor is dirty', async () => {
    await seedAccounts();
    await seedScenario();
    const addSpy = vi.spyOn(window, 'addEventListener');
    renderAt(SCENARIO_ID);

    const add = await screen.findByRole('button', { name: /Add a conversion/i });
    act(() => {
      fireEvent.click(add);
    });

    await waitFor(() =>
      expect(
        addSpy.mock.calls.some((c) => c[0] === 'beforeunload'),
      ).toBe(true),
    );
    addSpy.mockRestore();
  });

  it('Cancel discards via navigateUnguarded — no Stay/Leave prompt, no save', async () => {
    await seedAccounts();
    await seedScenario();
    renderAt(SCENARIO_ID);

    const add = await screen.findByRole('button', { name: /Add a conversion/i });
    act(() => {
      fireEvent.click(add); // make the editor dirty
    });

    const cancel = screen.getByRole('button', { name: /^Cancel$/i });
    act(() => {
      fireEvent.click(cancel);
    });

    expect(screen.queryByText(/Unsaved changes/i)).not.toBeInTheDocument();
    const saved = (await getAggregate('scenario', SCENARIO_ID)) as
      | Aggregate<ScenarioPayload>
      | null;
    expect(
      saved?.payload.overrides.preRetirementRothConversions,
    ).toBeUndefined();
  });

  it('a seeded row renders collapsed with its plain-English summary + $X/yr amount; a body control is absent by role', async () => {
    await seedAccounts();
    await seedScenario({
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 5000,
          start: { kind: 'year', year: 2030 },
          end: { kind: 'year', year: 2034 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Conversion 1' })).toBeInTheDocument(),
    );
    const trigger = screen.getByRole('button', { name: 'Conversion 1' });
    const describedIds = trigger.getAttribute('aria-describedby')?.split(' ') ?? [];
    const summaryText = describedIds
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(summaryText).toContain('401(k)');
    expect(summaryText).toContain('Roth IRA');
    expect(summaryText).toContain('Year 2030');
    expect(summaryText).toContain('year 2034');
    expect(summaryText).toContain('$5,000/yr');
    // Load-bearing collapse guard: the body's Select controls are absent by role until the row expands (this must fail if the disclosure never collapses).
    expect(
      screen.queryByRole('button', { name: /Into Roth account/i }),
    ).toBeNull();
  });

  it('only one row is open at a time; Add opens the new row expanded and collapses the previously-open sibling', async () => {
    await seedAccounts();
    await seedScenario({
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 1000,
          start: { kind: 'year', year: 2030 },
          end: { kind: 'year', year: 2030 },
        },
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 2000,
          start: { kind: 'year', year: 2031 },
          end: { kind: 'year', year: 2031 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'Conversion 1' });
    expandRow('Conversion 1');
    expect(
      screen.getByRole('button', { name: /Remove conversion 1/i }),
    ).toBeInTheDocument();

    expandRow('Conversion 2');
    expect(
      screen.getByRole('button', { name: /Remove conversion 2/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Remove conversion 1/i }),
    ).toBeNull();

    const add = screen.getByRole('button', { name: /Add a conversion/i });
    act(() => {
      fireEvent.click(add);
    });
    expect(
      screen.getByRole('button', { name: /Remove conversion 3/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Remove conversion 2/i }),
    ).toBeNull();
  });

  it("re-clicking the open row's own trigger collapses it (toggle-to-close)", async () => {
    await seedAccounts();
    await seedScenario({
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 5000,
          start: { kind: 'year', year: 2030 },
          end: { kind: 'year', year: 2030 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'Conversion 1' });
    expandRow('Conversion 1');
    expect(
      screen.getByRole('button', { name: /Remove conversion 1/i }),
    ).toBeInTheDocument();

    expandRow('Conversion 1');
    expect(
      screen.queryByRole('button', { name: /Remove conversion 1/i }),
    ).toBeNull();
  });

  it('removing the row ABOVE the open one keeps the originally-open row expanded (draftId-keyed, not index-keyed)', async () => {
    await seedAccounts();
    await seedScenario({
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 1000,
          start: { kind: 'year', year: 2030 },
          end: { kind: 'year', year: 2030 },
        },
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 2000,
          start: { kind: 'year', year: 2031 },
          end: { kind: 'year', year: 2031 },
        },
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 3000,
          start: { kind: 'year', year: 2032 },
          end: { kind: 'year', year: 2032 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'Conversion 2' });
    expandRow('Conversion 2');
    expect(
      screen.getByRole('button', { name: /Remove conversion 2/i }),
    ).toBeInTheDocument();

    // The row is mounted-but-visually-collapsed (RAC's `hidden="until-found"` DisclosurePanel), so reach its Remove button with `hidden: true`.
    const removeRow1 = screen.getByRole('button', {
      name: /Remove conversion 1/i,
      hidden: true,
    });
    act(() => {
      fireEvent.click(removeRow1);
    });

    // The originally-open row must stay expanded, relabeled "Conversion 1", not a wrong row that an index-keyed (rather than draftId-keyed) open state would leave open.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Remove conversion 1/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('$2,000/yr')).toBeInTheDocument();
  });

  it('the "Needs attention" chip appears only on the implicated collapsed row in a 3-row case, and clears once fixed', async () => {
    await seedAccounts();
    await seedOwnerMember('1980-06-01');
    await seedScenario({
      retirementAge: { primary: { ageYears: 60, ageMonths: 0 } },
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 1000,
          start: { kind: 'year', year: 2030 },
          end: { kind: 'year', year: 2030 },
        },
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 2000,
          start: { kind: 'year', year: 2035 },
          end: { kind: 'year', year: 2031 },
        },
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 3000,
          start: { kind: 'year', year: 2032 },
          end: { kind: 'year', year: 2032 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(
        screen.getByText(/Conversion 2: the end year is before the start year/i),
      ).toBeInTheDocument(),
    );

    const row1 = screen.getByRole('button', { name: 'Conversion 1' }).closest('li') as HTMLElement;
    const row2 = screen.getByRole('button', { name: 'Conversion 2' }).closest('li') as HTMLElement;
    const row3 = screen.getByRole('button', { name: 'Conversion 3' }).closest('li') as HTMLElement;
    expect(within(row1).queryByText('Needs attention')).toBeNull();
    expect(within(row2).getByText('Needs attention')).toBeInTheDocument();
    expect(within(row3).queryByText('Needs attention')).toBeNull();

    expandRow('Conversion 2');
    const startCard = within(row2).getByRole('button', { name: 'Convert starting' });
    act(() => {
      fireEvent.click(startCard);
    });
    const startSlider = within(row2).getByRole('slider', {
      name: 'Convert starting year',
    });
    act(() => {
      fireEvent.change(startSlider, { target: { value: '2031' } });
    });

    await waitFor(() =>
      expect(within(row2).queryByText('Needs attention')).toBeNull(),
    );
  });

  it('a saved conversion whose target became ineligible (inherited Roth IRA) names the real account, carries the chip, and announces the removal-on-save; an eligible row stays clean', async () => {
    await seedAccount('acct-pretax', '401(k)', 'RETIREMENT_401K', 'PRE_TAX');
    // The saved target was eligible once; the account was then marked inherited, so `isWorkingYearsRothConversionTarget` rejects it and it is absent from the target picker while still on the Accounts page.
    await seedAccount(
      'acct-roth-inh',
      'Inherited Roth IRA',
      'RETIREMENT_ROTH_IRA',
      'ROTH',
      true,
      'hm-1',
      { rmdInheritedAccount: true },
    );
    await seedAccount('acct-roth-ira', 'Roth IRA', 'RETIREMENT_ROTH_IRA', 'ROTH');
    await seedScenario({
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-inh',
          annualAmountDollars: 5000,
          start: { kind: 'year', year: 2030 },
          end: { kind: 'year', year: 2030 },
        },
        {
          // A healthy sibling row must not pick up the chip or the notice.
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 4000,
          start: { kind: 'year', year: 2031 },
          end: { kind: 'year', year: 2031 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'Conversion 1' });
    // The collapsed summary shows the real account name ("Missing account" would be false, the account is on the Accounts page) plus the chip.
    const trigger = screen.getByRole('button', { name: 'Conversion 1' });
    const describedIds = trigger.getAttribute('aria-describedby')?.split(' ') ?? [];
    const summaryText = describedIds
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(summaryText).toContain('Inherited Roth IRA');
    expect(summaryText).not.toContain('Missing account');
    const row1 = trigger.closest('li') as HTMLElement;
    const row2 = screen
      .getByRole('button', { name: 'Conversion 2' })
      .closest('li') as HTMLElement;
    expect(within(row1).getByText('Needs attention')).toBeInTheDocument();
    expect(within(row2).queryByText('Needs attention')).toBeNull();

    // The notice announces that the row will be removed at the next Save; Save itself stays usable for other edits.
    expandRow('Conversion 1');
    expect(
      within(row1).getByText(/can no longer receive conversions/i),
    ).toBeInTheDocument();
    expect(within(row1).getByText(/removed when you save/i)).toBeInTheDocument();
    expect(within(row2).queryByText(/can no longer receive conversions/i)).toBeNull();
  });

  it('after a successful Save, every row renders collapsed', async () => {
    await seedAccounts();
    await seedScenario({
      preRetirementRothConversions: [
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 5000,
          start: { kind: 'year', year: 2030 },
          end: { kind: 'year', year: 2030 },
        },
        {
          sourceAccountId: 'acct-pretax',
          targetRothAccountId: 'acct-roth-ira',
          annualAmountDollars: 6000,
          start: { kind: 'year', year: 2031 },
          end: { kind: 'year', year: 2031 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'Conversion 1' });
    expandRow('Conversion 1');
    const amount = (await screen.findByLabelText(
      /Amount to convert each year for conversion 1/i,
    )) as HTMLInputElement;
    act(() => {
      fireEvent.focus(amount);
      fireEvent.change(amount, { target: { value: '9000' } });
      fireEvent.blur(amount);
    });

    const save = await screen.findByRole('button', { name: /^Save$/i });
    await act(async () => {
      fireEvent.click(save);
    });

    // After save the host page remounts the editor keyed on scenario.version, so every row renders collapsed.
    await waitFor(async () => {
      const saved = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      expect(saved?.version).toBe(2);
    });
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /Remove conversion 1/i }),
      ).toBeNull(),
    );
    expect(
      screen.queryByRole('button', { name: /Remove conversion 2/i }),
    ).toBeNull();
  });
});
