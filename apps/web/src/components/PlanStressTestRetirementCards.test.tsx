/**
 * Display tests for the at-retirement Typical / Pessimistic / Bad-luck cards.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PlanStressTestRetirementCards } from './PlanStressTestSection';
import { vm } from './__fixtures__/plan-stress-test-vm';

describe('PlanStressTestRetirementCards — Typical / Pessimistic / Bad-luck', () => {
  it("'today' renders real-dollar (deflated) at-retirement values in card order", () => {
    const today = vm({
      displayMode: 'today',
      startTypical: 12,
      startPessimistic: 11,
      startBadLuck: 10,
    });
    const { container } = render(<PlanStressTestRetirementCards vm={today} />);
    const values = container.querySelectorAll(
      '[data-testid="stress-stat-value"]',
    );
    expect(values).toHaveLength(3);
    expect(values[0].textContent).toContain('$12');
    expect(values[1].textContent).toContain('$11');
    expect(values[2].textContent).toContain('$10');
  });

  it("'future' renders nominal at-retirement values in card order", () => {
    const future = vm({
      displayMode: 'future',
      startTypical: 120,
      startPessimistic: 110,
      startBadLuck: 100,
    });
    const { container } = render(<PlanStressTestRetirementCards vm={future} />);
    const values = container.querySelectorAll(
      '[data-testid="stress-stat-value"]',
    );
    expect(values[0].textContent).toContain('$120');
    expect(values[1].textContent).toContain('$110');
    expect(values[2].textContent).toContain('$100');
  });

  it('renders the Pessimistic card between Typical and Bad-luck with neutral ink', () => {
    const { container } = render(<PlanStressTestRetirementCards vm={vm()} />);
    const labels = Array.from(
      container.querySelectorAll('[data-testid="stress-stat-label"]'),
    );
    expect(labels.map((l) => l.textContent)).toEqual([
      'At retirement: Typical',
      'At retirement: Pessimistic',
      'At retirement: Bad-luck',
    ]);
    // No static success/warning ink on any card.
    for (const el of [
      ...labels,
      ...Array.from(
        container.querySelectorAll('[data-testid="stress-stat-value"]'),
      ),
    ]) {
      expect((el as HTMLElement).style.color).toBe('');
    }
  });
});
