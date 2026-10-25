/** PageHeader: title and subtitle, and a primary action that is a real button (never a Link) firing onClick and respecting disabled. */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PageHeader } from './PageHeader';
import { expectNoA11yViolations } from '../test/a11y';

describe('PageHeader', () => {
  it('renders the title as an h1 by default and the subtitle', () => {
    render(<PageHeader title="Accounts" subtitle="Manage accounts" />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Accounts' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Manage accounts')).toBeInTheDocument();
  });

  it('renders the title at the requested heading level', () => {
    render(<PageHeader title="Section" headingLevel={2} />);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Section' }),
    ).toBeInTheDocument();
  });

  it('renders the primary action as a <button>, not a link, and fires onClick', () => {
    const onClick = vi.fn();
    render(
      <PageHeader title="Accounts" action={{ label: 'Add Account', onClick }} />,
    );
    const btn = screen.getByRole('button', { name: 'Add Account' });
    expect(btn.tagName).toBe('BUTTON');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a disabled action does not fire onClick', () => {
    const onClick = vi.fn();
    render(
      <PageHeader
        title="Accounts"
        action={{ label: 'Add', onClick, disabled: true }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('title wrapper has min-w-0 and flex-1 so subtitle wraps and action stays top-right', () => {
    render(
      <PageHeader
        title="Accounts"
        subtitle="A very long subtitle that would push the button off to the next row without the min-w-0 flex-1 constraint"
        action={{ label: 'Add', onClick: () => {} }}
      />,
    );
    const wrap = screen.getByTestId('page-header-title-wrap');
    expect(wrap).toHaveClass('min-w-0');
    expect(wrap).toHaveClass('flex-1');
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <PageHeader
        title="Dashboard"
        subtitle="Your plan at a glance"
        action={{ label: 'Create Plan', onClick: () => {} }}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
