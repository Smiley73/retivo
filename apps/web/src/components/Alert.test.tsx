/**
 * Alert — tone + live-region role render + a11y smoke.
 *
 * Tailwind-defaults replacement for the legacy `.error` class.
 * Asserts the default error tone announces via `role="alert"`,
 * polite tones use `role="status"`, an explicit role wins — plus the
 * shared-component axe rule (AGENTS mandate).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Alert } from './Alert';
import { expectNoA11yViolations } from '../test/a11y';

describe('Alert', () => {
  it('renders the error tone as an assertive live region', () => {
    render(<Alert>Something failed</Alert>);
    const el = screen.getByRole('alert');
    expect(el).toHaveTextContent('Something failed');
    expect(el.className).toContain('text-negative');
  });

  it('uses role=status for polite tones (info/success)', () => {
    render(<Alert tone="success">Saved</Alert>);
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
  });

  it('honors an explicit role override', () => {
    render(
      <Alert tone="error" role="status">
        Quiet error
      </Alert>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Quiet error');
  });

  it('has no a11y violations', async () => {
    const { container } = render(<Alert tone="warning">Heads up</Alert>);
    await expectNoA11yViolations(container);
  });
});
