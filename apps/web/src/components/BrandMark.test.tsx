/**
 * BrandMark — the shared decorative Retivo dot used by every React lockup.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BRAND_MARK_URL } from '../lib/brand';
import { expectNoA11yViolations } from '../test/a11y';
import { BrandMark } from './BrandMark';

describe('BrandMark', () => {
  it('renders the cache-versioned favicon asset as a decorative image', () => {
    const { container } = render(<BrandMark className="size-4 shrink-0" />);
    const mark = container.querySelector('img');

    expect(mark).toHaveAttribute('src', BRAND_MARK_URL);
    expect(mark).toHaveClass('size-4', 'shrink-0');
    expect(mark).toHaveAttribute('alt', '');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
  });

  it('has no a11y violations', async () => {
    const { container } = render(<BrandMark className="size-4" />);
    await expectNoA11yViolations(container);
  });
});
