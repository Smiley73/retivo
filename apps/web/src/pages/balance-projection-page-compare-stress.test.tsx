/**
 * The Compare tab's "Plan success" row, rendered over a hand-built stress view
 * model: the comparison side's Try again control must survive the retry it
 * starts (keyboard focus stays on it), the way the market-stress retry does.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CompareStressSide, CompareStressVm } from '../monte-carlo/use-compare-stress';
import { withTheme } from '../test/theme-render';
import { CompareStressRow } from './balance-projection-page-compare-stress';

const side = (state: CompareStressSide['state'], extra: Partial<CompareStressSide> = {}): CompareStressSide => ({
  state,
  probability: null,
  pathCount: null,
  progress: null,
  message: null,
  ...extra,
});

const READY = side('ready', { probability: 0.9, pathCount: 10_000 });

function vmWith(comparison: CompareStressSide, retry: () => void): CompareStressVm {
  return {
    viewed: READY,
    comparison,
    verdict: null,
    cacheKeys: null,
    retry,
    runViewed: () => undefined,
  };
}

const element = (stress: CompareStressVm) =>
  withTheme('light', <CompareStressRow viewedName="Base" comparisonName="Early" stress={stress} />);

describe('CompareStressRow — Try again', () => {
  it('keeps focus on the button, disabled, through the retry it started', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const failed = side('error', { message: 'Boom.' });
    const { rerender } = render(element(vmWith(failed, retry)));
    const button = screen.getByRole('button', { name: 'Try again' });
    button.focus();
    await user.click(button);
    expect(retry).toHaveBeenCalledTimes(1);

    // The hook maps the retry to pending, then running.
    rerender(element(vmWith(side('pending'), retry)));
    expect(button).toBeInTheDocument();
    expect(button).toHaveFocus();
    expect(button).toBeDisabled();
    expect(screen.getByRole('progressbar', { name: /Stress test for Early/ })).toBeInTheDocument();

    rerender(element(vmWith(side('running', { progress: { done: 10, total: 100 } }), retry)));
    expect(screen.getByRole('button', { name: 'Try again' })).toBe(button);
    expect(button).toBeDisabled();

    // Once the side is ready the control goes away.
    rerender(element(vmWith(READY, retry)));
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows no button for a side that is merely pending', () => {
    render(element(vmWith(side('pending'), vi.fn())));
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
