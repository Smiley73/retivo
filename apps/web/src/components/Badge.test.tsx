/**
 * Badge — tone variant render.
 *
 * Graphite Spectrum semantic-token pill. Asserts content
 * renders, the default + a tone variant apply their semantic-token
 * classes. Purely presentational (a static `<span>` pill — no interactive
 * control / ARIA / focus / keyboard handler) → exempt from the a11y-smoke
 * mandate (AGENTS *Testing setup*).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge, badgeToneForBucket } from './Badge';
import type { AccountBucket } from '../lib/account-bucket';

describe('Badge', () => {
  it('renders its content with the neutral default', () => {
    const { container } = render(<Badge>Active</Badge>);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(container.firstElementChild?.className).toContain('bg-surface-sunken');
  });

  it('applies the compact `sm` size (11px type, tighter padding) and defaults to `md`', () => {
    const { container: sm } = render(<Badge size="sm">Beta</Badge>);
    expect(sm.firstElementChild?.className).toContain('px-1.5 py-0 text-[11px]');
    expect(sm.firstElementChild?.className).not.toContain('text-xs');
    const { container: md } = render(<Badge>Active</Badge>);
    expect(md.firstElementChild?.className).toContain('px-2 py-0.5 text-xs');
  });

  it('applies a tone variant', () => {
    const { container } = render(<Badge tone="success">Synced</Badge>);
    expect(container.firstElementChild?.className).toContain('text-positive');
  });

  it('applies the negative tone (the "Needs attention" chip, an alias of disabled)', () => {
    const { container } = render(<Badge tone="negative">Needs attention</Badge>);
    const cls = container.firstElementChild?.className ?? '';
    expect(cls).toContain('border-negative/40');
    expect(cls).toContain('bg-surface-sunken');
    expect(cls).toContain('text-negative');
  });

  it('applies each account-bucket tone its bucket hue utilities', () => {
    const cases: ReadonlyArray<[AccountBucket, string]> = [
      ['pretax', 'text-pretax'],
      ['roth', 'text-roth'],
      ['taxable', 'text-taxable'],
      ['cash', 'text-cash'],
    ];
    for (const [bucket, fgClass] of cases) {
      const { container } = render(
        <Badge tone={badgeToneForBucket(bucket)}>{bucket}</Badge>,
      );
      const cls = container.firstElementChild?.className ?? '';
      expect(cls).toContain(fgClass);
      expect(cls).toContain(`bg-${bucket}-subtle`);
    }
  });

  it('badgeToneForBucket maps a bucket to its matching tone', () => {
    expect(badgeToneForBucket('cash')).toBe('cash');
    expect(badgeToneForBucket('pretax')).toBe('pretax');
  });
});
