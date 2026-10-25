/** Card: children render and the danger tone applies. */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card } from './Card';
import { expectNoA11yViolations } from '../test/a11y';

describe('Card', () => {
  it('renders its children', () => {
    render(<Card>Card body</Card>);
    expect(screen.getByText('Card body')).toBeInTheDocument();
  });

  it('applies the danger tone classes', () => {
    const { container } = render(<Card tone="danger">Danger zone</Card>);
    expect(container.firstElementChild?.className).toContain('bg-negative/5');
  });

  it('renders with role="note" and has no a11y violations', async () => {
    const { container } = render(
      <Card role="note">
        <p>Disclosure content</p>
      </Card>,
    );
    expect(screen.getByRole('note')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });
});
