// GuardrailsPage with the vm mocked: verdict mapping, PoS-temper display, config summary, empty states and Check-now wiring.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { GuardrailsPage } from './GuardrailsPage';
import type { GuardrailsVm } from './use-guardrails-vm';
import { expectNoA11yViolations } from '../test/a11y';

let vm: GuardrailsVm;
vi.mock('./use-guardrails-vm', () => ({
  useGuardrailsVm: () => vm,
}));

vi.mock('./use-balance-projection-data', () => ({
  useBalanceProjectionData: () => ({
    scenarios: [{ id: 's1', payload: { name: 'Base' } }],
    selectedScenarioId: 's1',
  }),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <GuardrailsPage />
    </MemoryRouter>,
  );
}

const readyBase = {
  status: 'ready' as const,
  scenarioId: 's1',
  config: {
    enabled: true,
    lowerBandPct: 85,
    upperBandPct: 115,
    stepPct: 10,
    maxRaisePct: 100,
    discretionaryFloorPct: 50,
    usingDefaults: false,
  },
  portfolioNominal: 1_000_000,
  ratio: 1.1,
  verdict: 'hold' as const,
  temperedVerdict: 'hold' as const,
  pos: { kind: 'idle' as const },
  posProgressDone: 0,
  posProgressTotal: 0,
  checkNow: vi.fn(),
};

beforeEach(() => {
  vm = { ...readyBase, checkNow: vi.fn() };
});

describe('GuardrailsPage — config summary + verdict mapping', () => {
  it('should_show_all_five_tunables_plus_enabled', () => {
    renderPage();
    expect(screen.getByText('On in projections')).toBeInTheDocument();
    expect(screen.getByText('Lower range')).toBeInTheDocument();
    expect(screen.getByText('Upper range')).toBeInTheDocument();
    expect(screen.getByText('85%')).toBeInTheDocument();
    expect(screen.getByText('115%')).toBeInTheDocument();
    expect(screen.getByText('Step size')).toBeInTheDocument();
    expect(screen.getByText('Increase cap')).toBeInTheDocument();
    expect(screen.getByText('Discretionary floor')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('should_label_default_thresholds_when_unconfigured', () => {
    vm = { ...readyBase, config: { ...readyBase.config, usingDefaults: true }, checkNow: vi.fn() };
    renderPage();
    expect(screen.getByText(/using the default thresholds/i)).toBeInTheDocument();
  });

  it('should_render_a_hold_verdict', () => {
    renderPage();
    expect(screen.getByText('Within the selected funded range')).toBeInTheDocument();
    expect(screen.getByText('110%')).toBeInTheDocument();
  });

  it('should_render_a_cut_verdict', () => {
    vm = { ...readyBase, ratio: 0.8, verdict: 'cut', temperedVerdict: 'cut', checkNow: vi.fn() };
    renderPage();
    expect(screen.getByText('Below the selected funded range')).toBeInTheDocument();
    expect(
      screen.getByText(/at or below the lower edge of your selected range/i),
    ).toBeInTheDocument();
  });

  it('should_render_a_raise_verdict', () => {
    vm = { ...readyBase, ratio: 1.4, verdict: 'raise', temperedVerdict: 'raise', checkNow: vi.fn() };
    renderPage();
    expect(screen.getByText('Above the selected funded range')).toBeInTheDocument();
  });

  it('should_render_the_covered_state_for_a_null_ratio', () => {
    vm = { ...readyBase, ratio: null, verdict: 'covered', temperedVerdict: 'covered', checkNow: vi.fn() };
    renderPage();
    expect(
      screen.getByText('Guaranteed income covers your spending'),
    ).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('should_show_the_temper_note_when_a_raise_is_downgraded_to_hold', () => {
    vm = {
      ...readyBase,
      ratio: 1.4,
      verdict: 'raise',
      temperedVerdict: 'hold',
      pos: { kind: 'ready', successProbabilityPct: 62 },
      checkNow: vi.fn(),
    };
    renderPage();
    // Range position reflects the raw verdict; tempering only drives the MC-context Alert.
    expect(screen.getByText('Above the selected funded range')).toBeInTheDocument();
    expect(screen.getByText(/only 62%/i)).toBeInTheDocument();
    // The range-position body reflects the raw verdict: at/above the upper edge, never the tempered 'hold' body that would claim it falls between the edges.
    expect(
      screen.getByText(
        'Your funded ratio is 140% — at or above the upper edge of your selected range (115%).',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/between the lower/i)).not.toBeInTheDocument();
  });

  it('should_render_the_inline_disclaimer_in_the_ready_state', () => {
    renderPage();
    expect(
      screen.getByLabelText('Guardrails disclaimer'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/statistical, hypothetical estimate/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not a direction to change\s+your spending or investments/i),
    ).toBeInTheDocument();
  });
});

describe('GuardrailsPage — Check now', () => {
  it('should_call_checkNow_on_click', () => {
    const checkNow = vi.fn();
    vm = { ...readyBase, checkNow };
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(checkNow).toHaveBeenCalledTimes(1);
  });

  it('should_disable_the_button_and_show_checking_while_pending', () => {
    vm = { ...readyBase, pos: { kind: 'pending' }, checkNow: vi.fn() };
    renderPage();
    const btn = screen.getByRole('button', { name: 'Checking…' });
    expect(btn).toBeDisabled();
  });

  it('should_show_a_determinate_progress_bar_while_pending', () => {
    vm = {
      ...readyBase,
      pos: { kind: 'pending' },
      posProgressDone: 4_000,
      posProgressTotal: 10_000,
      checkNow: vi.fn(),
    };
    renderPage();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '4000');
    expect(bar).toHaveAttribute('aria-valuemax', '10000');
  });

  it('should_show_an_indeterminate_progress_bar_before_the_first_progress_report', () => {
    vm = {
      ...readyBase,
      pos: { kind: 'pending' },
      posProgressDone: 0,
      posProgressTotal: 0,
      checkNow: vi.fn(),
    };
    renderPage();
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
  });

  it('should_show_the_probability_of_success_when_ready', () => {
    vm = { ...readyBase, pos: { kind: 'ready', successProbabilityPct: 84 }, checkNow: vi.fn() };
    renderPage();
    expect(screen.getByText('84%')).toBeInTheDocument();
  });

  it('should_show_a_timed_out_message', () => {
    vm = { ...readyBase, pos: { kind: 'timed-out' }, checkNow: vi.fn() };
    renderPage();
    expect(screen.getByText(/took too long/i)).toBeInTheDocument();
  });

  it('should_show_an_error_message', () => {
    vm = { ...readyBase, pos: { kind: 'error' }, checkNow: vi.fn() };
    renderPage();
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });
});

describe('GuardrailsPage — empty states', () => {
  it('should_render_loading', () => {
    vm = { status: 'loading' };
    renderPage();
    expect(screen.getByText(/loading your guardrails/i)).toBeInTheDocument();
  });

  it('should_render_not_yet_retired_with_the_year', () => {
    vm = { status: 'not-yet-retired', retirementYear: 2030 };
    renderPage();
    expect(screen.getByText(/retires in 2030/i)).toBeInTheDocument();
  });

  it('should_render_no_accounts_with_a_link', () => {
    vm = { status: 'no-accounts' };
    renderPage();
    expect(
      screen.getByRole('link', { name: /go to account balances/i }),
    ).toHaveAttribute('href', '/account-balances');
  });

  it('should_render_scenario_not_configured_with_an_editor_link', () => {
    vm = { status: 'scenario-not-configured' };
    renderPage();
    expect(
      screen.getByRole('link', { name: /open the scenario editor/i }),
    ).toHaveAttribute('href', '/scenarios/s1');
  });
});

describe('GuardrailsPage — a11y', () => {
  it('should_have_no_axe_violations_in_the_ready_state', async () => {
    const { container } = renderPage();
    await expectNoA11yViolations(container);
  });
});
