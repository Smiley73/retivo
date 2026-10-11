/**
 * AuthBrandRow — the brand lockup every auth card mounts: RETIVO wordmark,
 * product tagline, open-source line, and the a11y smoke scan.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AuthBrandRow } from './auth-page-chrome';
import { APP_NAME, APP_TAGLINE, BRAND_MARK_URL, REPO_URL } from '../lib/brand';
import { withTheme } from '../test/theme-render';
import { expectNoA11yViolations } from '../test/a11y';

describe('AuthBrandRow', () => {
  it('renders the wordmark, the tagline, and the open-source line', () => {
    const { container } = render(withTheme('light', <AuthBrandRow />));
    expect(screen.getByText(APP_NAME)).toBeInTheDocument();
    expect(screen.getByText(APP_TAGLINE)).toBeInTheDocument();
    const mark = container.querySelector(`img[src="${BRAND_MARK_URL}"]`);
    expect(mark).toHaveAttribute('alt', '');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    const link = screen.getByRole('link', { name: 'RETIVO is open source' });
    expect(link).toHaveAttribute('href', REPO_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAccessibleDescription('Opens in a new tab');
  });

  it('uses the RETIVO brand strings, not the retired product name', () => {
    render(withTheme('light', <AuthBrandRow />));
    expect(screen.queryByText(/Retirement Planner/)).not.toBeInTheDocument();
    expect(APP_NAME).toBe('RETIVO');
    expect(APP_TAGLINE).toBe('Model your retirement. See the possibilities.');
  });

  it('has no a11y violations', async () => {
    const { container } = render(withTheme('light', <AuthBrandRow />));
    await expectNoA11yViolations(container);
  });
});
