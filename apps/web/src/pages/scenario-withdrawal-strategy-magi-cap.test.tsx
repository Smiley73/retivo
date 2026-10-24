// MagiCapSection window-schedule editor: toggle, per-window controls, add/remove, required-ceiling and overlap validation, the Fill-no-target-Roth notice and the cliff warning from live calibration.
import 'fake-indexeddb/auto';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MagiCapSection } from './scenario-withdrawal-strategy-magi-cap';
import userEvent from '@testing-library/user-event';
import { expectNoA11yViolations } from '../test/a11y';
import { buildNextMagiCap } from '../lib/magi-cap-persistence';
import { buildSuggestionCapWindows } from '../lib/roth-betr-apply-helpers';
import { magiCapWindowsSaveError } from './scenario-withdrawal-strategy-magi-cap-validation';
import type { MagiCapSectionProps } from './scenario-withdrawal-strategy-magi-cap';
import type { DraftMagiCapWindow } from './scenario-withdrawal-strategy-shared';
import type { Aggregate, HouseholdMemberPayload } from '../db/types';

function member(
  id: string,
  isPrimary: boolean,
  birthdate: string,
): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: 'hh',
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'd',
    payload: {
      isPrimary,
      firstName: isPrimary ? 'Pat' : 'Sam',
      lastName: 'Doe',
      email: '',
      birthdate,
    },
  };
}

const PRIMARY = member('m1', true, '1980-01-01');

function win(over: Partial<DraftMagiCapWindow> = {}): DraftMagiCapWindow {
  return {
    start: { kind: 'retirementStart' },
    end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
    magiCeilingAnnualDollars: 50_000,
    capMode: 'minimize',
    capMagiLine: 'irmaa',
    ...over,
  };
}

function makeProps(overrides: Partial<MagiCapSectionProps> = {}): MagiCapSectionProps {
  return {
    enabled: false,
    windows: [],
    members: [PRIMARY],
    retirementAnchor: { retirementYear: 2045, retirementMonth0: 0 },
    rothAccounts: [],
    onToggle: vi.fn(),
    onWindowsChange: vi.fn(),
    ...overrides,
  };
}

describe('MagiCapSection — toggle', () => {
  it('fires onToggle when the switch is clicked', () => {
    const onToggle = vi.fn();
    render(<MagiCapSection {...makeProps({ onToggle })} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('renders no window controls when enabled is false', () => {
    render(<MagiCapSection {...makeProps({ enabled: false })} />);
    expect(screen.queryByLabelText(/annual max window/i)).toBeNull();
  });
});

describe('MagiCapSection — a saved Roth conversion plan', () => {
  // 25 single-year Fill windows, 2031 through 2055, as a saved suggestion writes them.
  const saved = buildSuggestionCapWindows(
    Array.from({ length: 25 }, (_, i) => ({
      start: { kind: 'year' as const, year: 2031 + i },
      end: { kind: 'year' as const, year: 2031 + i },
      magiCeilingAnnualDollars: 150_000 + i * 1_000,
      capMode: 'fill' as const,
      capMagiLine: 'irmaa' as const,
      targetRothAccountId: 'roth-1',
    })),
  );
  const rothAccounts = [{ id: 'roth-1', name: 'Roth IRA' }];

  it('labels every tab by its year and reaches each one with the arrow keys', async () => {
    const user = userEvent.setup();
    render(
      <MagiCapSection {...makeProps({ enabled: true, windows: saved, rothAccounts })} />,
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(
      Array.from({ length: 25 }, (_, i) => String(2031 + i)),
    );
    tabs[0].focus();
    for (let i = 1; i < tabs.length; i += 1) {
      await user.keyboard('{ArrowRight}');
      expect(tabs[i]).toHaveFocus();
      expect(tabs[i]).toHaveAttribute('aria-selected', 'true');
    }
    expect(screen.getByLabelText(/annual max window 25/i)).toHaveValue('174000.00');
  });

  it('opens and saves back unchanged: the save gate is clear and the same ladder is written', () => {
    expect(
      magiCapWindowsSaveError(saved, [PRIMARY], { retirementYear: 2028, retirementMonth0: 0 }),
    ).toBeNull();
    const fragment = buildNextMagiCap({
      magiCapEnabled: true,
      magiCapWindows: saved,
      localOverrides: { magiCap: { windows: saved } },
      parentCap: undefined,
    });
    expect(fragment).toEqual({ magiCap: { windows: saved } });
  });
});

describe('MagiCapSection — window tabs', () => {
  it('labels each tab with its resolved year span, or "From <year>" when only the start resolves', () => {
    const ranged = win({
      start: { kind: 'year', year: 2050 },
      end: { kind: 'year', year: 2055 },
    });
    render(
      <MagiCapSection {...makeProps({ enabled: true, windows: [ranged, win()] })} />,
    );
    // The first window resolves to a full span; the default win() collapses to a zero-length interval here (retirement 2045 ≈ primary age 65), so its tab surfaces the start year rather than falling back to "Window N".
    expect(screen.getByRole('tab', { name: '2050 - 2055' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'From 2045' })).toBeTruthy();
  });

  it('renders only the active window panel (tabbed, not stacked)', () => {
    render(
      <MagiCapSection {...makeProps({ enabled: true, windows: [win(), win()] })} />,
    );
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getAllByLabelText(/annual max window/i)).toHaveLength(1);
  });

  it('switches the visible panel when another tab is selected', () => {
    // End-year anchors are inclusive (interval [start, year+1)), so the tab label's last year equals the entered end year.
    const a = win({ start: { kind: 'year', year: 2050 }, end: { kind: 'year', year: 2055 } });
    const b = win({ start: { kind: 'year', year: 2056 }, end: { kind: 'year', year: 2060 } });
    render(<MagiCapSection {...makeProps({ enabled: true, windows: [a, b] })} />);
    expect(screen.getByLabelText(/annual max window 1/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '2056 - 2060' }));
    expect(screen.getByLabelText(/annual max window 2/i)).toBeTruthy();
    expect(screen.queryByLabelText(/annual max window 1/i)).toBeNull();
  });

  it('adds a window when "Add another window" is pressed', () => {
    const onWindowsChange = vi.fn();
    render(
      <MagiCapSection {...makeProps({ enabled: true, windows: [win()], onWindowsChange })} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /add another window/i }));
    expect(onWindowsChange).toHaveBeenCalledOnce();
    expect(onWindowsChange.mock.calls[0][0]).toHaveLength(2);
  });

  it('removes the active window when its Remove button is pressed', () => {
    const onWindowsChange = vi.fn();
    render(
      <MagiCapSection
        {...makeProps({ enabled: true, windows: [win(), win()], onWindowsChange })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove window 1/i }));
    expect(onWindowsChange.mock.calls[0][0]).toHaveLength(1);
  });

  it('allows removing the only window (an empty ladder persists as no cap)', () => {
    const onWindowsChange = vi.fn();
    render(
      <MagiCapSection {...makeProps({ enabled: true, windows: [win()], onWindowsChange })} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove window 1/i }));
    expect(onWindowsChange.mock.calls[0][0]).toHaveLength(0);
  });

  it('shows no tabs but keeps the Add button when the ladder is empty', () => {
    render(<MagiCapSection {...makeProps({ enabled: true, windows: [] })} />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /add another window/i })).toBeTruthy();
  });
});

