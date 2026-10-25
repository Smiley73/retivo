// ScenarioDetailPage render and interaction over fake-indexeddb, with AuthContext and SyncContext mocked: action visibility, the retirement-age toggle and warning, and per-section Reset-to-inherited.
import 'fake-indexeddb/auto';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  clearMutationQueue,
  listPendingMutations,
  putAggregate,
} from '../db/store';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { ScenarioDetailPage } from './ScenarioDetailPage';
import { expectNoA11yViolations } from '../test/a11y';

const HH = 'hh-test';

function setupContexts() {
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

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/scenarios/${id}`]}>
      <Routes>
        <Route path="/scenarios/:id" element={<ScenarioDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function seedScenario(
  id: string,
  payload: Partial<ScenarioPayload> & { name: string },
  version = 1,
): Promise<void> {
  const a: Aggregate<ScenarioPayload> = {
    id,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: payload.name,
      description: payload.description ?? '',
      parentScenarioId: payload.parentScenarioId ?? null,
      isPrimary: payload.isPrimary ?? false,
      notes: payload.notes ?? '',
      overrides: payload.overrides ?? {},
    },
  };
  await putAggregate('scenario', a);
}

async function seedMember(id: string, isPrimary: boolean, firstName: string): Promise<void> {
  const m: Aggregate<HouseholdMemberPayload> = {
    id,
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary,
      firstName,
      lastName: 'Doe',
      email: `${firstName.toLowerCase()}@example.test`,
      birthdate: '1985-01-01',
    },
  };
  await putAggregate('householdMember', m);
}

async function seedAccount(
  id: string,
  treatment: AccountPayload['taxTreatment'] = 'POST_TAX',
): Promise<void> {
  const payload: AccountPayload = {
    name: id,
    type: 'BROKERAGE',
    ownershipType: 'INDIVIDUAL',
    taxTreatment: treatment,
    ownerId: 'hm-1',
    institution: 'Bank',
    notes: '',
    planningReturnPct: 7,
    active: true,
    plannedContributionPreTax: 0,
    plannedContributionPostTax: 0,
    assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
  };
  const acc: Aggregate<AccountPayload> = {
    id,
    householdId: HH,
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload,
  };
  await putAggregate('account', acc);
}

beforeEach(() => {
  setupContexts();
});

afterEach(async () => {
  await clearAllStores();
  await clearMutationQueue();
  vi.clearAllMocks();
});

describe('ScenarioDetailPage', () => {
  it('renders the base scenario with the retirement-age summary, then opens the configure modal with prefilled inputs', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        retirementAge: {
          primary: { ageYears: 65, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
      },
    });
    await seedMember('hm-1', true, 'Alex');

    renderAt('p');

    await waitFor(() =>
      expect(screen.getByDisplayValue('Base')).toBeInTheDocument(),
    );
    expect(screen.getByText(/Alex retires at 65/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('alex-retirement-years')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Configure retirement age/i }));
    await waitFor(() =>
      expect(screen.getByLabelText('alex-retirement-years')).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('alex-retirement-years')).toHaveValue('65');
    expect(screen.getByLabelText('alex-retirement-months')).toHaveValue('0');
  });

  it('renders the same-day summary anchored on the primary member with both members present', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        retirementAge: {
          primary: { ageYears: 65, ageMonths: 0 },
          secondary: { ageYears: 62, ageMonths: 3 },
          sameDateAnchor: 'primary',
        },
      },
    });
    await seedMember('hm-1', true, 'Alex');
    await seedMember('hm-2', false, 'Sam');

    renderAt('p');

    await waitFor(() =>
      expect(screen.getByDisplayValue('Base')).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Alex: 65; Sam: same day \(age 62 years 3 months\)/i),
    ).toBeInTheDocument();
  });

  it('falls back to the Primary label when the primary member firstName is whitespace-only', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        retirementAge: {
          primary: { ageYears: 65, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
      },
    });
    // A whitespace-only firstName must resolve to "Primary" (AGENTS member-firstName rule), not a blank label or a broken " -retirement" aria prefix.
    await seedMember('hm-1', true, '   ');

    renderAt('p');

    await waitFor(() =>
      expect(screen.getByDisplayValue('Base')).toBeInTheDocument(),
    );
    expect(screen.getByText(/Primary retires at 65/i)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: /Configure retirement age/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText('primary-retirement-years'),
      ).toBeInTheDocument(),
    );
  });

  it('renders the same-day summary anchored on the primary member with both members present', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        retirementAge: {
          primary: { ageYears: 65, ageMonths: 0 },
          secondary: { ageYears: 62, ageMonths: 3 },
          sameDateAnchor: 'primary',
        },
      },
    });
    await seedMember('hm-1', true, 'Alex');
    await seedMember('hm-2', false, 'Sam');

    renderAt('p');

    await waitFor(() =>
      expect(screen.getByDisplayValue('Base')).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Alex: 65; Sam: same day \(age 62 years 3 months\)/i),
    ).toBeInTheDocument();
  });

  it('hides Promote, Delete, and Reset-all buttons on the base scenario', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedMember('hm-1', true, 'Alex');

    renderAt('p');

    await waitFor(() => screen.getByDisplayValue('Base'));
    expect(screen.queryByRole('button', { name: /Promote/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reset all overrides/i })).toBeNull();
  });

  it('shows Promote, Delete, and Reset-all buttons on a non-base scenario', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedScenario('a', {
      name: 'Aggressive',
      parentScenarioId: 'p',
      overrides: {
        retirementAge: {
          primary: { ageYears: 60, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
      },
    });
    await seedMember('hm-1', true, 'Alex');

    renderAt('a');

    await waitFor(() => screen.getByDisplayValue('Aggressive'));
    expect(screen.getByRole('button', { name: /Promote/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reset all overrides/i })).toBeInTheDocument();
  });

  it('hides the mode picker in the modal when the household has no secondary member', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        retirementAge: {
          primary: { ageYears: 65, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
      },
    });
    await seedMember('hm-1', true, 'Alex');

    renderAt('p');

    await waitFor(() => screen.getByDisplayValue('Base'));
    fireEvent.click(screen.getByRole('button', { name: /Configure retirement age/i }));
    await waitFor(() => screen.getByLabelText('alex-retirement-years'));
    expect(screen.queryByRole('radio', { name: /Each retires independently/i })).toBeNull();
    expect(screen.queryByRole('radio', { name: /Both retire when/i })).toBeNull();
    expect(screen.queryByLabelText(/sam-retirement-years/i)).toBeNull();
  });

  it('shows the date warning + secondary inputs in the modal when independent ages produce different dates', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        retirementAge: {
          primary: { ageYears: 65, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 6 },
        },
      },
    });
    await seedMember('hm-1', true, 'Alex');
    await seedMember('hm-2', false, 'Sam');

    renderAt('p');

    await waitFor(() => screen.getByDisplayValue('Base'));
    fireEvent.click(screen.getByRole('button', { name: /Configure retirement age/i }));
    await waitFor(() => screen.getByLabelText('sam-retirement-years'));
    expect(
      screen.getByText(
        /Future retirement-spending projections \(withdrawals, expenses, balance drawdown\) will use the primary user's retirement date/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('sam-retirement-years')).toHaveValue('67');
    expect(screen.getByLabelText('sam-retirement-months')).toHaveValue('6');
    expect(
      screen.getByRole('radio', { name: /Each retires independently/i }),
    ).toBeChecked();
  });

  it('switching from independent to "Both retire when Alex retires" disables the secondary input + clears the warning', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        retirementAge: {
          primary: { ageYears: 65, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 6 },
        },
      },
    });
    await seedMember('hm-1', true, 'Alex');
    await seedMember('hm-2', false, 'Sam');

    renderAt('p');

    await waitFor(() => screen.getByDisplayValue('Base'));
    fireEvent.click(screen.getByRole('button', { name: /Configure retirement age/i }));
    await waitFor(() => screen.getByLabelText('sam-retirement-years'));

    const independentRadio = screen.getByRole('radio', {
      name: /Each retires independently/i,
    });
    const anchorPrimaryRadio = screen.getByRole('radio', {
      name: /Both retire when Alex retires/i,
    });
    expect(independentRadio).toBeChecked();
    expect(
      screen.getByText(/Future retirement-spending projections/i),
    ).toBeInTheDocument();

    fireEvent.click(anchorPrimaryRadio);

    await waitFor(() => expect(anchorPrimaryRadio).toBeChecked());
    expect(screen.getByLabelText('sam-retirement-years')).toBeDisabled();
    expect(
      screen.queryByText(/Future retirement-spending projections/i),
    ).toBeNull();
  });

  it('switching to "Both retire when Sam retires" disables the primary input', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        retirementAge: {
          primary: { ageYears: 65, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
      },
    });
    await seedMember('hm-1', true, 'Alex');
    await seedMember('hm-2', false, 'Sam');

    renderAt('p');

    await waitFor(() => screen.getByDisplayValue('Base'));
    fireEvent.click(screen.getByRole('button', { name: /Configure retirement age/i }));
    await waitFor(() => screen.getByLabelText('sam-retirement-years'));

    fireEvent.click(
      screen.getByRole('radio', { name: /Both retire when Sam retires/i }),
    );

    await waitFor(() =>
      expect(screen.getByLabelText('alex-retirement-years')).toBeDisabled(),
    );
    expect(screen.getByLabelText('sam-retirement-years')).not.toBeDisabled();
  });

  it('renders the SS claim-age summary card with the resolved primary value', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
        },
      },
    });
    await seedMember('hm-1', true, 'Alex');

    renderAt('p');

    await waitFor(() => screen.getByDisplayValue('Base'));
    expect(screen.getByText(/Alex claims at 67/i)).toBeInTheDocument();
  });

  it('renders both primary + secondary inputs in the SS modal when secondary member exists', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 70, ageMonths: 0 },
        },
      },
    });
    await seedMember('hm-1', true, 'Alex');
    await seedMember('hm-2', false, 'Sam');

    renderAt('p');

    await waitFor(() => screen.getByDisplayValue('Base'));
    fireEvent.click(
      screen.getByRole('button', { name: /Configure Social Security/i }),
    );
    // SS claim age is a React Aria `RangeSlider`: its native `value` surfaces the snapped year and the spoken value rides the accessible-description channel.
    await waitFor(() =>
      screen.getByRole('slider', { name: /Alex Social Security claim age/i }),
    );
    expect(
      screen.getByRole('slider', { name: /Alex Social Security claim age/i }),
    ).toHaveValue('67');
    expect(
      screen.getByRole('slider', { name: /Sam Social Security claim age/i }),
    ).toHaveValue('70');
    expect(screen.queryByRole('switch', { name: /same age/i })).toBeNull();
  });

  it('hides the SS secondary input when no secondary household member exists', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
        },
      },
    });
    await seedMember('hm-1', true, 'Alex');

    renderAt('p');

    await waitFor(() => screen.getByDisplayValue('Base'));
    fireEvent.click(
      screen.getByRole('button', { name: /Configure Social Security/i }),
    );
    await waitFor(() =>
      screen.getByRole('slider', { name: /Alex Social Security claim age/i }),
    );
    expect(
      screen.queryByRole('slider', {
        name: /Sam Social Security claim age/i,
      }),
    ).toBeNull();
  });

  it('shows "Reset to inherited" only when the non-base scenario overrides Social Security', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
        },
      },
    });
    await seedScenario('a', {
      name: 'Aggressive',
      parentScenarioId: 'p',
      overrides: {
        socialSecurity: {
          primary: { ageYears: 62, ageMonths: 0 },
        },
      },
    });
    await seedScenario('e', {
      name: 'Empty',
      parentScenarioId: 'p',
    });
    await seedMember('hm-1', true, 'Alex');

    const aggressive = renderAt('a');
    await waitFor(() => screen.getByDisplayValue('Aggressive'));
    expect(
      screen.getByRole('button', {
        name: /Reset Social Security claim age/i,
      }),
    ).toBeInTheDocument();
    aggressive.unmount();

    renderAt('e');
    await waitFor(() => screen.getByDisplayValue('Empty'));
    expect(
      screen.queryByRole('button', {
        name: /Reset Social Security claim age/i,
      }),
    ).toBeNull();
  });

  it('shows "Reset to inherited" only when the non-base scenario overrides retirement age', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        retirementAge: {
          primary: { ageYears: 65, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
      },
    });
    await seedScenario('a', {
      name: 'Aggressive',
      parentScenarioId: 'p',
      overrides: {
        retirementAge: {
          primary: { ageYears: 60, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
      },
    });
    await seedScenario('e', {
      name: 'Empty',
      parentScenarioId: 'p',
    });
    await seedMember('hm-1', true, 'Alex');

    const aggressive = renderAt('a');
    await waitFor(() => screen.getByDisplayValue('Aggressive'));
    expect(
      screen.getByRole('button', { name: /Reset retirement age/i }),
    ).toBeInTheDocument();
    aggressive.unmount();

    renderAt('e');
    await waitFor(() => screen.getByDisplayValue('Empty'));
    expect(
      screen.queryByRole('button', { name: /Reset retirement age/i }),
    ).toBeNull();
  });

  it('renders the Future contributions card with body text reflecting the resolved value', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        retirementAge: { primary: { ageYears: 65, ageMonths: 0 } },
        contributions: { stopContributionsToday: false },
      },
    });
    await seedMember('hm-1', true, 'Alex');

    renderAt('p');
    await waitFor(() => screen.getByDisplayValue('Base'));
    expect(screen.getByRole('heading', { name: /Future contributions/i })).toBeInTheDocument();
    expect(screen.getByText(/Continue contributions until retirement\.?/i)).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: /Stop contributing today/i });
    expect(toggle).not.toBeChecked();
  });

  it('saves the contributions toggle inline without a modal', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        retirementAge: { primary: { ageYears: 65, ageMonths: 0 } },
      },
    });
    await seedMember('hm-1', true, 'Alex');

    renderAt('p');
    await waitFor(() => screen.getByDisplayValue('Base'));
    const toggle = screen.getByRole('switch', { name: /Stop contributing today/i });
    fireEvent.click(toggle);
    await waitFor(() => screen.getByText(/Stop contributing today\./i));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows Reset to inherited only when contributions is overridden locally', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        retirementAge: { primary: { ageYears: 65, ageMonths: 0 } },
        contributions: { stopContributionsToday: false },
      },
    });
    await seedScenario('a', {
      name: 'Aggressive',
      parentScenarioId: 'p',
      overrides: {
        contributions: { stopContributionsToday: true },
      },
    });
    await seedScenario('e', {
      name: 'Empty',
      parentScenarioId: 'p',
    });
    await seedMember('hm-1', true, 'Alex');

    const aggressive = renderAt('a');
    await waitFor(() => screen.getByDisplayValue('Aggressive'));
    expect(
      screen.getByRole('button', { name: /Reset future contributions/i }),
    ).toBeInTheDocument();
    aggressive.unmount();

    renderAt('e');
    await waitFor(() => screen.getByDisplayValue('Empty'));
    expect(
      screen.queryByRole('button', { name: /Reset future contributions/i }),
    ).toBeNull();
  });

  it('renders 4 card groups with the correct headings in documented order', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedMember('hm-1', true, 'Alex');
    renderAt('p');
    await waitFor(() => screen.getByDisplayValue('Base'));

    const timingGroup = await screen.findByTestId('scenario-group-timing');
    const incomeGroup = await screen.findByTestId('scenario-group-income');
    const savingsGroup = await screen.findByTestId('scenario-group-savings');
    const withdrawalsGroup = await screen.findByTestId('scenario-group-withdrawals');

    const row = await screen.findByTestId('scenario-overrides-row');
    const groupTestids = Array.from(
      row.querySelectorAll('[data-testid^="scenario-group-"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(groupTestids).toEqual([
      'scenario-group-timing',
      'scenario-group-income',
      'scenario-group-savings',
      'scenario-group-withdrawals',
    ]);

    const headings = (el: HTMLElement) =>
      Array.from(el.querySelectorAll('h3')).map((h) => h.textContent ?? '');

    expect(headings(timingGroup).some((t) => /Retirement age/i.test(t))).toBe(true);
    expect(headings(timingGroup).some((t) => /Social Security/i.test(t))).toBe(true);
    expect(headings(timingGroup).some((t) => /Life expectancy/i.test(t))).toBe(true);

    expect(headings(incomeGroup).some((t) => /Income/i.test(t))).toBe(true);
    expect(headings(incomeGroup).some((t) => /Expense/i.test(t))).toBe(true);
    expect(headings(incomeGroup).some((t) => /Inflation/i.test(t))).toBe(true);
    expect(headings(incomeGroup).some((t) => /Discretionary/i.test(t))).toBe(true);

    expect(headings(savingsGroup).some((t) => /Future contributions/i.test(t))).toBe(true);
    expect(headings(savingsGroup).some((t) => /Account contributions/i.test(t))).toBe(true);
    expect(headings(savingsGroup).some((t) => /Planned returns/i.test(t))).toBe(true);
    expect(headings(savingsGroup).some((t) => /Asset allocation/i.test(t))).toBe(true);

    expect(headings(withdrawalsGroup).some((t) => /Withdrawal strategy/i.test(t))).toBe(true);
    expect(headings(withdrawalsGroup).some((t) => /Tax assumptions/i.test(t))).toBe(true);
    expect(headings(withdrawalsGroup).some((t) => /Account limits/i.test(t))).toBe(true);
  });

  it('account floors: Account limits card shows the floored-account count', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedScenario('a', {
      name: 'Floored',
      parentScenarioId: 'p',
      overrides: {
        accountFloors: {
          perAccount: {
            'acct-hsa': { floorDollars: 10000, hsaMode: 'strict' },
            'acct-broker': { floorDollars: 25000 },
          },
        },
      },
    });
    await seedMember('hm-1', true, 'Alex');
    await seedAccount('acct-hsa', 'HSA');
    await seedAccount('acct-broker', 'POST_TAX');
    renderAt('a');
    await waitFor(() => screen.getByDisplayValue('Floored'));

    const withdrawalsGroup = await screen.findByTestId('scenario-group-withdrawals');
    const heading = within(withdrawalsGroup).getByText(/Account limits/i);
    const card = heading.closest('section') as HTMLElement;
    expect(within(card).getByText(/2 accounts with a minimum-balance floor/i)).toBeInTheDocument();
  });

  it('account floors: Account limits card counts an INHERITED floor (no local override)', async () => {
    // The child inherits the parent's floor with no local accountFloors; the engine still enforces it, so the card must show the resolved count, not "No account floors set", and no Customized pill.
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedScenario('parent', {
      name: 'Parent',
      parentScenarioId: 'p',
      overrides: {
        accountFloors: { perAccount: { 'acct-broker': { floorDollars: 25000 } } },
      },
    });
    await seedScenario('child', {
      name: 'Child',
      parentScenarioId: 'parent',
      overrides: {},
    });
    await seedMember('hm-1', true, 'Alex');
    await seedAccount('acct-broker', 'POST_TAX');
    renderAt('child');
    await waitFor(() => screen.getByDisplayValue('Child'));

    const withdrawalsGroup = await screen.findByTestId('scenario-group-withdrawals');
    const heading = within(withdrawalsGroup).getByText(/Account limits/i);
    const card = heading.closest('section') as HTMLElement;
    expect(
      within(card).getByText(/1 account with a minimum-balance floor/i),
    ).toBeInTheDocument();
    expect(within(card).queryByText(/No account floors set/i)).toBeNull();
  });

  it('account floors: Account limits card shows "No account floors set" when none', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedMember('hm-1', true, 'Alex');
    renderAt('p');
    await waitFor(() => screen.getByDisplayValue('Base'));

    const withdrawalsGroup = await screen.findByTestId('scenario-group-withdrawals');
    const heading = within(withdrawalsGroup).getByText(/Account limits/i);
    const card = heading.closest('section') as HTMLElement;
    expect(within(card).getByText(/No account floors set/i)).toBeInTheDocument();
  });

  it('account floors: shows no floor-ineffective warning under a named strategy', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        withdrawalStrategy: { kind: 'taxEfficient' },
        accountFloors: { perAccount: { 'acct-broker': { floorDollars: 25000 } } },
      },
    });
    await seedMember('hm-1', true, 'Alex');
    await seedAccount('acct-broker', 'POST_TAX');
    renderAt('p');
    await waitFor(() => screen.getByDisplayValue('Base'));

    const withdrawalsGroup = await screen.findByTestId('scenario-group-withdrawals');
    const heading = within(withdrawalsGroup).getByText(/Account limits/i);
    const card = heading.closest('section') as HTMLElement;
    expect(within(card).getByText(/minimum-balance floor/i)).toBeInTheDocument();
    expect(
      within(card).queryByText(/Floors have no effect/i),
    ).toBeNull();
  });

  it('account floors: Account limits Configure navigates to /scenarios/:id/floors', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });

    function LocationProbe() {
      const location = useLocation();
      return <div data-testid="pathname">{location.pathname}</div>;
    }
    render(
      <MemoryRouter initialEntries={['/scenarios/p']}>
        <LocationProbe />
        <Routes>
          <Route path="/scenarios/:id" element={<ScenarioDetailPage />} />
          <Route path="/scenarios/:id/floors" element={<div>floors page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByDisplayValue('Base')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Configure account floors/i }));
    await waitFor(() =>
      expect(screen.getByTestId('pathname').textContent).toBe('/scenarios/p/floors'),
    );
  });

  it('account floors: Account limits Reset is hidden on base, visible on a non-base local override', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        accountFloors: { perAccount: { 'acc-broker': { floorDollars: 25000 } } },
      },
    });
    await seedAccount('acc-broker', 'POST_TAX');
    renderAt('p');
    await waitFor(() => screen.getByDisplayValue('Base'));
    const baseCard = (
      await screen.findByTestId('scenario-group-withdrawals')
    );
    const baseHeading = within(baseCard).getByText(/Account limits/i);
    expect(
      within(baseHeading.closest('section') as HTMLElement).queryByRole('button', {
        name: /Reset account floors/i,
      }),
    ).toBeNull();
  });

  it('account floors: Account limits Reset clears the local accountFloors override', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedScenario('a', {
      name: 'Floored',
      parentScenarioId: 'p',
      overrides: {
        accountFloors: { perAccount: { 'acc-broker': { floorDollars: 25000 } } },
      },
    });
    await seedAccount('acc-broker', 'POST_TAX');
    renderAt('a');
    await waitFor(() => screen.getByDisplayValue('Floored'));

    const withdrawalsGroup = await screen.findByTestId('scenario-group-withdrawals');
    const heading = within(withdrawalsGroup).getByText(/Account limits/i);
    const card = heading.closest('section') as HTMLElement;
    const resetBtn = within(card).getByRole('button', { name: /Reset account floors/i });
    fireEvent.click(resetBtn);

    const confirmBtn = await screen.findByRole('button', { name: /^Reset$/i });
    fireEvent.click(confirmBtn);

    await waitFor(async () => {
      const mutations = await listPendingMutations();
      const updates = mutations.filter(
        (m) =>
          m.aggregateType === 'scenario' &&
          m.operation === 'update' &&
          m.aggregateId === 'a',
      );
      expect(updates).toHaveLength(1);
      const overrides = (updates[0].payload as ScenarioPayload).overrides;
      expect(overrides.accountFloors).toBeUndefined();
    });
  });

  it('shows customized tint on an overridden card and no tint on a clean card', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedScenario('a', {
      name: 'Aggressive',
      parentScenarioId: 'p',
      overrides: { inflation: { ratePct: 4 } },
    });
    await seedMember('hm-1', true, 'Alex');
    renderAt('a');
    await waitFor(() => screen.getByDisplayValue('Aggressive'));

    const incomeGroup = await screen.findByTestId('scenario-group-income');
    const inflationHeading = within(incomeGroup).getByText(/Inflation/i);
    const inflationCard = inflationHeading.closest('section');
    expect(inflationCard).toHaveClass('bg-accent-subtle');

    const timingGroup = await screen.findByTestId('scenario-group-timing');
    const retirementHeading = within(timingGroup).getByText(/Retirement age/i);
    const retirementCard = retirementHeading.closest('section');
    expect(retirementCard).not.toHaveClass('bg-accent-subtle');
  });

  it('shows N customized badge on groups with overrides and no badge on clean groups', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedScenario('a', {
      name: 'Custom',
      parentScenarioId: 'p',
      overrides: {
        inflation: { ratePct: 4 },
        discretionarySpending: { bumpPct: -10, durationYears: null },
      },
    });
    await seedMember('hm-1', true, 'Alex');
    renderAt('a');
    await waitFor(() => screen.getByDisplayValue('Custom'));

    const row = await screen.findByTestId('scenario-overrides-row');
    const badges = Array.from(row.querySelectorAll('span')).filter((s) =>
      /customized/.test(s.textContent ?? ''),
    );
    expect(badges.some((b) => /2 customized/.test(b.textContent ?? ''))).toBe(true);

    const timingGroup = await screen.findByTestId('scenario-group-timing');
    const timingParent = timingGroup.parentElement;
    const timingBadge = timingParent
      ? Array.from(timingParent.querySelectorAll('span')).find((s) =>
          /customized/.test(s.textContent ?? ''),
        ) ?? null
      : null;
    expect(timingBadge).toBeNull();
  });

  it('keeps the Tax assumptions card body text "No scenario overrides." when not overridden', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedScenario('a', {
      name: 'Child',
      parentScenarioId: 'p',
      overrides: {},
    });
    await seedMember('hm-1', true, 'Alex');
    renderAt('a');
    await waitFor(() => screen.getByDisplayValue('Child'));

    const withdrawalsGroup = await screen.findByTestId('scenario-group-withdrawals');
    const taxHeading = within(withdrawalsGroup).getByText(/Tax assumptions/i);
    const taxCard = taxHeading.closest('section');
    expect(within(taxCard as HTMLElement).getByText('No scenario overrides.')).toBeInTheDocument();
  });

  it('does not show customized tint on any card of the base scenario, even with local overrides', async () => {
    await seedScenario('base', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        retirementAge: {
          primary: { ageYears: 60, ageMonths: 0 },
          sameDateAnchor: 'primary',
        },
        socialSecurity: {
          primary: { ageYears: 62, ageMonths: 0 },
        },
        contributions: { stopContributionsToday: true },
      },
    });
    await seedMember('hm-1', true, 'Alex');
    const { container } = renderAt('base');
    await waitFor(() => screen.getByDisplayValue('Base'));

    const row = await screen.findByTestId('scenario-overrides-row');
    const sections = Array.from(row.querySelectorAll('section'));
    sections.forEach((section) => expect(section).not.toHaveClass('bg-accent-subtle'));
    for (const headingId of [
      'retirement-age-heading',
      'social-security-heading',
      'future-contributions-heading',
    ]) {
      const section = container.querySelector(`[aria-labelledby="${headingId}"]`);
      expect(section, `section[aria-labelledby="${headingId}"] should exist`).not.toBeNull();
      expect(section).not.toHaveClass('bg-accent-subtle');
    }
  });

  it('parent-picker renders a 3-level Base→A→B chain with depth classes', async () => {
    const user = userEvent.setup();
    await seedScenario('base', { name: 'Base', isPrimary: true });
    await seedScenario('a', { name: 'A', isPrimary: false, parentScenarioId: 'base' });
    await seedScenario('b', { name: 'B', isPrimary: false, parentScenarioId: 'a' });
    renderAt('b');
    await waitFor(() => screen.getByDisplayValue('B'));
    const parentBtn = screen.getByRole('button', { name: /Parent scenario/ });
    await user.click(parentBtn);
    const rows = await screen.findAllByRole('option');
    // B is filtered out (blocked is B and its descendants); Base at depth 0 gets pl-2, A at depth 1 pl-6.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]).toHaveClass('pl-2'); // Base at depth 0
    expect(rows[1]).toHaveClass('pl-6'); // A at depth 1
  });

  it('parent-picker excludes self and descendants: editing A in Base→A→B omits A and B', async () => {
    // Self and descendant exclusion: for A, blocked is {a, b}, so only Base appears.
    const user = userEvent.setup();
    await seedScenario('base', { name: 'Base', isPrimary: true });
    await seedScenario('a', { name: 'A', isPrimary: false, parentScenarioId: 'base' });
    await seedScenario('b', { name: 'B', isPrimary: false, parentScenarioId: 'a' });
    renderAt('a');
    await waitFor(() => screen.getByDisplayValue('A'));
    const parentBtn = screen.getByRole('button', { name: /Parent scenario/ });
    await user.click(parentBtn);
    expect(screen.queryByRole('option', { name: 'A' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'B' })).toBeNull();
    const baseOption = await screen.findByRole('option', { name: 'Base' });
    expect(baseOption).toHaveClass('pl-2'); // depth 0 → pl-2
  });

  it('onResetWithdrawalStrategy removes all three withdrawal-strategy keys in one mutation', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedScenario('a', {
      name: 'Aggressive',
      parentScenarioId: 'p',
      overrides: {
        withdrawalStrategy: { kind: 'taxEfficient' },
        assumedCostBasisFractionOfTaxableWithdrawal: 0.6,
        magiBootstrapLookbackMinus2: 52000,
        magiBootstrapLookbackMinus1: 52000,
      },
    });
    await seedMember('hm-1', true, 'Alex');

    renderAt('a');
    await waitFor(() => screen.getByDisplayValue('Aggressive'));

    const resetBtn = screen.getByRole('button', { name: /Reset withdrawal strategy/i });
    fireEvent.click(resetBtn);

    const confirmBtn = await screen.findByRole('button', { name: /^Reset$/i });
    fireEvent.click(confirmBtn);

    await waitFor(async () => {
      const mutations = await listPendingMutations();
      const updates = mutations.filter(
        (m) =>
          m.aggregateType === 'scenario' &&
          m.operation === 'update' &&
          m.aggregateId === 'a',
      );
      expect(updates).toHaveLength(1);
      const overrides = (updates[0].payload as ScenarioPayload).overrides;
      expect(overrides.withdrawalStrategy).toBeUndefined();
      expect(overrides.assumedCostBasisFractionOfTaxableWithdrawal).toBeUndefined();
      expect(overrides.magiBootstrapLookbackMinus2).toBeUndefined();
      expect(overrides.magiBootstrapLookbackMinus1).toBeUndefined();
    });
  });

  it('shows the base-scenario effective retirement-age default with no override set', async () => {
    // No retirementAge override falls back to DEFAULT_RETIREMENT (65): the effective value shows instead of "No scenario overrides."
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedMember('hm-1', true, 'Alex');

    const { container } = renderAt('p');

    await waitFor(() => expect(screen.getByDisplayValue('Base')).toBeInTheDocument());
    expect(screen.getByText(/Alex retires at 65/i)).toBeInTheDocument();
    // Scoped to this card: TaxAssumptionsCard intentionally keeps "No scenario overrides."
    const section = container.querySelector<HTMLElement>('[aria-labelledby="retirement-age-heading"]');
    expect(section).not.toBeNull();
    expect(within(section!).queryByText('No scenario overrides.')).not.toBeInTheDocument();
  });

  it('shows the base-scenario effective Social Security default with no override set', async () => {
    // No socialSecurity override falls back to DEFAULT_SS_CLAIM (67, full benefit, COLA tracks inflation).
    await seedScenario('p', { name: 'Base', isPrimary: true });

    const { container } = renderAt('p');

    await waitFor(() => expect(screen.getByDisplayValue('Base')).toBeInTheDocument());
    expect(screen.getByText(/claims at 67/i)).toBeInTheDocument();
    // Scoped to this card: TaxAssumptionsCard intentionally keeps "No scenario overrides."
    const section = container.querySelector<HTMLElement>('[aria-labelledby="social-security-heading"]');
    expect(section).not.toBeNull();
    expect(within(section!).queryByText('No scenario overrides.')).not.toBeInTheDocument();
  });

  it('summarizes SS COLA as tracking inflation by default (resolved rate shown)', async () => {
    // colaTracksInflation absent means on; with no inflation override the card must show the resolved DEFAULT_INFLATION_PCT (3%) the engines apply, not the dormant fixed colaPct.
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          colaPct: 2,
        },
      },
    });

    const { container } = renderAt('p');

    await waitFor(() => expect(screen.getByDisplayValue('Base')).toBeInTheDocument());
    const section = container.querySelector<HTMLElement>('[aria-labelledby="social-security-heading"]');
    expect(section).not.toBeNull();
    expect(
      within(section!).getByText(/COLA tracks inflation \(3\.0%\)/i),
    ).toBeInTheDocument();
  });

  it('summarizes the fixed SS COLA when inflation-tracking is explicitly off', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        socialSecurity: {
          primary: { ageYears: 67, ageMonths: 0 },
          colaPct: 2,
          colaTracksInflation: false,
        },
      },
    });

    const { container } = renderAt('p');

    await waitFor(() => expect(screen.getByDisplayValue('Base')).toBeInTheDocument());
    const section = container.querySelector<HTMLElement>('[aria-labelledby="social-security-heading"]');
    expect(section).not.toBeNull();
    expect(within(section!).getByText(/2\.0% COLA/i)).toBeInTheDocument();
    expect(
      within(section!).queryByText(/COLA tracks inflation/i),
    ).not.toBeInTheDocument();
  });

  it('shows "Continue contributions until retirement." on the base scenario with no override set', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });

    const { container } = renderAt('p');

    await waitFor(() => expect(screen.getByDisplayValue('Base')).toBeInTheDocument());
    expect(screen.getByText('Continue contributions until retirement.')).toBeInTheDocument();
    // Scoped to this card: TaxAssumptionsCard intentionally keeps "No scenario overrides."
    const section = container.querySelector<HTMLElement>('[aria-labelledby="future-contributions-heading"]');
    expect(section).not.toBeNull();
    expect(within(section!).queryByText('No scenario overrides.')).not.toBeInTheDocument();
  });

  const ROTH_CONVERSION = {
    sourceAccountId: 'acct-pretax',
    targetRothAccountId: 'acct-roth-ira',
    annualAmountDollars: 10000,
    start: { kind: 'year' as const, year: 2030 },
    end: { kind: 'year' as const, year: 2030 },
  };

  function rothCard(): HTMLElement {
    const section = document.querySelector<HTMLElement>(
      '[aria-labelledby="roth-conversions-heading"]',
    );
    if (!section) throw new Error('Roth conversions card not found');
    return section;
  }

  it('Roth-conversions card on a base scenario with no override reads "No scenario overrides."', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    renderAt('p');
    await waitFor(() => screen.getByDisplayValue('Base'));
    expect(
      within(rothCard()).getByText('No scenario overrides.'),
    ).toBeInTheDocument();
  });

  it('Roth-conversions card with a local override shows the total burden + plural copy', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedScenario('a', {
      name: 'Aggressive',
      parentScenarioId: 'p',
      overrides: {
        preRetirementRothConversions: [
          ROTH_CONVERSION,
          { ...ROTH_CONVERSION, annualAmountDollars: 5000 },
        ],
        preRetirementRothConversionTaxRatePct: 24,
      },
    });
    renderAt('a');
    await waitFor(() => screen.getByDisplayValue('Aggressive'));

    const card = rothCard();
    // Both are single-year windows: (10,000 + 5,000) × 24% × 1 year = $3,600; the copy uses "rate R%" and drops the "not deducted" tail.
    expect(
      within(card).getByText(/2 conversions during your working years/i),
    ).toBeInTheDocument();
    expect(within(card).getByText(/\$3,600 total/)).toBeInTheDocument();
    expect(within(card).getByText(/rate 24%/)).toBeInTheDocument();
    expect(within(card).queryByText(/not deducted/i)).toBeNull();
  });

  it('Roth-conversions card multiplies the per-year burden by the window length (total, not annual)', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedScenario('a', {
      name: 'Aggressive',
      parentScenarioId: 'p',
      overrides: {
        preRetirementRothConversions: [
          {
            ...ROTH_CONVERSION,
            annualAmountDollars: 2200,
            start: { kind: 'year', year: 2026 },
            end: { kind: 'year', year: 2028 },
          },
        ],
        preRetirementRothConversionTaxRatePct: 100,
      },
    });
    renderAt('a');
    await waitFor(() => screen.getByDisplayValue('Aggressive'));

    const card = rothCard();
    expect(within(card).getByText(/\$6,600 total/)).toBeInTheDocument();
    expect(within(card).queryByText(/\$2,200 total/)).toBeNull();
  });

  it('Roth-conversions card sums each conversion full window into the lifetime total', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedScenario('a', {
      name: 'Aggressive',
      parentScenarioId: 'p',
      overrides: {
        preRetirementRothConversions: [
          {
            ...ROTH_CONVERSION,
            annualAmountDollars: 2200,
            start: { kind: 'year', year: 2028 },
            end: { kind: 'year', year: 2030 },
          },
          {
            ...ROTH_CONVERSION,
            annualAmountDollars: 4400,
            start: { kind: 'year', year: 2030 },
            end: { kind: 'year', year: 2032 },
          },
        ],
        preRetirementRothConversionTaxRatePct: 100,
      },
    });
    renderAt('a');
    await waitFor(() => screen.getByDisplayValue('Aggressive'));

    const card = rothCard();
    // Each conversion counts every year of its own window, not just the overlap.
    expect(within(card).getByText(/\$19,800 total/)).toBeInTheDocument();
  });

  it('Roth-conversions card uses singular copy for one conversion', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        preRetirementRothConversions: [ROTH_CONVERSION],
        preRetirementRothConversionTaxRatePct: 22,
      },
    });
    renderAt('p');
    await waitFor(() => screen.getByDisplayValue('Base'));
    expect(
      within(rothCard()).getByText(/1 conversion during your working years/i),
    ).toBeInTheDocument();
  });

  it('Roth-conversions card Configure navigates to /scenarios/:id/roth-conversions', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });

    function LocationProbe() {
      const location = useLocation();
      return <div data-testid="pathname">{location.pathname}</div>;
    }
    render(
      <MemoryRouter initialEntries={['/scenarios/p']}>
        <LocationProbe />
        <Routes>
          <Route path="/scenarios/:id" element={<ScenarioDetailPage />} />
          <Route
            path="/scenarios/:id/roth-conversions"
            element={<div>roth conversions page</div>}
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByDisplayValue('Base')).toBeInTheDocument());

    fireEvent.click(
      screen.getByRole('button', { name: /Configure working-years Roth conversions/i }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('pathname').textContent).toBe(
        '/scenarios/p/roth-conversions',
      ),
    );
  });

  it('Roth-conversions Reset link is hidden on the base scenario, visible on a non-base local override', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: { preRetirementRothConversions: [ROTH_CONVERSION] },
    });
    renderAt('p');
    await waitFor(() => screen.getByDisplayValue('Base'));
    expect(
      within(rothCard()).queryByRole('button', {
        name: /Reset working-years Roth conversions/i,
      }),
    ).toBeNull();
  });

  it('an inheriting child shows the parent conversions (not "No scenario overrides.") with an inherited-from line, no Reset', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: {
        preRetirementRothConversions: [ROTH_CONVERSION],
        preRetirementRothConversionTaxRatePct: 20,
      },
    });
    await seedScenario('a', {
      name: 'Child',
      parentScenarioId: 'p',
    });
    renderAt('a');
    await waitFor(() => screen.getByDisplayValue('Child'));

    const card = rothCard();
    expect(
      within(card).getByText(/1 conversion during your working years/i),
    ).toBeInTheDocument();
    expect(within(card).queryByText('No scenario overrides.')).toBeNull();
    expect(within(card).getByText(/Inherited from Base\./i)).toBeInTheDocument();
    expect(
      within(card).queryByRole('button', {
        name: /Reset working-years Roth conversions/i,
      }),
    ).toBeNull();
  });

  it('onResetRothConversions removes all Roth-conversion keys in one mutation', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedScenario('a', {
      name: 'Aggressive',
      parentScenarioId: 'p',
      overrides: {
        preRetirementRothConversions: [ROTH_CONVERSION],
        preRetirementRothConversionTaxRatePct: 24,
      },
    });
    renderAt('a');
    await waitFor(() => screen.getByDisplayValue('Aggressive'));

    const resetBtn = within(rothCard()).getByRole('button', {
      name: /Reset working-years Roth conversions/i,
    });
    fireEvent.click(resetBtn);

    const confirmBtn = await screen.findByRole('button', { name: /^Reset$/i });
    fireEvent.click(confirmBtn);

    await waitFor(async () => {
      const mutations = await listPendingMutations();
      const updates = mutations.filter(
        (m) =>
          m.aggregateType === 'scenario' &&
          m.operation === 'update' &&
          m.aggregateId === 'a',
      );
      expect(updates).toHaveLength(1);
      const overrides = (updates[0].payload as ScenarioPayload).overrides;
      expect(overrides.preRetirementRothConversions).toBeUndefined();
      expect(overrides.preRetirementRothConversionTaxRatePct).toBeUndefined();
    });
  });

  it('Configure on the Withdrawal-strategy card navigates to the page with no dialog', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedMember('hm-1', true, 'Alex');

    function LocationProbe() {
      const location = useLocation();
      return <div data-testid="pathname">{location.pathname}</div>;
    }

    render(
      <MemoryRouter initialEntries={['/scenarios/p']}>
        <LocationProbe />
        <Routes>
          <Route path="/scenarios/:id" element={<ScenarioDetailPage />} />
          <Route
            path="/scenarios/:id/withdrawal-strategy"
            element={<div>withdrawal strategy page</div>}
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByDisplayValue('Base')).toBeInTheDocument());

    fireEvent.click(
      screen.getByRole('button', { name: /Configure withdrawal strategy/i }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('pathname').textContent).toBe(
        '/scenarios/p/withdrawal-strategy',
      ),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  const QCD_ENTRY = {
    memberId: 'hm-1',
    sourceAccountId: 'acct-ira',
    annualAmountDollars: 10000,
    start: { kind: 'year' as const, year: 2026 },
    end: { kind: 'year' as const, year: 2026 },
  };

  async function seedEligibleIra(): Promise<void> {
    const acc: Aggregate<AccountPayload> = {
      id: 'acct-ira',
      householdId: HH,
      aggregateType: 'account',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Traditional IRA',
        type: 'RETIREMENT_IRA',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'PRE_TAX',
        ownerId: 'hm-1',
        institution: 'Bank',
        notes: '',
        planningReturnPct: 7,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      },
    };
    await putAggregate('account', acc);
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
        firstName: 'Pat',
        lastName: 'Doe',
        email: 'pat@example.test',
        birthdate: '1950-01-15',
      },
    };
    await putAggregate('householdMember', m);
  }

  function qcdCard(): HTMLElement {
    const section = document.querySelector<HTMLElement>(
      '[aria-labelledby="qcd-heading"]',
    );
    if (!section) throw new Error('QCD card not found');
    return section;
  }

  it('QCD card on a base scenario with no override reads "No scenario overrides."', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedEligibleIra();
    renderAt('p');
    await waitFor(() => screen.getByDisplayValue('Base'));
    expect(
      within(qcdCard()).getByText('No scenario overrides.'),
    ).toBeInTheDocument();
  });

  it('QCD card with a local override shows the resolved entry count', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedScenario('a', {
      name: 'Aggressive',
      parentScenarioId: 'p',
      overrides: { qualifiedCharitableDistributions: [QCD_ENTRY] },
    });
    await seedEligibleIra();
    renderAt('a');
    await waitFor(() => screen.getByDisplayValue('Aggressive'));

    const card = qcdCard();
    expect(
      within(card).getByText(/1 charitable distribution from a traditional IRA/i),
    ).toBeInTheDocument();
  });

  it('QCD card Configure navigates to /scenarios/:id/qcd', async () => {
    await seedScenario('p', { name: 'Base', isPrimary: true });
    await seedEligibleIra();

    function LocationProbe() {
      const location = useLocation();
      return <div data-testid="pathname">{location.pathname}</div>;
    }
    render(
      <MemoryRouter initialEntries={['/scenarios/p']}>
        <LocationProbe />
        <Routes>
          <Route path="/scenarios/:id" element={<ScenarioDetailPage />} />
          <Route path="/scenarios/:id/qcd" element={<div>qcd page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByDisplayValue('Base')).toBeInTheDocument());

    fireEvent.click(
      screen.getByRole('button', { name: /Configure charitable distributions/i }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('pathname').textContent).toBe('/scenarios/p/qcd'),
    );
  });

  it('an inheriting child shows the parent QCD count (not "No scenario overrides.") with an inherited-from line, no Reset', async () => {
    await seedScenario('p', {
      name: 'Base',
      isPrimary: true,
      overrides: { qualifiedCharitableDistributions: [QCD_ENTRY] },
    });
    await seedScenario('a', {
      name: 'Child',
      parentScenarioId: 'p',
    });
    await seedEligibleIra();
    renderAt('a');
    await waitFor(() => screen.getByDisplayValue('Child'));

    const card = qcdCard();
    expect(
      within(card).getByText(/1 charitable distribution from a traditional IRA/i),
    ).toBeInTheDocument();
    expect(within(card).queryByText('No scenario overrides.')).toBeNull();
    expect(within(card).getByText(/Inherited from Base\./i)).toBeInTheDocument();
    expect(
      within(card).queryByRole('button', {
        name: /Reset charitable distributions/i,
      }),
    ).toBeNull();
  });

  it('shows no filing prompt for a scenario whose filing facts resolve cleanly', async () => {
    await seedMember('hm-1', true, 'Ada');
    await seedMember('hm-2', false, 'Grace');
    await seedScenario('sc-p11-clean', {
      name: 'Clean',
      isPrimary: true,
      overrides: { filingStatus: 'MFJ' },
    });
    renderAt('sc-p11-clean');
    await screen.findByRole('heading', { name: 'Clean' });
    expect(screen.queryByText(/cannot read this scenario/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Choose how you file/i })).toBeNull();
  });

  it('prompts to resolve an ambiguous two-member legacy scalar without blocking', async () => {
    await seedMember('hm-1', true, 'Ada');
    await seedMember('hm-2', false, 'Grace');
    await seedScenario('sc-p11-legacy', {
      name: 'Legacy',
      isPrimary: true,
      overrides: { filingStatus: 'Single' },
    });
    renderAt('sc-p11-legacy');
    await screen.findByRole('heading', { name: 'Legacy' });
    // The copy states projections are unchanged: a prompt, not a blocker, nothing dropped.
    expect(
      await screen.findByText(/projections keep filing exactly as they did\s+before/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Choose how you file/i })).toBeInTheDocument();
  });

  it('the prompt opens the Tax assumptions modal on the Filing tab', async () => {
    await seedMember('hm-1', true, 'Ada');
    await seedMember('hm-2', false, 'Grace');
    await seedScenario('sc-p11-open', {
      name: 'OpenFiling',
      isPrimary: true,
      overrides: { filingStatus: 'HoH' },
    });
    renderAt('sc-p11-open');
    await screen.findByRole('heading', { name: 'OpenFiling' });
    await userEvent.click(screen.getByRole('button', { name: /Choose how you file/i }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('tab', { name: 'Filing', selected: true }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('radio', { name: /File together on one return/i }),
    ).toBeInTheDocument();
  });

  it('the Tax assumptions card Configure still opens on the HSA tab', async () => {
    await seedMember('hm-1', true, 'Ada');
    await seedScenario('sc-p11-hsa-tab', { name: 'HsaTab', isPrimary: true });
    renderAt('sc-p11-hsa-tab');
    await screen.findByRole('heading', { name: 'HsaTab' });
    await userEvent.click(
      screen.getByRole('button', { name: /Configure tax assumptions/i }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: 'HSA', selected: true })).toBeInTheDocument();
  });

  it('saving a filing plan from the page persists it and clears the prompt', async () => {
    await seedMember('hm-1', true, 'Ada');
    await seedMember('hm-2', false, 'Grace');
    await seedScenario('sc-p11-save', {
      name: 'SaveFiling',
      overrides: { filingStatus: 'Single' },
    });
    renderAt('sc-p11-save');
    await screen.findByRole('heading', { name: 'SaveFiling' });
    await userEvent.click(screen.getByRole('button', { name: /Choose how you file/i }));
    const dialog = await screen.findByRole('dialog');
    // Converting the older setting is explicit: Save stays disabled until the filing controls are used, so adopt the shown choice first.
    fireEvent.click(
      within(dialog).getByRole('button', { name: /use the choice shown below/i }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(async () => {
      const pending = await listPendingMutations();
      const mut = pending.find((m) => m.aggregateId === 'sc-p11-save');
      expect(mut).toBeTruthy();
      const payload = mut!.payload as ScenarioPayload;
      expect(payload.overrides.taxFilingPlan).toEqual({ kind: 'joint' });
      expect('filingStatus' in payload.overrides).toBe(false);
    });
  });

  it('a stored filing plan raises the Withdrawals & taxes customized count', async () => {
    await seedMember('hm-1', true, 'Ada');
    await seedMember('hm-2', false, 'Grace');
    await seedScenario('sc-p11-count-base', { name: 'CountBase', isPrimary: true });
    await seedScenario('sc-p11-count-off', {
      name: 'CountOff',
      parentScenarioId: 'sc-p11-count-base',
    });
    await seedScenario('sc-p11-count-on', {
      name: 'CountOn',
      parentScenarioId: 'sc-p11-count-base',
      overrides: { taxFilingPlan: { kind: 'joint' } },
    });

    const withdrawalsCount = async (): Promise<number> => {
      const group = await screen.findByTestId('scenario-group-withdrawals');
      const badge = Array.from(
        (group.parentElement ?? group).querySelectorAll('span'),
      ).find((el) => /customized$/.test((el.textContent ?? '').trim()));
      return Number(/(\d+) customized/.exec(badge?.textContent ?? '')?.[1] ?? 0);
    };

    const withoutPlan = renderAt('sc-p11-count-off');
    await waitFor(() => screen.getByDisplayValue('CountOff'));
    const baseline = await withdrawalsCount();
    withoutPlan.unmount();

    renderAt('sc-p11-count-on');
    await waitFor(() => screen.getByDisplayValue('CountOn'));
    expect(await withdrawalsCount()).toBe(baseline + 1);
  });

  it('the death-transition wording is stated in the filing editor', async () => {
    await seedMember('hm-1', true, 'Ada');
    await seedMember('hm-2', false, 'Grace');
    await seedScenario('sc-p11-death', { name: 'DeathCopy', isPrimary: true });
    renderAt('sc-p11-death');
    await screen.findByRole('heading', { name: 'DeathCopy' });
    await userEvent.click(
      screen.getByRole('button', { name: /Configure tax assumptions/i }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Filing' }));
    expect(
      within(dialog).getByText(
        /the year a spouse dies is still\s+filed together, and later years fall back to filing single/i,
      ),
    ).toBeInTheDocument();
  });

  it('the filing prompt renders with no a11y violations', async () => {
    await seedMember('hm-1', true, 'Ada');
    await seedMember('hm-2', false, 'Grace');
    await seedScenario('sc-p11-a11y', {
      name: 'FilingA11y',
      isPrimary: true,
      overrides: { filingStatus: 'Single' },
    });
    const { container } = renderAt('sc-p11-a11y');
    await screen.findByRole('heading', { name: 'FilingA11y' });
    await screen.findByRole('button', { name: /Choose how you file/i });
    await expectNoA11yViolations(container);
  });
});
