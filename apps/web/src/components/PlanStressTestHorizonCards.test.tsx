/**
 * Display tests for the at-horizon cards: neutral ink and the danger flip.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlanStressTestHorizonCards } from './PlanStressTestSection';
import { vm } from './__fixtures__/plan-stress-test-vm';
import { withTheme } from '../test/theme-render';


// The danger flip is the Tailwind-default light-band
// `STATUS_HEX.light.danger` — the Graphite Spectrum `negative` token
// (#b32228) under a light theme; jsdom serializes it as this rgb(). The
// dark band (#ef6661) is asserted in the theme-reactivity block below.
const DANGER_RGB = 'rgb(179, 34, 40)';
const DANGER_RGB_DARK = 'rgb(239, 102, 97)';

describe('PlanStressTestHorizonCards — neutral ink + danger flip', () => {
  it('flips only the depleted card to the danger ink, leaving the others neutral', () => {
    const depletedEarly = vm({
      endBadLuck: 0,
      badLuckDepletionYear: 2070,
      lastDeathYear: 2086,
    });
    const { container } = render(
      withTheme('light', <PlanStressTestHorizonCards vm={depletedEarly} />),
    );
    const labels = container.querySelectorAll(
      '[data-testid="stress-stat-label"]',
    );
    expect(labels).toHaveLength(3);
    // Typical (0) + Pessimistic (1) stay neutral; Bad-luck (2) goes red.
    expect((labels[0] as HTMLElement).style.color).toBe('');
    expect((labels[1] as HTMLElement).style.color).toBe('');
    expect((labels[2] as HTMLElement).style.color).toBe(DANGER_RGB);
    // Footer matches the card: Bad-luck's depletion line is red too;
    // a funded card's footer stays neutral.
    expect(screen.getByText('Runs out 2070').style.color).toBe(DANGER_RGB);
    expect(
      (screen.getAllByText('Funds the full horizon')[0] as HTMLElement).style
        .color,
    ).toBe('');
  });

  it('stays neutral (no inline color) when the path funds the horizon', () => {
    const funded = vm({
      endTypical: 750_000,
      typicalDepletionYear: null,
      lastDeathYear: 2086,
    });
    const { container } = render(
      withTheme('light', <PlanStressTestHorizonCards vm={funded} />),
    );
    const typicalLabel = container.querySelectorAll(
      '[data-testid="stress-stat-label"]',
    )[0] as HTMLElement;
    expect(typicalLabel.style.color).toBe('');
  });

  it('flips the Pessimistic card to danger when the P25 path depletes', () => {
    const pessimisticDepletes = vm({
      endPessimistic: 0,
      pessimisticDepletionYear: 2075,
      lastDeathYear: 2086,
    });
    const { container } = render(
      withTheme('light', <PlanStressTestHorizonCards vm={pessimisticDepletes} />),
    );
    const labels = container.querySelectorAll(
      '[data-testid="stress-stat-label"]',
    );
    expect((labels[1] as HTMLElement).textContent).toBe(
      'At horizon: Pessimistic',
    );
    expect((labels[1] as HTMLElement).style.color).toBe(DANGER_RGB);
  });

  it('flags danger when balance hits zero without an explicit depletion year', () => {
    const zeroEnding = vm({
      endBadLuck: 0,
      badLuckDepletionYear: null,
      lastDeathYear: 2086,
    });
    const { container } = render(
      withTheme('light', <PlanStressTestHorizonCards vm={zeroEnding} />),
    );
    const badLuckLabel = container.querySelectorAll(
      '[data-testid="stress-stat-label"]',
    )[2] as HTMLElement;
    expect(badLuckLabel.style.color).toBe(DANGER_RGB);
  });

  it('renders the Pessimistic depletion trailing line', () => {
    const { container } = render(
      withTheme(
        'light',
        <PlanStressTestHorizonCards
          vm={vm({ endPessimistic: 0, pessimisticDepletionYear: 2075 })}
        />,
      ),
    );
    expect(container.textContent).toContain('Runs out 2075');
  });

  // STATUS_HEX is theme-aware — the light 700-band fails AA on
  // the dark stat-card surface, the dark 400-band clears it. Toggling
  // the ThemeProvider value flips the inline danger ink on the
  // already-mounted card.
  it('renders the dark-band danger ink under a dark theme', () => {
    const depleted = vm({
      endBadLuck: 0,
      badLuckDepletionYear: 2070,
      lastDeathYear: 2086,
    });
    const { container } = render(
      withTheme('dark', <PlanStressTestHorizonCards vm={depleted} />),
    );
    const badLuckLabel = container.querySelectorAll(
      '[data-testid="stress-stat-label"]',
    )[2] as HTMLElement;
    expect(badLuckLabel.style.color).toBe(DANGER_RGB_DARK);
    expect(DANGER_RGB_DARK).not.toBe(DANGER_RGB);
  });
});
