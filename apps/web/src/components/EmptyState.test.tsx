/** EmptyState: teaching copy, the forwarded action slot, and `bare` dropping the Card wrapper. */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './EmptyState';
import { TextLink } from './TextLink';
import { expectNoA11yViolations } from '../test/a11y';

describe('EmptyState', () => {
  it('renders the teaching copy', () => {
    render(<EmptyState>No accounts yet. Add one to start projecting.</EmptyState>);
    expect(
      screen.getByText(/No accounts yet\. Add one to start projecting\./),
    ).toBeInTheDocument();
  });

  it('renders the optional action slot', () => {
    render(
      <MemoryRouter>
        <EmptyState action={<TextLink to="/accounts">Add an account</TextLink>}>
          No accounts yet.
        </EmptyState>
      </MemoryRouter>,
    );
    expect(
      screen.getByRole('link', { name: 'Add an account' }),
    ).toBeInTheDocument();
  });

  it('wraps in a Card by default and drops it when bare', () => {
    const { container, rerender } = render(<EmptyState>Body</EmptyState>);
    expect(container.querySelector('.rounded-2xl')).not.toBeNull();

    rerender(<EmptyState bare>Body</EmptyState>);
    expect(container.querySelector('.rounded-2xl')).toBeNull();
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <MemoryRouter>
        <EmptyState action={<TextLink to="/accounts">Add an account</TextLink>}>
          No accounts yet. Add one to start projecting.
        </EmptyState>
      </MemoryRouter>,
    );
    await expectNoA11yViolations(container);
  });
});
