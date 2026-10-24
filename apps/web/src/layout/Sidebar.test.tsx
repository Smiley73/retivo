// React Aria `Disclosure` navigation: collapsible sections, `aria-current="page"` on the active route, state preserved across a toggle and an axe smoke. Uses user-event, which the disclosure's press model needs.
import 'fake-indexeddb/auto';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllStores } from '../db/store';
import { BRAND_MARK_URL, REPO_URL } from '../lib/brand';
import { expectNoA11yViolations } from '../test/a11y';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));
// Beta features default to visible so the nav assertions cover the beta items; the hidden state has its own tests.
let mockBetaVisible = true;
vi.mock('../contexts/BetaFeaturesContext', () => ({
  useBetaFeatures: () => ({
    showBetaFeatures: mockBetaVisible,
    setShowBetaFeatures: vi.fn(),
    offeredBetaFeatures: [],
    isBetaFeatureOffered: () => true,
    isBetaFeatureVisible: () => mockBetaVisible,
  }),
}));
// The assistant session the connected indicator reads; `null` is the no-session shell.
const assistantMock = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../assistant/AssistantContext', () => ({
  useOptionalAssistant: () => assistantMock.value,
  useAssistant: () => assistantMock.value,
}));
import { useAuth } from '../auth/AuthContext';
import { assistantValue } from '../test/assistant-context';
import { useSync } from '../sync/SyncContext';
import { Sidebar } from './Sidebar';

