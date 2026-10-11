/**
 * Component tests for the Preferences page: the Appearance theme picker
 * (a three-option icon SegmentedRadioGroup wired to useTheme). The page is the
 * slimmed-down former Profile page — security/account and data/workspace cards
 * moved to the Security and Workspace pages.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { PreferencesPage } from '../pages/PreferencesPage';

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: vi.fn(),
}));

const setThemeMock = vi.fn();
vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'system', setTheme: setThemeMock }),
}));

// Mutable so a test can flip the beta switch state / the offered list.
let mockShowBeta = false;
let mockOfferedBeta: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'projected-withdrawals', label: 'Projected withdrawals' },
  { id: 'guardrails', label: 'Guardrails today' },
];
const setShowBetaMock = vi.fn();
vi.mock('../contexts/BetaFeaturesContext', () => ({
  useBetaFeatures: () => ({
    showBetaFeatures: mockShowBeta,
    setShowBetaFeatures: setShowBetaMock,
    offeredBetaFeatures: mockOfferedBeta,
    isBetaFeatureOffered: () => mockOfferedBeta.length > 0,
    isBetaFeatureVisible: () => mockShowBeta && mockOfferedBeta.length > 0,
  }),
}));


import { useAuth } from '../auth/AuthContext';

function renderPage() {
  (useAuth as any).mockReturnValue({
    me: { id: 'u-1', email: 'me@local.test', displayName: 'Me', roles: ['member'] },
  });
  return render(<MemoryRouter><PreferencesPage /></MemoryRouter>);
}

describe('PreferencesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShowBeta = false;
    mockOfferedBeta = [
      { id: 'projected-withdrawals', label: 'Projected withdrawals' },
      { id: 'guardrails', label: 'Guardrails today' },
    ];
  });

  it('renders the Beta features card with the switch off and the disclaimer', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Beta features' }),
    ).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'Show beta features' });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/may change, or may be removed again/);
    expect(screen.queryByText(/Currently in beta/)).not.toBeInTheDocument();
  });

  it('flipping the switch writes the new preference', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    renderPage();
    await userEvent.click(await screen.findByRole('switch', { name: 'Show beta features' }));
    expect(setShowBetaMock).toHaveBeenCalledWith(true);
  });

  it('reflects a switched-on preference', async () => {
    mockShowBeta = true;
    renderPage();
    expect(
      await screen.findByRole('switch', { name: 'Show beta features' }),
    ).toBeChecked();
  });

  it('omits the Beta features card when this build offers no beta features', async () => {
    mockOfferedBeta = [];
    renderPage();
    await screen.findByRole('heading', { level: 2, name: 'Appearance' });
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Beta features' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('renders the Preferences heading and the Appearance card', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Preferences' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Appearance' }),
    ).toBeInTheDocument();
  });

  it('renders the Appearance theme picker as a SegmentedRadioGroup wired to useTheme', async () => {
    renderPage();
    const group = await screen.findByRole('radiogroup', { name: 'Theme' });
    expect(group).toBeInTheDocument();
    // Three options; the mocked theme ('system') is the checked one. The
    // icons are decorative (aria-hidden) so each accessible name is the
    // label text alone.
    expect(screen.getByRole('radio', { name: 'Light' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
  });

  it('does NOT host the security/account or data/workspace cards (those moved)', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 2, name: 'Appearance' });
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).not.toContain('Passkeys');
    expect(headings).not.toContain('Recovery key & encryption');
    expect(headings).not.toContain('Data');
    expect(headings).not.toContain('Workspace tools');
    expect(headings).not.toContain('Delete account');
  });
});
