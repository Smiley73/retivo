/**
 * WorkingYearsPanel — needs-input vs populated render, and the
 * per-source drag rule so taxEfficient (10%) and taxInefficient (25%) stay
 * distinct when neither is the page-selected source.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { withTheme } from '../../test/theme-render';
import { WorkingYearsPanel } from './WorkingYearsPanel';
import type { WorkingYearsBETRSummary } from '../../lib/betr-calculator';

const SUMMARY: WorkingYearsBETRSummary = {
  bracketHeadroomCents: 50_000_00,
  T_future: 0.24,
  rmdTriggerAge: 73,
  tranches: [{ amountCents: 50_000_00, T_now: 0.22, betr: 0.22, verdict: 'convert' }],
  convertTotalCents: 50_000_00,
};

function renderPanel(props: Partial<React.ComponentProps<typeof WorkingYearsPanel>> = {}): void {
  render(
    withTheme(
      'light',
      <WorkingYearsPanel
        summary={SUMMARY}
        taxableIncomeDollars={100_000}
        onTaxableIncomeChange={vi.fn()}
        onTaxableIncomeCommit={vi.fn()}
        yearsToRetirement={15}
        source="ira"
        dragPct={10}
        {...props}
      />,
    ),
  );
}

describe('WorkingYearsPanel', () => {
  it('renders the needs-input Alert and no Bracket headroom stat when income is absent', () => {
    renderPanel({ taxableIncomeDollars: undefined });
    expect(
      screen.getByText(/Enter your current taxable income above/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Bracket headroom')).not.toBeInTheDocument();
  });

  it('renders the populated headroom + four-source BETR list when income is present', () => {
    renderPanel();
    expect(screen.getByText('Bracket headroom')).toBeInTheDocument();
    expect(screen.getByText('Taxable account (lower default tax drag)')).toBeInTheDocument();
    expect(screen.getByText('Taxable account (higher default tax drag)')).toBeInTheDocument();
  });

  it('shows a before→after-59½ split + owner-named footnote on the IRA row when a boundary is set', () => {
    renderPanel({ iraOwnerBoundary: { year: 2030, firstName: 'Robin' } });
    const iraRow = screen.getByText('Pay tax from the IRA').closest('li');
    expect(iraRow).not.toBeNull();
    // Both the penalized "before" and the plain "after" halves render.
    expect(iraRow!.textContent).toMatch(/before 59½/);
    expect(iraRow!.textContent).toMatch(/after 59½/);
    // Footnote names the affected owner without implying they are the only one.
    expect(screen.getByText(/including Robin/)).toBeInTheDocument();
    // The other three source rows keep their single-value rendering.
    const efficientRow = screen.getByText('Taxable account (lower default tax drag)').closest('li');
    expect(efficientRow!.textContent).not.toMatch(/before 59½/);
  });

  it('keeps the outside-funds sentence and the §72(t) IRA-exception clause verbatim', () => {
    // The footnote holds one renamed sentence and one legitimate ordinary-verb
    // use of "apply" that a later Apply-sweep must not "correct". Both are
    // pinned as exact substrings so either edit fails here.
    renderPanel({ iraOwnerBoundary: { year: 2030, firstName: 'Robin' } });
    const footnote = screen.getByText(/including Robin/).closest('p');
    expect(footnote).not.toBeNull();
    const text = (footnote!.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain(
      'The modeled amount assumes the tax is paid from outside funds, so the written conversion is unpenalized regardless of the from-IRA rate shown here.',
    );
    // The rename replaces only the phrase `Apply amount assumes`; replacing the
    // whole sentence leaves the sentence's own leading "The" behind.
    expect(text).not.toContain('The The modeled amount');
    expect(text).toContain(
      'the age-55 separation-from-service exception does not apply to IRAs',
    );
  });

  it('renders the IRA row as a single value with no footnote when the boundary is undefined', () => {
    renderPanel({ iraOwnerBoundary: undefined });
    const iraRow = screen.getByText('Pay tax from the IRA').closest('li');
    expect(iraRow!.textContent).not.toMatch(/before 59½/);
    expect(screen.queryByText(/early withdrawal/i)).not.toBeInTheDocument();
  });

  it('flips the verdict between the before and after halves when the penalty crosses T_future', () => {
    // T_now 0.22 → after BETR 0.22, before BETR 0.242. With T_future 0.23:
    //   after: 0.23 > 0.22 → above break-even; before: 0.23 > 0.242 is false →
    //   at or below. Rendered as neutral, non-directive comparison text.
    const summary: WorkingYearsBETRSummary = {
      ...SUMMARY,
      T_future: 0.23,
      tranches: [{ amountCents: 50_000_00, T_now: 0.22, betr: 0.22, verdict: 'convert' }],
    };
    renderPanel({ summary, iraOwnerBoundary: { year: 2030, firstName: 'Robin' } });
    const iraRow = screen.getByText('Pay tax from the IRA').closest('li');
    expect(iraRow!.textContent).toMatch(/RMD-era rate at or below break-even \(before 59½\)/);
    expect(iraRow!.textContent).toMatch(/RMD-era rate above break-even \(after 59½\)/);
  });

  it('marks the split arrow aria-hidden and provides an sr-only " to " for screen readers', () => {
    const { container } = render(
      withTheme(
        'light',
        <WorkingYearsPanel
          summary={SUMMARY}
          taxableIncomeDollars={100_000}
          onTaxableIncomeChange={vi.fn()}
          onTaxableIncomeCommit={vi.fn()}
          yearsToRetirement={15}
          source="ira"
          dragPct={10}
          iraOwnerBoundary={{ year: 2030, firstName: 'Robin' }}
        />,
      ),
    );
    const iraRow = screen.getByText('Pay tax from the IRA').closest('li');
    const arrow = iraRow!.querySelector('[aria-hidden="true"]');
    expect(arrow?.textContent).toBe('→');
    const srOnly = Array.from(iraRow!.querySelectorAll('.sr-only')).map((n) => n.textContent);
    expect(srOnly).toContain(' to ');
    expect(container).toBeTruthy();
  });

  it('shows distinct BETR for the two taxable variants at the default 10% slider', () => {
    // With source='ira' selected, neither taxable variant is overridden, so each
    // keeps its Vanguard default drag (10% vs 25%) → distinct BETR strings.
    const { container } = render(
      withTheme(
        'light',
        <WorkingYearsPanel
          summary={SUMMARY}
          taxableIncomeDollars={100_000}
          onTaxableIncomeChange={vi.fn()}
          onTaxableIncomeCommit={vi.fn()}
          yearsToRetirement={15}
          source="ira"
          dragPct={10}
        />,
      ),
    );
    const efficientRow = screen.getByText('Taxable account (lower default tax drag)').closest('li');
    const inefficientRow = screen.getByText('Taxable account (higher default tax drag)').closest('li');
    expect(efficientRow).not.toBeNull();
    expect(inefficientRow).not.toBeNull();
    expect(efficientRow!.textContent).not.toBe(inefficientRow!.textContent);
    expect(container).toBeTruthy();
  });
});