function renderSidebar(
  initialPath = '/dashboard',
  opts: { drawer?: boolean } = {},
): ReturnType<typeof render> {
  (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    householdId: 'hh-1',
    isAuthenticated: true,
    me: { id: 'u-1', displayName: 'Sam Saver', roles: ['member'] },
  });
  (useSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    state: { kind: 'synced', lastSyncedAt: null },
    forceRefresh: vi.fn(),
    retryNow: vi.fn(),
  });
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Sidebar
        onItemClick={() => {}}
        onSignOut={() => {}}
        drawer={opts.drawer ?? false}
      />
    </MemoryRouter>,
  );
}

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBetaVisible = true;
    assistantMock.value = null;
  });

  afterEach(async () => {
    await clearAllStores();
  });

  it.each([
    ['desktop', false],
    ['mobile drawer', true],
  ])('uses the shared decorative brand mark in the %s variant', (_name, drawer) => {
    const { container } = renderSidebar('/dashboard', { drawer });
    const mark = container.querySelector(`img[src="${BRAND_MARK_URL}"]`);
    expect(mark).toHaveAttribute('alt', '');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders the open-source line in the default (desktop) column', () => {
    renderSidebar();
    const link = screen.getByRole('link', { name: 'RETIVO is open source' });
    expect(link).toHaveAttribute('href', REPO_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAccessibleDescription('Opens in a new tab');
  });

  it('renders the open-source line in the mobile drawer too', () => {
    renderSidebar('/dashboard', { drawer: true });
    expect(
      screen.getByRole('link', { name: 'RETIVO is open source' }),
    ).toHaveAttribute('href', REPO_URL);
  });

  it('renders the collapsible sections as expandable disclosure groups', () => {
    renderSidebar();
    const planning = screen.getByRole('button', { name: 'Planning' });
    expect(planning).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByRole('button', { name: 'Projections' }),
    ).toBeInTheDocument();
  });

  it('collapses every section except Planning by default', () => {
    renderSidebar();
    expect(
      screen.getByRole('button', { name: 'Planning' }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByRole('button', { name: 'Your Data' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.getByRole('button', { name: 'Settings' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.getByRole('button', { name: 'Help & Info' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('button', { name: 'Accounts' }),
    ).not.toBeInTheDocument();
  });

  it('auto-expands the section that holds the active route on load', () => {
    renderSidebar('/security');
    expect(
      screen.getByRole('button', { name: 'Settings' }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByRole('button', { name: 'Security' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      screen.getByRole('button', { name: 'Your Data' }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('collapses and re-expands a section on its header', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const planning = screen.getByRole('button', { name: 'Planning' });
    expect(
      screen.getByRole('button', { name: 'Projections' }),
    ).toBeInTheDocument();

    await user.click(planning);
    expect(planning).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('button', { name: 'Projections' }),
    ).not.toBeInTheDocument();

    await user.click(planning);
    expect(planning).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByRole('button', { name: 'Projections' }),
    ).toBeInTheDocument();
  });

  it('marks the active route with aria-current="page"', () => {
    renderSidebar('/accounts');
    const accounts = screen.getByRole('button', { name: 'Accounts' });
    expect(accounts).toHaveAttribute('aria-current', 'page');
    expect(
      screen.getByRole('button', { name: 'Projections' }),
    ).not.toHaveAttribute('aria-current');
  });

  it('preserves the active-route state when a section is toggled', async () => {
    const user = userEvent.setup();
    renderSidebar('/accounts');
    expect(
      screen.getByRole('button', { name: 'Accounts' }),
    ).toHaveAttribute('aria-current', 'page');
    const settings = screen.getByRole('button', { name: 'Settings' });
    await user.click(settings);
    await user.click(settings);
    expect(
      screen.getByRole('button', { name: 'Accounts' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('has no a11y violations', async () => {
    const { container } = renderSidebar();
    await expectNoA11yViolations(container);
  });

  it('marks the Report nav item as active at /report', () => {
    renderSidebar('/report');
    const report = screen.getByRole('button', { name: 'Report' });
    expect(report).toHaveAttribute('aria-current', 'page');
  });

  it('renders the Guardrails nav item and marks it active at /guardrails (exact match, no matchWhen)', () => {
    // The accessible name carries the "Beta" pill ("Guardrails (beta)").
    renderSidebar('/guardrails');
    const guardrails = screen.getByRole('button', { name: 'Guardrails today (beta)' });
    expect(guardrails).toBeInTheDocument();
    expect(guardrails).toHaveAttribute('aria-current', 'page');
    expect(
      screen.getByRole('button', { name: 'Report' }),
    ).not.toHaveAttribute('aria-current');
  });

  it('no longer lists the Retirement Readiness page (removed)', () => {
    renderSidebar('/dashboard');
    expect(
      screen.queryByRole('button', { name: /Retirement Readiness/ }),
    ).not.toBeInTheDocument();
  });

  it('badges each beta item with "Beta" while beta features are visible', () => {
    renderSidebar('/dashboard');
    expect(
      screen.getByRole('button', { name: 'Projected withdrawals (beta)' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardrails today (beta)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Report' })).toBeInTheDocument();
  });

  it('sorts every beta item to the bottom of its section, below all stable items', () => {
    renderSidebar('/dashboard');
    // Beta buttons carry a visible "Beta" pill in their textContent besides the sr-only suffix, so match by prefix.
    const planningItemLabels = [
      'Projections',
      'Scenarios',
      'Social Security claim-age',
      'Roth conversion comparison',
      'Projected withdrawals (beta)',
      'Report',
      'Guardrails today (beta)',
    ];
    const planningLabels = screen
      .getAllByRole('button')
      .map((button) => button.textContent)
      .filter((text): text is string => text !== null)
      .filter((text) => planningItemLabels.some((label) => text.startsWith(label)))
      .map((text) => planningItemLabels.find((label) => text.startsWith(label))!);
    expect(planningLabels).toEqual([
      'Projections',
      'Scenarios',
      'Social Security claim-age',
      'Roth conversion comparison',
      'Report',
      'Projected withdrawals (beta)',
      'Guardrails today (beta)',
    ]);
  });

  it('hides the beta items entirely while beta features are hidden', () => {
    mockBetaVisible = false;
    renderSidebar('/dashboard');
    expect(screen.queryByRole('button', { name: /Guardrails/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Projected withdrawals/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Report' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Projections' })).toBeInTheDocument();
  });

  it('marks the Roth conversion comparison nav item as active at /roth-optimizer', () => {
    renderSidebar('/roth-optimizer');
    expect(
      screen.getByRole('button', { name: 'Roth conversion comparison' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('marks the Income nav item as active at /income/scenario-entry', () => {
    renderSidebar('/income/scenario-entry?scenarioId=scn-1');
    expect(
      screen.getByRole('button', { name: 'Income' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('marks the Expenses nav item as active at /expenses/scenario-entry', () => {
    renderSidebar('/expenses/scenario-entry?scenarioId=scn-1');
    expect(
      screen.getByRole('button', { name: 'Expenses' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('marks the Scenarios nav item as active at /scenarios/:id/withdrawal-strategy', () => {
    renderSidebar('/scenarios/scn-1/withdrawal-strategy');
    expect(
      screen.getByRole('button', { name: 'Scenarios' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('marks the Scenarios nav item as active at /scenarios/:id/inflation', () => {
    renderSidebar('/scenarios/scn-1/inflation');
    expect(
      screen.getByRole('button', { name: 'Scenarios' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('marks the Scenarios nav item as active at /scenarios/:id/qcd', () => {
    renderSidebar('/scenarios/scn-1/qcd');
    expect(
      screen.getByRole('button', { name: 'Scenarios' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('marks the Scenarios nav item as active at /scenarios/:id/floors (Account limits)', () => {
    renderSidebar('/scenarios/scn-1/floors');
    expect(
      screen.getByRole('button', { name: 'Scenarios' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('does NOT mark the Scenarios nav item active on a non-scenario route', () => {
    renderSidebar('/dashboard');
    expect(
      screen.getByRole('button', { name: 'Dashboard' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      screen.getByRole('button', { name: 'Scenarios' }),
    ).not.toHaveAttribute('aria-current');
  });

  it('renders the four top-level sections (Planning / Your Data / Settings / Help & Info)', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Planning' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Your Data' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Help & Info' })).toBeInTheDocument();
  });

  it("renders the What's New item and marks it active at /whats-new", () => {
    renderSidebar('/whats-new');
    const whatsNew = screen.getByRole('button', { name: "What's New" });
    expect(whatsNew).toBeInTheDocument();
    expect(whatsNew).toHaveAttribute('aria-current', 'page');
  });

  it("Help & Info contains only What's New", () => {
    renderSidebar('/whats-new');
    const group = screen.getByRole('group', { name: 'Help & Info' });
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(["What's New"]);
  });

  it('renders the Settings section items (Preferences / Security / Workspace) and no Developer entry', () => {
    renderSidebar('/security');
    expect(screen.getByRole('button', { name: 'Preferences' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Security' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Workspace' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Developer' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Profile' }),
    ).not.toBeInTheDocument();
  });

  it('marks the Security nav item active at /security', () => {
    renderSidebar('/security');
    expect(
      screen.getByRole('button', { name: 'Security' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('marks the Workspace nav item active at /workspace', () => {
    renderSidebar('/workspace');
    expect(
      screen.getByRole('button', { name: 'Workspace' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  describe('assistant indicator', () => {
    it('adds nothing without a session', () => {
      renderSidebar();
      expect(screen.queryByRole('button', { name: 'Disconnect assistant' })).not.toBeInTheDocument();
    });

    it('shows beside the sync badge in the desktop column', () => {
      assistantMock.value = assistantValue();
      renderSidebar();
      expect(screen.getByRole('button', { name: /^Assistant connected, reported as Claude Code/ })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Disconnect assistant' })).toHaveLength(1);
    });

    it('is left out of the mobile drawer', () => {
      assistantMock.value = assistantValue();
      renderSidebar('/dashboard', { drawer: true });
      expect(screen.queryByRole('button', { name: 'Disconnect assistant' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Assistant connected/ })).not.toBeInTheDocument();
    });

    it('moves focus to the first navigation button when Disconnect is pressed', async () => {
      const user = userEvent.setup();
      assistantMock.value = assistantValue();
      renderSidebar();
      await user.click(screen.getByRole('button', { name: 'Disconnect assistant' }));
      expect(screen.getByRole('button', { name: 'Dashboard' })).toHaveFocus();
    });
  });
});
