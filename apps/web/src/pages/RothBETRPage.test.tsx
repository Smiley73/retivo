// RothBETRPage: empty state, working-years panel, retirement table, Apply dialogs and backdoor callout.
// The projection runs synchronously off `useBalanceProjectionData` (IndexedDB seeded via `loadDemoData`); `useAuth` is mocked for `householdId`.
import 'fake-indexeddb/auto';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../lib/scenario-mutations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/scenario-mutations')>();
  return { ...actual, saveScenario: vi.fn().mockResolvedValue(undefined) };
});

import { useAuth } from '../auth/AuthContext';
import { clearAllStores, listAggregates, putAggregate } from '../db/store';
import type { ScenarioPayload } from '../db/types';
import { loadDemoData } from '../lib/demo-data-loader';
import { saveScenario } from '../lib/scenario-mutations';
import { withTheme } from '../test/theme-render';
import {
  blankPrimaryMemberBirthdate,
  deleteAllHouseholdMembers,
} from '../test/household-test-helpers';
import { RothBETRPage } from './RothBETRPage';

const HH = 'hh-test';

function renderPage(): ReturnType<typeof render> {
  return render(
    withTheme(
      'light',
      <MemoryRouter initialEntries={['/roth-optimizer']}>
        <RothBETRPage />
      </MemoryRouter>,
    ),
  );
}

async function findHeader(): Promise<HTMLElement> {
  return screen.findByRole(
    'heading',
    { name: 'Roth conversion comparison', level: 1 },
    { timeout: 5000 },
  );
}

// Lower the demo Baseline's working-years taxable income so the IRA-source bracket fill lands in a low bracket below the RMD-era T_future: at least one tranche then converts and the working-years Apply button is enabled (at the demo default of $120k every tranche holds).
async function seedLowWorkingYearsIncome(): Promise<void> {
  const scenarios = (await listAggregates(
    'scenario',
  )) as Awaited<ReturnType<typeof listAggregates>>;
  const base =
    scenarios.find((s) => (s.payload as ScenarioPayload).isPrimary) ?? scenarios[0];
  const payload = base.payload as ScenarioPayload;
  await putAggregate('scenario', {
    ...base,
    payload: {
      ...payload,
      overrides: { ...payload.overrides, preRetirementTaxableIncomeDollars: 90_000 },
    },
  });
}

// Matched by exact accessible name: a case-insensitive scan over page text would fire on the page's legitimate ordinary-verb "apply" copy.
function expectNoRetiredActionLabels(): void {
  expect(screen.queryAllByRole('button', { name: 'Apply' })).toHaveLength(0);
  expect(screen.queryAllByRole('button', { name: 'Applied' })).toHaveLength(0);
  expect(screen.queryAllByRole('heading', { name: 'Apply' })).toHaveLength(0);
  expect(
    screen.queryAllByRole('heading', { name: 'Apply working-years conversions' }),
  ).toHaveLength(0);
  expect(
    screen.queryAllByRole('heading', { name: 'Apply retirement Fill window' }),
  ).toHaveLength(0);
}

