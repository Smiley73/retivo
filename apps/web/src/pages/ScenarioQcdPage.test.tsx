// ScenarioQcdPage render, save and guard tests: add/edit/remove, sparse omit, orphan pruning, the eligible-source picker, the inherited banner, the unsaved-change guard and Cancel.
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
import { ScenarioQcdPage } from './ScenarioQcdPage';

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
    <MemoryRouter initialEntries={[`/scenarios/${scenarioId}/qcd`]}>
      <Routes>
        <Route path="/scenarios/:id/qcd" element={<ScenarioQcdPage />} />
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
    },
  };
  await putAggregate('account', a);
}

async function seedMember(
  id = 'hm-1',
  birthdate = '1950-01-15',
  opts: { isPrimary?: boolean; firstName?: string; lastName?: string } = {},
): Promise<void> {
  const m: Aggregate<HouseholdMemberPayload> = {
    id,
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary: opts.isPrimary ?? true,
      firstName: opts.firstName ?? 'Pat',
      lastName: opts.lastName ?? 'Giver',
      email: `${id}@example.test`,
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

async function seedAccounts(): Promise<void> {
  await seedAccount('acct-ira', 'Traditional IRA', 'RETIREMENT_IRA', 'PRE_TAX');
  await seedAccount('acct-roth-ira', 'Roth IRA', 'RETIREMENT_ROTH_IRA', 'ROTH');
  await seedAccount('acct-401k', '401(k)', 'RETIREMENT_401K', 'PRE_TAX');
}

const QCD_ENTRY = {
  memberId: 'hm-1',
  sourceAccountId: 'acct-ira',
  annualAmountDollars: 10000,
  start: { kind: 'year' as const, year: 2026 },
  end: { kind: 'year' as const, year: 2026 },
};

describe('ScenarioQcdPage', () => {
  beforeEach(() => {
    setupContexts();
  });

  afterEach(async () => {
    await clearAllStores();
    vi.clearAllMocks();
  });

  it('renders at the route with no QCDs; no a11y violations', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario();
    renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(screen.getByText(/No QCDs yet/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: /Charitable distributions \(QCDs\)/i,
      }),
    ).toBeInTheDocument();
  });

  it('renders with a seeded QCD entry (collapsed summary, no amount) + the double-counting warning; no a11y violations', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario({ qualifiedCharitableDistributions: [QCD_ENTRY] });
    const { container } = renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Save$/ })).toBeInTheDocument(),
    );
    expect(screen.getByText(/QCD 1/i)).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'QCD 1' });
    const describedIds = trigger.getAttribute('aria-describedby')?.split(' ') ?? [];
    const summaryText = describedIds
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(summaryText).toContain('Pat Giver');
    expect(summaryText).toContain('gives from');
    expect(summaryText).toContain('Traditional IRA');
    expect(summaryText).not.toContain('$');
    expect(
      screen.getByText(/separate from any charitable giving you model as an expense/i),
    ).toBeInTheDocument();
    // Load-bearing collapse guard: a body control is absent by role.
    expect(screen.queryByRole('button', { name: /Who is giving/i })).toBeNull();

    expandRow('QCD 1');
    expect(screen.getByText(/Who is giving/i)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('source picker lists only the giver\'s eligible traditional IRA (excludes Roth IRA + 401k)', async () => {
    const user = userEvent.setup();
    await seedAccounts();
    await seedMember();
    await seedScenario();
    renderAt(SCENARIO_ID);

    const add = await screen.findByRole('button', { name: /Add a QCD/i });
    act(() => {
      fireEvent.click(add);
    });

    const trigger = await screen.findByRole('button', {
      name: /Give from this traditional IRA/i,
    });
    await user.click(trigger);
    const listbox = await screen.findByRole('listbox');
    const labels = within(listbox)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toContain('Traditional IRA');
    expect(labels).not.toContain('Roth IRA');
    expect(labels).not.toContain('401(k)');
  });

  it('member picker does NOT offer a member with no eligible IRA', async () => {
    const user = userEvent.setup();
    await seedAccount('acct-ira', 'Traditional IRA', 'RETIREMENT_IRA', 'PRE_TAX', true, 'hm-1');
    await seedAccount('acct-roth-spouse', 'Spouse Roth IRA', 'RETIREMENT_ROTH_IRA', 'ROTH', true, 'hm-2');
    await seedMember('hm-1', '1950-01-15', { isPrimary: true, firstName: 'Pat' });
    await seedMember('hm-2', '1951-01-15', { isPrimary: false, firstName: 'Sam' });
    await seedScenario();
    renderAt(SCENARIO_ID);

    const add = await screen.findByRole('button', { name: /Add a QCD/i });
    act(() => {
      fireEvent.click(add);
    });

    const trigger = await screen.findByRole('button', { name: /Who is giving/i });
    await user.click(trigger);
    const listbox = await screen.findByRole('listbox');
    const labels = within(listbox)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toContain('Pat Giver');
    expect(labels).not.toContain('Sam Giver');
  });

  it('add → Save persists the QCD entry (sparse)', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario();
    renderAt(SCENARIO_ID);

    const add = await screen.findByRole('button', { name: /Add a QCD/i });
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
      const list = saved?.payload.overrides.qualifiedCharitableDistributions;
      expect(list).toHaveLength(1);
      expect(list?.[0].sourceAccountId).toBe('acct-ira');
      expect(list?.[0].memberId).toBe('hm-1');
      expect(list?.[0]).not.toHaveProperty('draftId');
    });
  });

  it('edit an existing row amount → Save persists the edit', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario({ qualifiedCharitableDistributions: [QCD_ENTRY] });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'QCD 1' });
    expandRow('QCD 1');
    const amount = (await screen.findByLabelText(
      /Amount to give each year for QCD 1/i,
    )) as HTMLInputElement;
    act(() => {
      fireEvent.focus(amount);
      fireEvent.change(amount, { target: { value: '15000' } });
      fireEvent.blur(amount);
    });

    const save = await screen.findByRole('button', { name: /^Save$/i });
    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(async () => {
      const saved = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      const list = saved?.payload.overrides.qualifiedCharitableDistributions;
      expect(list).toHaveLength(1);
      expect(list?.[0].annualAmountDollars).toBe(15000);
    });
  });

  it('remove → Save drops the list entirely (sparse omit, key deleted)', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario({ qualifiedCharitableDistributions: [QCD_ENTRY] });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'QCD 1' });
    expandRow('QCD 1');
    const remove = await screen.findByRole('button', {
      name: /Remove QCD 1/i,
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
        saved?.payload.overrides.qualifiedCharitableDistributions,
      ).toBeUndefined();
    });
  });

  it('prunes an orphan entry (non-IRA source) at save', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario({
      qualifiedCharitableDistributions: [
        QCD_ENTRY,
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-401k',
          annualAmountDollars: 3000,
          start: { kind: 'year', year: 2026 },
          end: { kind: 'year', year: 2027 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'QCD 1' });
    expandRow('QCD 1');
    const amount = (await screen.findByLabelText(
      /Amount to give each year for QCD 1/i,
    )) as HTMLInputElement;
    act(() => {
      fireEvent.focus(amount);
      fireEvent.change(amount, { target: { value: '12000' } });
      fireEvent.blur(amount);
    });
    const save = await screen.findByRole('button', { name: /^Save$/i });
    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(async () => {
      const saved = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      const list = saved?.payload.overrides.qualifiedCharitableDistributions;
      expect(list).toHaveLength(1);
      expect(list?.[0].sourceAccountId).toBe('acct-ira');
    });
  });

  it('prunes an orphan entry (inactive eligible IRA source) at save', async () => {
    // An inactive IRA of an eligible type must be excluded from the editor and pruned on save.
    await seedAccount('acct-ira', 'Traditional IRA', 'RETIREMENT_IRA', 'PRE_TAX');
    await seedAccount(
      'acct-ira-closed',
      'Closed IRA',
      'RETIREMENT_IRA',
      'PRE_TAX',
      false,
    );
    await seedMember();
    await seedScenario({
      qualifiedCharitableDistributions: [
        QCD_ENTRY,
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira-closed',
          annualAmountDollars: 4000,
          start: { kind: 'year', year: 2026 },
          end: { kind: 'year', year: 2027 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'QCD 1' });
    expandRow('QCD 1');
    const amount = (await screen.findByLabelText(
      /Amount to give each year for QCD 1/i,
    )) as HTMLInputElement;
    act(() => {
      fireEvent.focus(amount);
      fireEvent.change(amount, { target: { value: '12000' } });
      fireEvent.blur(amount);
    });
    const save = await screen.findByRole('button', { name: /^Save$/i });
    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(async () => {
      const saved = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      const list = saved?.payload.overrides.qualifiedCharitableDistributions;
      expect(list).toHaveLength(1);
      expect(list?.[0].sourceAccountId).toBe('acct-ira');
    });
  });

  it('a child inheriting a parent QCD list shows the inherited banner naming the ancestor', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario(
      { qualifiedCharitableDistributions: [QCD_ENTRY] },
      { id: 'gp', isPrimary: true },
    );
    await seedScenario({}, { id: 'parent', parentScenarioId: 'gp', isPrimary: false });
    await seedScenario({}, { id: 'child', parentScenarioId: 'parent', isPrimary: false });
    renderAt('child');

    await waitFor(() =>
      expect(
        screen.getByText(/These QCDs are inherited from Baseline/i),
      ).toBeInTheDocument(),
    );
  });

  it('a child that locally overrides the list shows NO inherited banner', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario(
      { qualifiedCharitableDistributions: [QCD_ENTRY] },
      { id: 'gp', isPrimary: true },
    );
    await seedScenario(
      {
        qualifiedCharitableDistributions: [
          { ...QCD_ENTRY, annualAmountDollars: 9000 },
        ],
      },
      { id: 'child', parentScenarioId: 'gp', isPrimary: false },
    );
    renderAt('child');

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'QCD 1' }),
      ).toBeInTheDocument(),
    );
    expandRow('QCD 1');
    expect(
      screen.getByRole('button', { name: /Remove QCD 1/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/These QCDs are inherited from/i),
    ).not.toBeInTheDocument();
  });

  it('an in-app nav while dirty surfaces the Stay/Leave prompt (Stay blocks, Leave proceeds)', async () => {
    const user = userEvent.setup();
    await seedAccounts();
    await seedMember();
    await seedScenario();
    renderAt(SCENARIO_ID);

    const add = await screen.findByRole('button', { name: /Add a QCD/i });
    act(() => {
      fireEvent.click(add); // make the editor dirty
    });

    act(() => {
      window.history.pushState({}, '', `/scenarios/${SCENARIO_ID}`);
    });

    const stay = await screen.findByRole('button', { name: /^Stay$/i });
    await user.click(stay);
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Add a QCD/i }),
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
      saved?.payload.overrides.qualifiedCharitableDistributions,
    ).toBeUndefined();
  });

  it('registers a beforeunload guard while the editor is dirty', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario();
    const addSpy = vi.spyOn(window, 'addEventListener');
    renderAt(SCENARIO_ID);

    const add = await screen.findByRole('button', { name: /Add a QCD/i });
    act(() => {
      fireEvent.click(add);
    });

    await waitFor(() =>
      expect(addSpy.mock.calls.some((c) => c[0] === 'beforeunload')).toBe(true),
    );
    addSpy.mockRestore();
  });

  it('Cancel discards via navigateUnguarded — no Stay/Leave prompt, no save', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario();
    renderAt(SCENARIO_ID);

    const add = await screen.findByRole('button', { name: /Add a QCD/i });
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
      saved?.payload.overrides.qualifiedCharitableDistributions,
    ).toBeUndefined();
  });

  it('switching the giver re-points the source to the new member\'s eligible IRA; Save persists it', async () => {
    const user = userEvent.setup();
    await seedAccount('acct-ira-a', 'Pat IRA', 'RETIREMENT_IRA', 'PRE_TAX', true, 'hm-1');
    await seedAccount('acct-ira-b', 'Sam IRA', 'RETIREMENT_IRA', 'PRE_TAX', true, 'hm-2');
    await seedMember('hm-1', '1950-01-15', { isPrimary: true, firstName: 'Pat' });
    await seedMember('hm-2', '1951-01-15', { isPrimary: false, firstName: 'Sam' });
    await seedScenario({
      qualifiedCharitableDistributions: [
        { ...QCD_ENTRY, memberId: 'hm-1', sourceAccountId: 'acct-ira-a' },
      ],
    });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'QCD 1' });
    expandRow('QCD 1');
    const memberTrigger = await screen.findByRole('button', {
      name: /Who is giving/i,
    });
    await user.click(memberTrigger);
    const memberListbox = await screen.findByRole('listbox');
    await user.click(within(memberListbox).getByRole('option', { name: 'Sam Giver' }));

    const save = await screen.findByRole('button', { name: /^Save$/i });
    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(async () => {
      const saved = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      const list = saved?.payload.overrides.qualifiedCharitableDistributions;
      expect(list).toHaveLength(1);
      expect(list?.[0].memberId).toBe('hm-2');
      expect(list?.[0].sourceAccountId).toBe('acct-ira-b');
    });
  });

  it('age anchor never offers a member selector and stays the giver (secondary) in a two-member household', async () => {
    // Both members own eligible IRAs with different birthdays and the giver is hm-2. The engine resolves the QCD window from the giver's birthdate, ignoring the anchor's member, so the age picker must not show a member selector and the persisted anchor member must be the giver's role ('secondary').
    await seedAccount('acct-ira-a', 'Pat IRA', 'RETIREMENT_IRA', 'PRE_TAX', true, 'hm-1');
    await seedAccount('acct-ira-b', 'Sam IRA', 'RETIREMENT_IRA', 'PRE_TAX', true, 'hm-2');
    await seedMember('hm-1', '1950-03-15', { isPrimary: true, firstName: 'Pat' });
    await seedMember('hm-2', '1948-09-20', { isPrimary: false, firstName: 'Sam' });
    await seedScenario({
      qualifiedCharitableDistributions: [
        {
          memberId: 'hm-2',
          sourceAccountId: 'acct-ira-b',
          annualAmountDollars: 10000,
          // A non-giver member stored on the anchors must be normalised back to the giver on save.
          start: { kind: 'age', memberId: 'primary', years: 72, months: 0 },
          end: { kind: 'age', memberId: 'primary', years: 80, months: 0 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Save$/ })).toBeInTheDocument(),
    );

    expect(
      screen.queryByLabelText(/Give starting age member/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/Give through age member/i),
    ).not.toBeInTheDocument();

    const amount = (await screen.findByLabelText(
      /Amount to give each year for QCD 1/i,
    )) as HTMLInputElement;
    act(() => {
      fireEvent.focus(amount);
      fireEvent.change(amount, { target: { value: '11000' } });
      fireEvent.blur(amount);
    });
    const save = await screen.findByRole('button', { name: /^Save$/i });
    await act(async () => {
      fireEvent.click(save);
    });

    await waitFor(async () => {
      const saved = (await getAggregate('scenario', SCENARIO_ID)) as
        | Aggregate<ScenarioPayload>
        | null;
      const list = saved?.payload.overrides.qualifiedCharitableDistributions;
      expect(list).toHaveLength(1);
      expect(list?.[0].memberId).toBe('hm-2');
      const start = list?.[0].start;
      const end = list?.[0].end;
      expect(start).toEqual({ kind: 'age', memberId: 'secondary', years: 72, months: 0 });
      expect(end).toEqual({ kind: 'age', memberId: 'secondary', years: 80, months: 0 });
    });
  });

  it('switching a window picker from year to age seeds an age >= 70 (floor-aware)', async () => {
    // The window pickers carry floor={age:70}: switching a picker from year to age must seed the anchor at the 70½ floor (70), not the bare 65 default, or the never-clamp slider guard would surface a sub-70 window the editor's own floor forbids.
    await seedAccount('acct-ira', 'Traditional IRA', 'RETIREMENT_IRA', 'PRE_TAX', true, 'hm-1');
    await seedMember('hm-1', '1960-01-15', { isPrimary: true, firstName: 'Pat' });
    await seedScenario({
      qualifiedCharitableDistributions: [
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2040 },
          end: { kind: 'year', year: 2040 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Save$/ })).toBeInTheDocument(),
    );
    expandRow('QCD 1');

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Give starting' }));
    });
    act(() => {
      fireEvent.click(screen.getByRole('radio', { name: 'At age' }));
    });

    const slider = screen.getByRole('slider', {
      name: 'Give starting age years',
    }) as HTMLInputElement;
    expect(Number(slider.value)).toBeGreaterThanOrEqual(70);
    expect(Number(slider.getAttribute('min'))).toBeGreaterThanOrEqual(70);
  });

  it("resolves the window validation against the GIVER's birthdate, not a stored non-giver anchor member", async () => {
    // Resolving against the wrong member flips the backwards-window outcome: the giver is hm-2 (born 1948, start 80, so 2028 ≤ 2030, valid) but the stored `age` anchor wrongly carries 'primary' (born 1955, so 2035 > 2030, backwards). The validation normalises the anchor to the giver first.
    await seedAccount('acct-ira-a', 'Pat IRA', 'RETIREMENT_IRA', 'PRE_TAX', true, 'hm-1');
    await seedAccount('acct-ira-b', 'Sam IRA', 'RETIREMENT_IRA', 'PRE_TAX', true, 'hm-2');
    await seedMember('hm-1', '1955-01-15', { isPrimary: true, firstName: 'Pat' });
    await seedMember('hm-2', '1948-09-20', { isPrimary: false, firstName: 'Sam' });
    await seedScenario({
      qualifiedCharitableDistributions: [
        {
          memberId: 'hm-2',
          sourceAccountId: 'acct-ira-b',
          annualAmountDollars: 10000,
          start: { kind: 'age', memberId: 'primary', years: 80, months: 0 },
          end: { kind: 'year', year: 2030 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    const amount = (await screen.findByLabelText(
      /Amount to give each year for QCD 1/i,
    )) as HTMLInputElement;
    act(() => {
      fireEvent.focus(amount);
      fireEvent.change(amount, { target: { value: '11000' } });
      fireEvent.blur(amount);
    });

    expect(
      screen.queryByText(/the end year is before the start year/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled();
  });

  it('shows the "Add their birthdate" hint when the giver has no birthdate', async () => {
    await seedAccounts();
    await seedMember('hm-1', '', { isPrimary: true, firstName: 'Pat' });
    await seedScenario();
    renderAt(SCENARIO_ID);

    const add = await screen.findByRole('button', { name: /Add a QCD/i });
    act(() => {
      fireEvent.click(add);
    });

    await waitFor(() =>
      expect(
        screen.getByText(/Add their birthdate on the Household page/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/the year this person turns 70½ — the first year a QCD is allowed/i),
    ).not.toBeInTheDocument();
  });

  it('excludes an inactive traditional IRA from the source picker', async () => {
    const user = userEvent.setup();
    await seedAccount('acct-ira', 'Active IRA', 'RETIREMENT_IRA', 'PRE_TAX', true, 'hm-1');
    await seedAccount('acct-ira-closed', 'Closed IRA', 'RETIREMENT_IRA', 'PRE_TAX', false, 'hm-1');
    await seedMember('hm-1', '1950-01-15', { isPrimary: true, firstName: 'Pat' });
    await seedScenario();
    renderAt(SCENARIO_ID);

    const add = await screen.findByRole('button', { name: /Add a QCD/i });
    act(() => {
      fireEvent.click(add);
    });

    const trigger = await screen.findByRole('button', {
      name: /Give from this traditional IRA/i,
    });
    await user.click(trigger);
    const listbox = await screen.findByRole('listbox');
    const labels = within(listbox)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toContain('Active IRA');
    expect(labels).not.toContain('Closed IRA');
  });

  it('a member whose only traditional IRA is inactive is not offered as a giver', async () => {
    await seedAccount('acct-ira-inactive', 'Closed IRA', 'RETIREMENT_IRA', 'PRE_TAX', false, 'hm-1');
    await seedMember('hm-1', '1950-01-15', { isPrimary: true, firstName: 'Pat' });
    await seedScenario();
    renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(
        screen.getByText(/you need at least one active traditional IRA/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Add a QCD/i })).toBeDisabled();
  });

  it('shows the not-eligible info alert when no traditional IRA exists', async () => {
    await seedAccount('acct-roth-ira', 'Roth IRA', 'RETIREMENT_ROTH_IRA', 'ROTH');
    await seedMember();
    await seedScenario();
    renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(
        screen.getByText(/you need at least one active traditional IRA/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Add a QCD/i })).toBeDisabled();
  });

  it('a backwards window (end year before start year) disables Save + shows an error; fixing it re-enables Save', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario({
      qualifiedCharitableDistributions: [
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2035 },
          end: { kind: 'year', year: 2030 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(
        screen.getByText(
          /Gift 1: the end year is before the start year — set the end to the same year or later\./i,
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();

    expandRow('QCD 1');
    const startCard = await screen.findByRole('button', {
      name: 'Give starting',
    });
    act(() => {
      fireEvent.click(startCard);
    });
    const startSlider = screen.getByRole('slider', {
      name: 'Give starting year',
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

  it('the row-conflict alert renders between the QCD list and the per-person-limit card', async () => {
    // A backwards window guarantees the alert renders; assert its DOM position after the entries list's content and before the following card.
    await seedAccounts();
    await seedMember();
    await seedScenario({
      qualifiedCharitableDistributions: [
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2035 },
          end: { kind: 'year', year: 2030 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    const alert = await screen.findByText(
      /Gift 1: the end year is before the start year/i,
    );
    const addButton = screen.getByRole('button', { name: /Add a QCD/i });
    const disclosureText = screen.getByText(
      /Each year's gift is automatically capped/i,
    );

    expect(
      addButton.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      alert.compareDocumentPosition(disclosureText) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('accepts a single-year window (start == end) — not flagged as backwards', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario({
      qualifiedCharitableDistributions: [
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2031 },
          end: { kind: 'year', year: 2031 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    const amount = (await screen.findByLabelText(
      /Amount to give each year for QCD 1/i,
    )) as HTMLInputElement;
    act(() => {
      fireEvent.focus(amount);
      fireEvent.change(amount, { target: { value: '12000' } });
      fireEvent.blur(amount);
    });

    expect(
      screen.queryByText(/the end year is before the start year/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled();
  });

  it('two same-account rows with overlapping windows disable Save + show an overlap error; moving one window apart re-enables Save', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario({
      qualifiedCharitableDistributions: [
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2030 },
          end: { kind: 'year', year: 2033 },
        },
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira',
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
          /Gifts 1 and 2 give from the same IRA in overlapping years/i,
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
    const row1 = screen.getByText('QCD 1').closest('li') as HTMLElement;
    const row2 = screen.getByText('QCD 2').closest('li') as HTMLElement;
    expect(within(row1).getByText('Needs attention')).toBeInTheDocument();
    expect(within(row2).getByText('Needs attention')).toBeInTheDocument();

    expandRow('QCD 2');
    const startCard = within(row2).getByRole('button', { name: 'Give starting' });
    act(() => {
      fireEvent.click(startCard);
    });
    const startSlider = within(row2).getByRole('slider', {
      name: 'Give starting year',
    });
    act(() => {
      fireEvent.change(startSlider, { target: { value: '2034' } });
    });

    await waitFor(() =>
      expect(
        screen.queryByText(/give from the same IRA in overlapping years/i),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled();
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });

  it('two same-account rows with the same overlapping window re-enable Save after switching one to a different eligible IRA', async () => {
    await seedAccount('acct-ira', 'IRA One', 'RETIREMENT_IRA', 'PRE_TAX', true, 'hm-1');
    await seedAccount('acct-ira-2', 'IRA Two', 'RETIREMENT_IRA', 'PRE_TAX', true, 'hm-1');
    await seedMember('hm-1', '1950-01-15', { isPrimary: true, firstName: 'Pat' });
    await seedScenario({
      qualifiedCharitableDistributions: [
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2031 },
          end: { kind: 'year', year: 2033 },
        },
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira',
          annualAmountDollars: 5000,
          start: { kind: 'year', year: 2031 },
          end: { kind: 'year', year: 2033 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(
        screen.getByText(/give from the same IRA in overlapping years/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();

    const user = userEvent.setup();
    const row2 = screen.getByText('QCD 2').closest('li') as HTMLElement;
    expandRow('QCD 2');
    const sourceTrigger = within(row2).getByRole('button', {
      name: /Give from this traditional IRA/i,
    });
    await user.click(sourceTrigger);
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: 'IRA Two' }));

    await waitFor(() =>
      expect(
        screen.queryByText(/give from the same IRA in overlapping years/i),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled();
  });

  it('accepts two same-account rows with adjacent NON-overlapping windows (no false positive)', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario({
      qualifiedCharitableDistributions: [
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2031 },
          end: { kind: 'year', year: 2032 },
        },
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira',
          annualAmountDollars: 5000,
          start: { kind: 'year', year: 2033 },
          end: { kind: 'year', year: 2034 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    const amount = (await screen.findByLabelText(
      /Amount to give each year for QCD 1/i,
    )) as HTMLInputElement;
    act(() => {
      fireEvent.focus(amount);
      fireEvent.change(amount, { target: { value: '11000' } });
      fireEvent.blur(amount);
    });

    expect(
      screen.queryByText(/give from the same IRA in overlapping years/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled();
  });

  it('does NOT flag overlap for two rows with the same years but DIFFERENT source IRAs', async () => {
    await seedAccount('acct-ira', 'IRA One', 'RETIREMENT_IRA', 'PRE_TAX', true, 'hm-1');
    await seedAccount('acct-ira-2', 'IRA Two', 'RETIREMENT_IRA', 'PRE_TAX', true, 'hm-1');
    await seedMember('hm-1', '1950-01-15', { isPrimary: true, firstName: 'Pat' });
    await seedScenario({
      qualifiedCharitableDistributions: [
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2031 },
          end: { kind: 'year', year: 2033 },
        },
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira-2',
          annualAmountDollars: 5000,
          start: { kind: 'year', year: 2031 },
          end: { kind: 'year', year: 2033 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    const amount = (await screen.findByLabelText(
      /Amount to give each year for QCD 1/i,
    )) as HTMLInputElement;
    act(() => {
      fireEvent.focus(amount);
      fireEvent.change(amount, { target: { value: '11000' } });
      fireEvent.blur(amount);
    });

    expect(
      screen.queryByText(/give from the same IRA in overlapping years/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled();
  });

  it('two default-Add rows on the same IRA + year overlap → Save disabled; giving row 2 a distinct window re-enables it', async () => {
    // The default Add seeds a single-year window at 70½ on the first eligible source, so two back-to-back adds collide on the same account and year; the user gives the second gift a distinct window.
    await seedAccounts();
    await seedMember();
    await seedScenario();
    renderAt(SCENARIO_ID);

    const add = await screen.findByRole('button', { name: /Add a QCD/i });
    act(() => {
      fireEvent.click(add);
    });
    act(() => {
      fireEvent.click(add);
    });

    await waitFor(() =>
      expect(
        screen.getByText(/give from the same IRA in overlapping years/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();

    const row2 = screen.getByText('QCD 2').closest('li') as HTMLElement;
    const startCard = within(row2).getByRole('button', { name: 'Give starting' });
    act(() => {
      fireEvent.click(startCard);
    });
    const startSlider = within(row2).getByRole('slider', {
      name: 'Give starting year',
    }) as HTMLInputElement;
    const nextYear = Number(startSlider.value) + 1;
    act(() => {
      fireEvent.change(startSlider, { target: { value: String(nextYear) } });
    });
    const endCard = within(row2).getByRole('button', { name: 'Give through' });
    act(() => {
      fireEvent.click(endCard);
    });
    const endSlider = within(row2).getByRole('slider', {
      name: 'Give through year',
    });
    act(() => {
      fireEvent.change(endSlider, { target: { value: String(nextYear) } });
    });

    await waitFor(() =>
      expect(
        screen.queryByText(/give from the same IRA in overlapping years/i),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled();
  });

  it('does NOT disable Save for two overlapping same-account rows whose source is INELIGIBLE (they will be pruned), while two eligible-source overlapping rows still disable it', async () => {
    // Overlapping rows on an ineligible (inactive) source are pruned on save, so their overlap must not block Save.
    await seedAccount('acct-ira', 'Active IRA', 'RETIREMENT_IRA', 'PRE_TAX', true, 'hm-1');
    await seedAccount('acct-ira-closed', 'Closed IRA', 'RETIREMENT_IRA', 'PRE_TAX', false, 'hm-1');
    await seedMember('hm-1', '1950-01-15', { isPrimary: true, firstName: 'Pat' });
    await seedScenario({
      qualifiedCharitableDistributions: [
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira',
          annualAmountDollars: 10000,
          start: { kind: 'year', year: 2031 },
          end: { kind: 'year', year: 2031 },
        },
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira-closed',
          annualAmountDollars: 5000,
          start: { kind: 'year', year: 2033 },
          end: { kind: 'year', year: 2036 },
        },
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira-closed',
          annualAmountDollars: 4000,
          start: { kind: 'year', year: 2034 },
          end: { kind: 'year', year: 2037 },
        },
      ],
    });
    renderAt(SCENARIO_ID);

    const amount = (await screen.findByLabelText(
      /Amount to give each year for QCD 1/i,
    )) as HTMLInputElement;
    act(() => {
      fireEvent.focus(amount);
      fireEvent.change(amount, { target: { value: '11000' } });
      fireEvent.blur(amount);
    });

    expect(
      screen.queryByText(/give from the same IRA in overlapping years/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeEnabled();

    const user = userEvent.setup();
    const row2 = screen.getByText('QCD 2').closest('li') as HTMLElement;
    expandRow('QCD 2');
    const sourceTrigger = within(row2).getByRole('button', {
      name: /Give from this traditional IRA/i,
    });
    await user.click(sourceTrigger);
    const listbox = await screen.findByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: 'Active IRA' }));
    const startCard = within(row2).getByRole('button', { name: 'Give starting' });
    act(() => {
      fireEvent.click(startCard);
    });
    const startSlider = within(row2).getByRole('slider', {
      name: 'Give starting year',
    });
    act(() => {
      fireEvent.change(startSlider, { target: { value: '2031' } });
    });
    const endCard = within(row2).getByRole('button', { name: 'Give through' });
    act(() => {
      fireEvent.click(endCard);
    });
    const endSlider = within(row2).getByRole('slider', {
      name: 'Give through year',
    });
    act(() => {
      fireEvent.change(endSlider, { target: { value: '2031' } });
    });

    await waitFor(() =>
      expect(
        screen.getByText(/give from the same IRA in overlapping years/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
  });

  it("floors the start/end window pickers at the giver's 70½ eligibility (age min 70, year min = 70½ year)", async () => {
    // A sub-70½ giver (born 1965, 70½ first-eligible tax year 2035): the pickers must floor the age slider at 70 and the year slider at 2035 so a pre-70½ window can't be set.
    await seedAccounts();
    await seedMember('hm-1', '1965-06-01');
    await seedScenario({
      qualifiedCharitableDistributions: [
        {
          memberId: 'hm-1',
          sourceAccountId: 'acct-ira',
          start: { kind: 'age', memberId: 'primary', years: 75, months: 0 },
          end: { kind: 'year', year: 2040 },
          annualAmountDollars: 10000,
        },
      ],
    });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'QCD 1' });
    expandRow('QCD 1');
    const startCard = await screen.findByRole('button', {
      name: 'Give starting',
    });
    act(() => {
      fireEvent.click(startCard);
    });
    // The age slider min is floored at 70 (the giver is about 61 today); React Aria renders the thumb as a native range input, so the floor surfaces as `min`.
    const startAgeSlider = screen.getByRole('slider', {
      name: 'Give starting age years',
    }) as HTMLInputElement;
    expect(startAgeSlider).toHaveAttribute('min', '70');
    act(() => {
      fireEvent.change(startAgeSlider, { target: { value: '60' } });
    });
    expect(Number(startAgeSlider.value)).toBeGreaterThanOrEqual(70);

    const endCard = screen.getByRole('button', { name: 'Give through' });
    act(() => {
      fireEvent.click(endCard);
    });
    const endYearSlider = screen.getByRole('slider', {
      name: 'Give through year',
    }) as HTMLInputElement;
    expect(endYearSlider).toHaveAttribute('min', '2035');
    act(() => {
      fireEvent.change(endYearSlider, { target: { value: '2030' } });
    });
    expect(Number(endYearSlider.value)).toBeGreaterThanOrEqual(2035);
  });

  it('only one row is open at a time; Add opens the new row expanded and collapses the previously-open sibling', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario({
      qualifiedCharitableDistributions: [
        { ...QCD_ENTRY, annualAmountDollars: 1000 },
        { ...QCD_ENTRY, annualAmountDollars: 2000, start: { kind: 'year', year: 2027 }, end: { kind: 'year', year: 2027 } },
      ],
    });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'QCD 1' });
    expandRow('QCD 1');
    expect(screen.getByRole('button', { name: /Remove QCD 1/i })).toBeInTheDocument();

    expandRow('QCD 2');
    expect(screen.getByRole('button', { name: /Remove QCD 2/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove QCD 1/i })).toBeNull();

    const add = screen.getByRole('button', { name: /Add a QCD/i });
    act(() => {
      fireEvent.click(add);
    });
    expect(screen.getByRole('button', { name: /Remove QCD 3/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove QCD 2/i })).toBeNull();
  });

  it("re-clicking the open row's own trigger collapses it (toggle-to-close)", async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario({ qualifiedCharitableDistributions: [QCD_ENTRY] });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'QCD 1' });
    expandRow('QCD 1');
    expect(screen.getByRole('button', { name: /Remove QCD 1/i })).toBeInTheDocument();

    expandRow('QCD 1');
    expect(screen.queryByRole('button', { name: /Remove QCD 1/i })).toBeNull();
  });

  it('removing the row ABOVE the open one keeps the originally-open row expanded (draftId-keyed, not index-keyed)', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario({
      qualifiedCharitableDistributions: [
        { ...QCD_ENTRY, annualAmountDollars: 1000, start: { kind: 'year', year: 2026 }, end: { kind: 'year', year: 2026 } },
        { ...QCD_ENTRY, annualAmountDollars: 2000, start: { kind: 'year', year: 2027 }, end: { kind: 'year', year: 2027 } },
        { ...QCD_ENTRY, annualAmountDollars: 3000, start: { kind: 'year', year: 2028 }, end: { kind: 'year', year: 2028 } },
      ],
    });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'QCD 2' });
    expandRow('QCD 2');
    expect(screen.getByRole('button', { name: /Remove QCD 2/i })).toBeInTheDocument();

    // The row is mounted-but-visually-collapsed, so reach its Remove button with `hidden: true`.
    const removeRow1 = screen.getByRole('button', {
      name: /Remove QCD 1/i,
      hidden: true,
    });
    act(() => {
      fireEvent.click(removeRow1);
    });

    // The originally-open row, now relabeled "QCD 1", must stay expanded.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Remove QCD 1/i })).toBeInTheDocument(),
    );
    const amount = screen.getByLabelText(
      /Amount to give each year for QCD 1/i,
    ) as HTMLInputElement;
    expect(Number(amount.value)).toBe(2000);
  });

  it('the "Needs attention" chip appears only on the implicated collapsed row in a 3-row backwards-window case', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario({
      qualifiedCharitableDistributions: [
        { ...QCD_ENTRY, start: { kind: 'year', year: 2026 }, end: { kind: 'year', year: 2026 } },
        {
          ...QCD_ENTRY,
          start: { kind: 'year', year: 2035 },
          end: { kind: 'year', year: 2030 },
        },
        { ...QCD_ENTRY, start: { kind: 'year', year: 2028 }, end: { kind: 'year', year: 2028 } },
      ],
    });
    renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(
        screen.getByText(/Gift 2: the end year is before the start year/i),
      ).toBeInTheDocument(),
    );

    const row1 = screen.getByRole('button', { name: 'QCD 1' }).closest('li') as HTMLElement;
    const row2 = screen.getByRole('button', { name: 'QCD 2' }).closest('li') as HTMLElement;
    const row3 = screen.getByRole('button', { name: 'QCD 3' }).closest('li') as HTMLElement;
    expect(within(row1).queryByText('Needs attention')).toBeNull();
    expect(within(row2).getByText('Needs attention')).toBeInTheDocument();
    expect(within(row3).queryByText('Needs attention')).toBeNull();
  });

  it('the QCD missing-birthdate chip appears collapsed and disappears once the row is expanded', async () => {
    await seedAccounts();
    await seedMember('hm-1', '', { isPrimary: true, firstName: 'Pat' });
    await seedScenario({ qualifiedCharitableDistributions: [QCD_ENTRY] });
    renderAt(SCENARIO_ID);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'QCD 1' })).toBeInTheDocument(),
    );
    expect(screen.getByText('Add a birthdate')).toBeInTheDocument();
    // The full hint is mounted-but-hidden until the row expands (jsdom keeps it in the DOM), so assert `.not.toBeVisible()`.
    expect(
      screen.getByText(/Add their birthdate on the Household page/i),
    ).not.toBeVisible();

    expandRow('QCD 1');
    expect(
      screen.getByText(/Add their birthdate on the Household page/i),
    ).toBeInTheDocument();
  });

  it('after a successful Save, every row renders collapsed', async () => {
    await seedAccounts();
    await seedMember();
    await seedScenario({
      qualifiedCharitableDistributions: [
        { ...QCD_ENTRY, annualAmountDollars: 5000, start: { kind: 'year', year: 2026 }, end: { kind: 'year', year: 2026 } },
        { ...QCD_ENTRY, annualAmountDollars: 6000, start: { kind: 'year', year: 2027 }, end: { kind: 'year', year: 2027 } },
      ],
    });
    renderAt(SCENARIO_ID);

    await screen.findByRole('button', { name: 'QCD 1' });
    expandRow('QCD 1');
    const amount = (await screen.findByLabelText(
      /Amount to give each year for QCD 1/i,
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
      expect(screen.queryByRole('button', { name: /Remove QCD 1/i })).toBeNull(),
    );
    expect(screen.queryByRole('button', { name: /Remove QCD 2/i })).toBeNull();
  });
});
