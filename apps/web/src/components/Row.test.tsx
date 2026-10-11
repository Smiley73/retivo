/**
 * Row — horizontal flex utility render + a11y smoke.
 *
 * Tailwind-defaults replacement for the legacy `.row` class.
 * Asserts children render in a wrapping flex row — plus the shared-component axe rule (AGENTS mandate).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Row } from './Row';
import { expectNoA11yViolations } from '../test/a11y';

describe('Row', () => {
  it('renders children in a wrapping flex row', () => {
    const { container } = render(
      <Row>
        <span>A</span>
        <span>B</span>
      </Row>,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain('flex');
    expect(el.className).toContain('flex-wrap');
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <Row>
        <button type="button">Save</button>
      </Row>,
    );
    await expectNoA11yViolations(container);
  });
});