describe('RothBETRPage', () => {
  beforeEach(async () => {
    (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ householdId: HH });
    await clearAllStores();
    window.localStorage.clear();
  });

  afterEach(async () => {
    await clearAllStores();
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('should_render_the_page_header_and_pro_rata_disclaimer', async () => {
    await loadDemoData({ householdId: HH, email: 'demo@example.test', displayName: 'Demo User' });
    renderPage();
    expect(await findHeader()).toBeInTheDocument();
    expect(
      await screen.findByText(/IRA pro-rata rule not modeled/i),
    ).toBeInTheDocument();
  });

  it('should_render_the_save_to_the_scenario_sentence_in_the_page_subtitle', async () => {
    // The subtitle describes the save action but is reachable from neither `expectNoRetiredActionLabels()` (buttons and headings by exact name) nor `findHeader()` (h1 only), so without this a revert to "one-click apply" would leave the suite green. Verbatim, not a loose regex.
    await loadDemoData({ householdId: HH, email: 'demo@example.test', displayName: 'Demo User' });
    const { container } = renderPage();
    await findHeader();
    const header = container.querySelector('[data-testid="page-header-title-wrap"]');
    expect(header).not.toBeNull();
    const text = header?.textContent ?? '';
    expect(text).toContain(
      'controls that save a modeled bracket-fill conversion schedule or a pre-RMD MAGI-cap Fill window to the scenario.',
    );
    expect(text).not.toContain('one-click apply');
  });

  it('should_render_the_working_years_panel_with_a_taxable_income_field', async () => {
    await loadDemoData({ householdId: HH, email: 'demo@example.test', displayName: 'Demo User' });
    renderPage();
    await findHeader();
    expect(
      await screen.findByRole('heading', { name: 'Working years', level: 2 }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Bracket headroom'),
    ).toBeInTheDocument();
  });

  it('should_render_the_retirement_years_table_card', async () => {
    await loadDemoData({ householdId: HH, email: 'demo@example.test', displayName: 'Demo User' });
    renderPage();
    await findHeader();
    expect(
      await screen.findByRole('heading', { name: 'Retirement years', level: 2 }),
    ).toBeInTheDocument();
  });

  it('should_show_the_leftover_tax_rate_as_an_editable_whole_percent_with_its_hint', async () => {
    await loadDemoData({ householdId: HH, email: 'demo@example.test', displayName: 'Demo User' });
    renderPage();
    await findHeader();
    const input = await screen.findByRole('textbox', { name: 'Leftover-tax rate percent' });
    const initial = Number((input as HTMLInputElement).value);
    expect(initial).toBeGreaterThan(0);
    expect(Number.isInteger(initial)).toBe(true);
    expect(screen.getByText(/Roth and already-taxed balances count in full/)).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, '31');
    expect((input as HTMLInputElement).value).toBe('31');
  });

  it('should_mount_the_plan_comparison_panel_after_the_retirement_years_card', async () => {
    await loadDemoData({ householdId: HH, email: 'demo@example.test', displayName: 'Demo User' });
    renderPage();
    await findHeader();
    const retirementYears = await screen.findByRole('heading', { name: 'Retirement years', level: 2 });
    const comparison = await screen.findByRole('heading', { name: 'Compare conversion plans', level: 2 });
    expect(
      retirementYears.compareDocumentPosition(comparison) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Compare conversion plans' })).toBeEnabled();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('should_surface_the_apply_working_years_action', async () => {
    await loadDemoData({ householdId: HH, email: 'demo@example.test', displayName: 'Demo User' });
    await seedLowWorkingYearsIncome();
    renderPage();
    await findHeader();
    const button = await screen.findByRole('button', {
      name: 'Save working-years conversions to scenario',
    });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'Save working-years conversions to scenario' }),
    ).toBeInTheDocument();
  });

  // Scoped action-label invariant: no action control (label, accessible name, dialog title, primary/cancel label) reads `Apply` or `Applied` in any reachable state. The positive assertions elsewhere cannot catch a control left on the old wording.
  it('should_render_no_apply_or_applied_action_label_with_the_retirement_dialog_open', async () => {
    await loadDemoData({ householdId: HH, email: 'demo@example.test', displayName: 'Demo User' });
    renderPage();
    await findHeader();

    // At the demo default every tranche holds, so the working-years control renders disabled.
    expect(
      await screen.findByRole('button', {
        name: 'Save working-years conversions to scenario',
      }),
    ).toBeDisabled();
    expectNoRetiredActionLabels();

    await userEvent.click(
      screen.getByRole('button', { name: 'Save retirement Fill window to scenario' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('heading', {
        name: 'Save retirement Fill window to scenario',
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Save to scenario' }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expectNoRetiredActionLabels();
  });

  // Same invariant over the enabled working-years control and its dialog, reachable only through the seed.
  it('should_render_no_apply_or_applied_action_label_with_the_working_years_dialog_open', async () => {
    await loadDemoData({ householdId: HH, email: 'demo@example.test', displayName: 'Demo User' });
    await seedLowWorkingYearsIncome();
    renderPage();
    await findHeader();

    const button = await screen.findByRole('button', {
      name: 'Save working-years conversions to scenario',
    });
    expect(button).toBeEnabled();
    expectNoRetiredActionLabels();

    await userEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('heading', {
        name: 'Save working-years conversions to scenario',
      }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save to scenario' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expectNoRetiredActionLabels();
  });

  it('should_write_a_preRetirementRothConversions_window_when_working_years_apply_is_confirmed', async () => {
    await loadDemoData({ householdId: HH, email: 'demo@example.test', displayName: 'Demo User' });
    await seedLowWorkingYearsIncome();
    renderPage();
    await findHeader();
    const saveMock = saveScenario as unknown as ReturnType<typeof vi.fn>;
    const button = await screen.findByRole('button', {
      name: 'Save working-years conversions to scenario',
    });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    // The target picker is source-aware, so choose the source first. The pickers are React Aria listboxes: click the trigger (by aria-label), then the option.
    await userEvent.click(within(dialog).getByLabelText('Source pre-tax account'));
    await userEvent.click(await screen.findByRole('option', { name: 'Demo Primary IRA' }));
    await userEvent.click(within(dialog).getByLabelText('Target Roth IRA'));
    await userEvent.click(await screen.findByRole('option', { name: 'Demo Primary Roth IRA' }));
    saveMock.mockClear();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save to scenario' }));
    expect(saveMock).toHaveBeenCalledTimes(1);
    const saved = saveMock.mock.calls[0][0] as {
      payload: { overrides: { preRetirementRothConversions?: unknown[] } };
    };
    const windows = saved.payload.overrides.preRetirementRothConversions ?? [];
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      sourceAccountId: expect.any(String),
      annualAmountDollars: expect.any(Number),
    });
  });

  it('should_open_the_apply_retirement_dialog_with_a_magi_line_picker', async () => {
    await loadDemoData({ householdId: HH, email: 'demo@example.test', displayName: 'Demo User' });
    renderPage();
    await findHeader();
    const button = await screen.findByRole('button', {
      name: 'Save retirement Fill window to scenario',
    });
    await userEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'Save retirement Fill window to scenario' }),
    ).toBeInTheDocument();
  });

  it('should_write_a_magiCap_Fill_window_when_retirement_apply_is_confirmed', async () => {
    await loadDemoData({ householdId: HH, email: 'demo@example.test', displayName: 'Demo User' });
    renderPage();
    await findHeader();
    const saveMock = saveScenario as unknown as ReturnType<typeof vi.fn>;
    const button = await screen.findByRole('button', {
      name: 'Save retirement Fill window to scenario',
    });
    await userEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText('Target Roth IRA'));
    await userEvent.click(await screen.findByRole('option', { name: 'Demo Primary Roth IRA' }));
    saveMock.mockClear();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save to scenario' }));
    expect(saveMock).toHaveBeenCalledTimes(1);
    const saved = saveMock.mock.calls[0][0] as {
      payload: { overrides: { magiCap?: { windows?: unknown[] } } };
    };
    const windows = saved.payload.overrides.magiCap?.windows ?? [];
    expect(windows.length).toBeGreaterThanOrEqual(1);
  });

  it('should_commit_the_taxable_income_edit_once_on_blur_not_per_keystroke', async () => {
    await loadDemoData({ householdId: HH, email: 'demo@example.test', displayName: 'Demo User' });
    renderPage();
    await findHeader();
    const field = await screen.findByLabelText(/Your current taxable income/i);
    const saveMock = saveScenario as unknown as ReturnType<typeof vi.fn>;
    saveMock.mockClear();
    await userEvent.click(field);
    await userEvent.keyboard('{Control>}a{/Control}{Backspace}');
    await userEvent.type(field, '90000');
    // Per-keystroke typing must not queue a save (blur-commit).
    expect(saveMock).not.toHaveBeenCalled();
    await userEvent.tab(); // blur commits exactly one save
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it('should_show_an_empty_state_when_no_scenario_is_resolvable', async () => {
    renderPage();
    await findHeader();
    expect(
      await screen.findByText(/Select a scenario with a primary member/i),
    ).toBeInTheDocument();
  });

  it('should_show_the_empty_state_when_the_scenario_has_no_primary_member', async () => {
    // With every household member removed the runner raises NoPrimaryRetirementError; the page must collapse that to the empty state, not re-throw to ErrorBoundary.
    await loadDemoData({ householdId: HH, email: 'demo@example.test', displayName: 'Demo User' });
    await deleteAllHouseholdMembers();
    renderPage();
    await findHeader();
    expect(
      await screen.findByText(/Select a scenario with a primary member/i),
    ).toBeInTheDocument();
  });

  it('should_show_the_empty_state_when_the_primary_member_has_no_resolvable_retirement_date', async () => {
    // A blank birthdate leaves `resolveMemberRetirementDates` unable to compute a retirement date, so the runner raises NoPrimaryRetirementError via the same `!primaryRetIso` branch; same empty state, not ErrorBoundary.
    await loadDemoData({ householdId: HH, email: 'demo@example.test', displayName: 'Demo User' });
    await blankPrimaryMemberBirthdate();
    renderPage();
    await findHeader();
    expect(
      await screen.findByText(/Select a scenario with a primary member/i),
    ).toBeInTheDocument();
  });
});
