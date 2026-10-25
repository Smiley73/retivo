/** RepoLink: exact accessible name and description, external-link attributes, and per-instance id uniqueness. */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RepoLink } from './RepoLink';
import { ISSUES_URL, REPO_URL } from '../lib/brand';
import { expectNoA11yViolations } from '../test/a11y';

describe('RepoLink', () => {
  it.each([
    ['open-source', 'RETIVO is open source', REPO_URL],
    ['issue', 'Report an issue on GitHub', ISSUES_URL],
  ] as const)('%s: named by its text, opens safely in a new tab', (kind, name, href) => {
    render(<RepoLink kind={kind} />);
    const link = screen.getByRole('link', { name });
    expect(link).toHaveAttribute('href', href);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('exposes the new-tab hint as the description, not the name', () => {
    const { container } = render(<RepoLink kind="open-source" />);
    const link = screen.getByRole('link', { name: 'RETIVO is open source' });
    expect(link).toHaveAccessibleDescription('Opens in a new tab');
    const desc = container.querySelector(
      `#${CSS.escape(link.getAttribute('aria-describedby')!)}`,
    );
    expect(desc).toHaveClass('sr-only');
    expect(link.contains(desc)).toBe(false);
  });

  it('gives two instances on one page distinct description ids', () => {
    render(
      <>
        <RepoLink kind="open-source" />
        <RepoLink kind="issue" />
      </>,
    );
    const ids = screen
      .getAllByRole('link')
      .map((l) => l.getAttribute('aria-describedby'));
    expect(new Set(ids).size).toBe(2);
  });

  it('has no a11y violations', async () => {
    const { container } = render(<RepoLink kind="issue" />);
    await expectNoA11yViolations(container);
  });
});
