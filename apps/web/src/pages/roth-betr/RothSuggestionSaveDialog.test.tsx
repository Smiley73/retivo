/**
 * Save-plan dialog: names what it writes, what it replaces and where that
 * comes from, the rerouted years, and the target Roth; confirms; blocks when
 * the target is not eligible; passes the accessibility smoke in both themes.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../test/a11y';
import { withTheme } from '../../test/theme-render';
import { RothSuggestionSaveDialog } from './RothSuggestionSaveDialog';
import type { SavePlanSummary } from './roth-suggestion-save-view';

const SUMMARY: SavePlanSummary = {
  label: 'Fill the 24% bracket, kept under both lines',
  firstYear: 2031,
  lastYear: 2044,
  windowCount: 14,
  yearsConverted: 12,
  totalConverted: '$310,000',
  reroutedYears: [],
  targetRothId: 'roth',
};

function dialog(
  props: Partial<React.ComponentProps<typeof RothSuggestionSaveDialog>> = {},
  theme: 'light' | 'dark' = 'light',
): React.ReactElement {
  return withTheme(
    theme,
    <RothSuggestionSaveDialog
      open
      onClose={vi.fn()}
      onConfirm={vi.fn()}
      scenarioName="Retire early"
      summary={SUMMARY}
      replaced={{ count: 0, inheritedFrom: null }}
      targetName="John Roth IRA"
      deathAges="age 90"
      saving={false}
      {...props}
    />,
  );
}

describe('RothSuggestionSaveDialog', () => {
  it('names the plan, the years, the target and what is written', () => {
    render(dialog());
    const d = screen.getByRole('dialog', { name: 'Save plan to scenario' });
    const text = d.textContent ?? '';
    expect(text).toContain('Fill the 24% bracket, kept under both lines');
    expect(text).toMatch(/one Fill window for each year from 2031 to 2044 \(14 windows\)/);
    expect(text).toMatch(/12 years, \$310,000 in total in today.s dollars/);
    expect(text).toContain('John Roth IRA');
    expect(text).toMatch(/Nothing else on the scenario changes/);
    expect(text).toMatch(/do not rise with inflation/);
    expect(text).toMatch(/limited search at one assumed death age \(age 90\)/);
    expect(text).toMatch(/not advice/);
    expect(text).not.toMatch(/\b(MAGI|IRMAA)\b/);
  });

  it('says a Fill window caps pre-tax income and does not instruct a conversion', () => {
    render(dialog());
    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).toMatch(/cap on pre-tax income, not an instruction to convert/);
    expect(text).toMatch(/records that the cap could not be met/);
    expect(text).toMatch(/does not happen in any year/);
  });

  it('lists the rerouted years of the row being saved', () => {
    render(dialog({ summary: { ...SUMMARY, reroutedYears: [2033, 2035] } }));
    expect(screen.getByRole('dialog').textContent).toMatch(/that happens in 2033, 2035/);
  });

  it('counts the windows it replaces and names the parent when they are inherited', () => {
    const { rerender } = render(dialog({ replaced: { count: 1, inheritedFrom: null } }));
    expect(screen.getByRole('dialog').textContent).toMatch(
      /replaces the 1 income cap window Retire early has today/,
    );
    rerender(dialog({ replaced: { count: 3, inheritedFrom: 'Base plan' } }));
    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).toMatch(/replaces the 3 income cap windows Retire early inherits from Base plan/);
    expect(text).toMatch(/Base plan is not changed/);
  });

  it('confirms and cancels', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(dialog({ onConfirm, onClose }));
    const d = screen.getByRole('dialog');
    await user.click(within(d).getByRole('button', { name: 'Save to scenario' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    await user.click(within(d).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('blocks confirming when the plan target is not an eligible Roth IRA', () => {
    render(dialog({ targetName: null }));
    const d = screen.getByRole('dialog');
    expect(within(d).getByRole('button', { name: 'Save to scenario' })).toBeDisabled();
    expect(within(d).getByText(/cannot be saved/)).toBeInTheDocument();
  });

  it('waits while a save is in flight', () => {
    render(dialog({ saving: true }));
    expect(screen.getByRole('button', { name: 'Save to scenario' })).toBeDisabled();
  });

  it.each(['light', 'dark'] as const)('passes the accessibility smoke in the %s theme', async (theme) => {
    render(dialog({ replaced: { count: 2, inheritedFrom: 'Base plan' } }, theme));
    await expectNoA11yViolations(screen.getByRole('dialog'));
  });
});
