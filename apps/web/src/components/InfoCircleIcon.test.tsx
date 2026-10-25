/** InfoCircleIcon — render, a11y wiring, decorative variant. */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InfoCircleIcon } from './InfoCircleIcon';
import { expectNoA11yViolations } from '../test/a11y';

describe('InfoCircleIcon', () => {
  it('renders with role="img" and aria-label when specified', () => {
    render(<InfoCircleIcon role="img" ariaLabel="Notes" />);
    const icon = screen.getByRole('img', { name: 'Notes' });
    expect(icon).toBeInTheDocument();
  });

  it('is aria-hidden when no role/label is provided (decorative)', () => {
    const { container } = render(<InfoCircleIcon />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('applies width and height props', () => {
    const { container } = render(<InfoCircleIcon width={20} height={20} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '20');
    expect(svg).toHaveAttribute('height', '20');
  });

  it('has no a11y violations with role="img"', async () => {
    const { container } = render(<InfoCircleIcon role="img" ariaLabel="Notes" />);
    await expectNoA11yViolations(container);
  });
});
