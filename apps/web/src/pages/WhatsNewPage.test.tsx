import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WhatsNewPage } from './WhatsNewPage';
import { RELEASE_NOTES, type ReleaseNote } from '../lib/release-notes';
import { expectNoA11yViolations } from '../test/a11y';

describe('WhatsNewPage', () => {
  it('renders the page title', () => {
    render(<WhatsNewPage />);
    expect(
      screen.getByRole('heading', { level: 1, name: "What's New" }),
    ).toBeInTheDocument();
  });

  it('renders entries in newest-first array order', () => {
    const notes: ReleaseNote[] = [
      { date: '2026-06-21', kind: 'new', title: 'Alpha', blurb: 'first blurb' },
      { date: '2026-06-20', kind: 'fixed', title: 'Bravo', blurb: 'second blurb' },
      { date: '2026-06-19', kind: 'improved', title: 'Charlie', blurb: 'third blurb' },
    ];
    render(<WhatsNewPage notes={notes} />);
    const headings = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('groups same-date entries under a single date heading', () => {
    const notes: ReleaseNote[] = [
      { date: '2026-06-21', kind: 'new', title: 'Alpha', blurb: 'first blurb' },
      { date: '2026-06-21', kind: 'fixed', title: 'Bravo', blurb: 'second blurb' },
      { date: '2026-06-20', kind: 'improved', title: 'Charlie', blurb: 'third blurb' },
    ];
    render(<WhatsNewPage notes={notes} />);
    const dateHeadings = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(dateHeadings).toEqual(['June 21, 2026', 'June 20, 2026']);
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(3);
  });

  it('renders the New badge for a new entry', () => {
    const notes: ReleaseNote[] = [
      { date: '2026-06-21', kind: 'new', title: 'A new thing', blurb: 'blurb' },
    ];
    render(<WhatsNewPage notes={notes} />);
    const heading = screen.getByRole('heading', { level: 3, name: 'A new thing' });
    const row = heading.parentElement!;
    const badge = within(row).getByText('New');
    expect(badge).toHaveClass('text-positive');
  });

  it('renders the Improved badge for an improved entry', () => {
    const notes: ReleaseNote[] = [
      { date: '2026-06-21', kind: 'improved', title: 'Better thing', blurb: 'blurb' },
    ];
    render(<WhatsNewPage notes={notes} />);
    const heading = screen.getByRole('heading', { level: 3, name: 'Better thing' });
    const badge = within(heading.parentElement!).getByText('Improved');
    expect(badge).toHaveClass('text-pretax');
  });

  it('renders the Fixed badge for a fixed entry', () => {
    const notes: ReleaseNote[] = [
      { date: '2026-06-21', kind: 'fixed', title: 'Fixed thing', blurb: 'blurb' },
    ];
    render(<WhatsNewPage notes={notes} />);
    const heading = screen.getByRole('heading', { level: 3, name: 'Fixed thing' });
    const badge = within(heading.parentElement!).getByText('Fixed');
    expect(badge).toHaveClass('text-warning');
  });

  it('renders an empty list without crashing', () => {
    render(<WhatsNewPage notes={[]} />);
    expect(
      screen.getByRole('heading', { level: 1, name: "What's New" }),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  });

  it('does not throw on a malformed entry (missing blurb / unknown kind)', () => {
    const malformed = [
      { date: '2026-06-21', kind: 'mystery', title: 'Odd one' },
    ] as unknown as ReleaseNote[];
    expect(() => render(<WhatsNewPage notes={malformed} />)).not.toThrow();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Odd one' }),
    ).toBeInTheDocument();
  });

  it('renders the shipped release notes by default', () => {
    render(<WhatsNewPage />);
    expect(
      screen.getAllByRole('heading', { level: 3 }).length,
    ).toBe(RELEASE_NOTES.length);
  });

  it('renders no date heading when the date is empty', () => {
    const notes: ReleaseNote[] = [
      { date: '', kind: 'new', title: 'No date entry', blurb: 'a blurb' },
    ];
    render(<WhatsNewPage notes={notes} />);
    const heading = screen.getByRole('heading', { level: 3, name: 'No date entry' });
    expect(heading).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
  });

  it('has no a11y violations', async () => {
    const { container } = render(<WhatsNewPage />);
    await expectNoA11yViolations(container);
  });
});
