/**
 * Skeleton — loading-placeholder render + a11y smoke.
 *
 * The shared first-paint primitive that replaced the bare
 * `<p>Loading…</p>` strings. Asserts the dimmed blocks carry the
 * reduced-motion-safe pulse + are `aria-hidden`, that `LoadingState`
 * announces once via a `role="status"` region with an `sr-only` label,
 * that each variant previews a distinct shape, plus the shared-component
 * axe rule (AGENTS mandate for component test files).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Skeleton, SkeletonText, LoadingState } from './Skeleton';
import { expectNoA11yViolations } from '../test/a11y';

describe('Skeleton', () => {
  it('renders a dimmed block with the caller sizing + reduced-motion-safe pulse', () => {
    const { container } = render(<Skeleton className="h-5 w-40" />);
    const block = container.firstElementChild as HTMLElement;
    expect(block.className).toContain('h-5');
    expect(block.className).toContain('w-40');
    expect(block.className).toContain('animate-pulse');
    expect(block.className).toContain('motion-reduce:animate-none');
    // Decorative — assistive tech hears the LoadingState status, not the box.
    expect(block).toHaveAttribute('aria-hidden', 'true');
  });

  it('SkeletonText renders one line per requested row', () => {
    const { container } = render(<SkeletonText lines={4} />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
    expect(wrapper.children).toHaveLength(4);
  });
});

describe('LoadingState', () => {
  it('announces the loading state once with an sr-only label', () => {
    render(<LoadingState label="Loading your accounts…" />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading your accounts…')).toBeInTheDocument();
    // The visual preview is hidden from AT so it is not read as a stream
    // of empty boxes.
    expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('previews a table shape (header bar + body rows)', () => {
    const { container } = render(
      <LoadingState label="Loading entries…" variant="table" />,
    );
    // Header bar + 5 body-row blocks.
    const shape = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(shape.children).toHaveLength(6);
  });

  it('previews a form shape (label + input pairs)', () => {
    const { container } = render(
      <LoadingState label="Loading form…" variant="form" />,
    );
    const shape = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(shape.children).toHaveLength(4);
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <LoadingState label="Loading your accounts…" variant="table" />,
    );
    await expectNoA11yViolations(container);
  });
});