describe('MagiCapSection — validation notices', () => {
  it('shows the required-ceiling hint for a window with no ceiling', () => {
    render(
      <MagiCapSection
        {...makeProps({ enabled: true, windows: [win({ magiCeilingAnnualDollars: null })] })}
      />,
    );
    expect(screen.getByText(/enter an annual cap to save/i)).toBeTruthy();
  });

  it('shows the non-overlap error when two windows overlap', () => {
    const a = win({
      start: { kind: 'year', year: 2050 },
      end: { kind: 'year', year: 2056 },
    });
    const b = win({
      start: { kind: 'year', year: 2054 },
      end: { kind: 'year', year: 2060 },
    });
    render(
      <MagiCapSection {...makeProps({ enabled: true, windows: [a, b] })} />,
    );
    expect(screen.getByText(/cap windows must not overlap/i)).toBeTruthy();
  });

  it('does NOT show the overlap error for adjacent windows (endYear === next.startYear)', () => {
    const a = win({
      start: { kind: 'year', year: 2050 },
      end: { kind: 'year', year: 2054 },
    });
    const b = win({
      start: { kind: 'year', year: 2055 },
      end: { kind: 'year', year: 2060 },
    });
    render(
      <MagiCapSection {...makeProps({ enabled: true, windows: [a, b] })} />,
    );
    expect(screen.queryByText(/cap windows must not overlap/i)).toBeNull();
  });

  it('shows the Fill-no-target notice for a Fill window with no target Roth', () => {
    render(
      <MagiCapSection
        {...makeProps({
          enabled: true,
          windows: [win({ capMode: 'fill', targetRothAccountId: undefined })],
          rothAccounts: [{ id: 'roth-1', name: 'My Roth' }],
        })}
      />,
    );
    expect(screen.getByText(/fills the cap with withdrawals only/i)).toBeTruthy();
  });

  it('shows the Fill-no-target notice when the saved target is no longer eligible', () => {
    // A window saved against an account that has since left the eligible list (e.g. an inherited Roth IRA, which `findTargetRothIndex` refuses) converts $0 just like an unset target.
    render(
      <MagiCapSection
        {...makeProps({
          enabled: true,
          windows: [win({ capMode: 'fill', targetRothAccountId: 'inherited-roth' })],
          rothAccounts: [{ id: 'roth-1', name: 'My Roth' }],
        })}
      />,
    );
    expect(screen.getByText(/fills the cap with withdrawals only/i)).toBeTruthy();
  });

  it('hides the Fill-no-target notice when the target is an eligible account', () => {
    render(
      <MagiCapSection
        {...makeProps({
          enabled: true,
          windows: [win({ capMode: 'fill', targetRothAccountId: 'roth-1' })],
          rothAccounts: [{ id: 'roth-1', name: 'My Roth' }],
        })}
      />,
    );
    expect(screen.queryByText(/fills the cap with withdrawals only/i)).toBeNull();
  });
});

describe('MagiCapSection — cliff warning', () => {
  it.each([
    ['irmaa', /first Medicare IRMAA surcharge bracket/],
    ['aca', /ACA 400%-of-poverty line/],
  ] as const)('warns when the %s cap sits above the live cliff threshold', (capMagiLine, text) => {
    render(
      <MagiCapSection
        {...makeProps({ enabled: true, windows: [win({ capMagiLine, magiCeilingAnnualDollars: 1_000_000 })] })}
      />,
    );
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('shows no warning when the cap is below the threshold', () => {
    render(<MagiCapSection {...makeProps({ enabled: true, windows: [win()] })} />);
    expect(screen.queryByText(/sits above the/)).toBeNull();
  });
});

describe('MagiCapSection — a11y', () => {
  it('has no a11y violations in the validation-error (overlap) state', async () => {
    const a = win({ start: { kind: 'year', year: 2050 }, end: { kind: 'year', year: 2056 } });
    const b = win({ start: { kind: 'year', year: 2054 }, end: { kind: 'year', year: 2060 } });
    const { container } = render(
      <MagiCapSection {...makeProps({ enabled: true, windows: [a, b] })} />,
    );
    await expectNoA11yViolations(container);
  });
});
