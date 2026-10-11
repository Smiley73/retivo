/**
 * MonteCarloMethodologyModal — trigger, dialog sections, close, a11y.
 *
 * React Aria portals the opened modal to document.body, outside the
 * render container, so the opened-state a11y scan runs against
 * `baseElement` (matches the pattern from ProjectionMethodExplainer.test.tsx
 * and Modal.test.tsx).
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useId } from 'react';
import { describe, expect, it } from 'vitest';
import { MonteCarloMethodologyModal } from './MonteCarloMethodologyModal';
import { expectNoA11yViolations } from '../test/a11y';

/**
 * React Aria derives element ids (`react-aria-_r_p_`) from React's `useId`
 * counter, so any internal change that adds or drops a `useId` call shifts
 * every id in the tree. The 1.19 → 1.20 bump did exactly that and reddened the
 * snapshot below over two id lines with no markup change.
 *
 * The literal ids are noise for a snapshot that guards structure and sizing
 * classes — but the *wiring* they express (which element `aria-labelledby`
 * points at) is not, so rewrite each distinct generated id to a stable
 * first-seen-order token instead of stripping it. A broken reference still
 * shows up as a mismatched token pair.
 */
const withStableAriaIds = (el: HTMLElement): HTMLElement => {
  const clone = el.cloneNode(true) as HTMLElement;
  const stableFor = new Map<string, string>();
  const rewrite = (value: string) =>
    value
      .split(/\s+/)
      .map((token) => {
        if (!token.startsWith('react-aria-')) return token;
        if (!stableFor.has(token)) stableFor.set(token, `react-aria-id-${stableFor.size + 1}`);
        return stableFor.get(token) as string;
      })
      .join(' ');

  for (const node of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    for (const attr of Array.from(node.attributes)) {
      if (attr.value.includes('react-aria-')) node.setAttribute(attr.name, rewrite(attr.value));
    }
  }
  return clone;
};

describe('MonteCarloMethodologyModal', () => {
  it('renders the trigger button with an accessible name', () => {
    render(<MonteCarloMethodologyModal />);
    expect(
      screen.getByRole('button', {
        name: /how is success probability calculated/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the dialog with the three-section content on click', async () => {
    const user = userEvent.setup();
    render(<MonteCarloMethodologyModal />);
    await user.click(
      screen.getByRole('button', {
        name: /how is success probability calculated/i,
      }),
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName(
      'How success probability is calculated',
    );

    // Section (a) — what the number means
    expect(
      screen.getByText(/share of 10,000 simulated retirement futures/i),
    ).toBeInTheDocument();

    // Section (b) — what varies
    expect(
      screen.getByText(/what varies across simulations/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/each simulation draws a different sequence/i),
    ).toBeInTheDocument();

    // Section (c) — what stays fixed
    expect(
      screen.getByText(/what stays the same across simulations/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/tracks scenario inflation/i),
    ).toBeInTheDocument();

    // Limitations
    expect(screen.getByText(/limitations/i)).toBeInTheDocument();
    expect(
      screen.getByText(/past market sequences are not a guarantee/i),
    ).toBeInTheDocument();
  });

  it('renders the methodology disclosures (cost, guardrails, sampling error, medical CPI, Shiller, CPI real-cut)', async () => {
    const user = userEvent.setup();
    render(<MonteCarloMethodologyModal />);
    await user.click(
      screen.getByRole('button', {
        name: /how is success probability calculated/i,
      }),
    );

    // Guardrail copy matches guardrail behaviour.
    expect(
      screen.getByText(/spending guardrails are modeled when you turn them on/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/with guardrails off, spending never reacts/i),
    ).toBeInTheDocument();

    // Finite-sample disclosure.
    expect(
      screen.getByText(/10,000 paths carry their own sampling error/i),
    ).toBeInTheDocument();

    // Retained medical-inflation (CPI-residual) approximation.
    expect(
      screen.getByText(/medical costs rise faster, but not more erratically/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/move in\s+lockstep with general inflation/i),
    ).toBeInTheDocument();

    // No forecast.
    expect(
      screen.getByText(/simulated market histories are not a forecast/i),
    ).toBeInTheDocument();

    // The longer-life comparison pads the plan rather than rebuilding it:
    // fresh draws past the original horizon, flat-nominal income, no new filing
    // schedule. All three leans must be disclosed, not just implied.
    expect(
      screen.getByText(/the longer-life comparison stretches the plan/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/past that point\s+they use fresh market draws/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /repeat their last dollar amount with no further\s+cost-of-living increase/i,
      ),
    ).toBeInTheDocument();

    // Block-bootstrap clustering / Shiller monthly-average prices.
    expect(
      screen.getByText(/clustered history, monthly-average prices/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/consecutive multi-month\s+stretches of real history/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/monthly-average prices, which\s+understate/i),
    ).toBeInTheDocument();

    // CPI mean-centering real-return cut.
    expect(
      screen.getByText(/inflation framing trims real returns/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/reduces the\s+modeled real \(inflation-adjusted\) return/i),
    ).toBeInTheDocument();
  });

  it('keeps the six disclosures inside the existing limitations callout (not a new section)', async () => {
    const user = userEvent.setup();
    render(<MonteCarloMethodologyModal />);
    await user.click(
      screen.getByRole('button', {
        name: /how is success probability calculated/i,
      }),
    );

    // The "What this stress test does and does not model" list + its six
    // bullets live under the existing Limitations heading, with no new <h3>.
    const dialog = screen.getByRole('dialog');
    const headings = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual([
      'What varies across simulations',
      'What stays the same across simulations',
      'Limitations',
    ]);
    expect(
      screen.getByText(/what this stress test does and does not model/i),
    ).toBeInTheDocument();

    const limitationsList = screen.getByRole('list');
    expect(dialog).toContainElement(limitationsList);
    const bullets = screen.getAllByRole('listitem');
    expect(bullets).toHaveLength(6);
  });

  it('no longer claims spending never changes during a downturn (guardrails ship)', async () => {
    const user = userEvent.setup();
    render(<MonteCarloMethodologyModal />);
    await user.click(
      screen.getByRole('button', {
        name: /how is success probability calculated/i,
      }),
    );

    // NEGATIVE assertion: downturn spending guardrails ARE modeled
    // when enabled, so the blanket "does not capture … changes in spending
    // behavior during a downturn" claim must be gone.
    expect(screen.getByRole('dialog').textContent).not.toMatch(
      /changes\s+in spending behavior during a downturn/i,
    );
  });

  it('no longer makes the stale broad "does not account for taxes" claim', async () => {
    const user = userEvent.setup();
    render(<MonteCarloMethodologyModal />);
    await user.click(
      screen.getByRole('button', {
        name: /how is success probability calculated/i,
      }),
    );

    // NEGATIVE assertion: taxes ARE modeled, so the
    // old blanket "does not account for taxes" sentence must be gone.
    expect(screen.queryByText(/does not account for taxes/i)).toBeNull();
    expect(screen.getByRole('dialog').textContent).not.toMatch(
      /does not account for taxes/i,
    );
    // And the accurate residual framing is present.
    expect(
      screen.getByText(/Taxes\s+are modeled in each path/i),
    ).toBeInTheDocument();
  });

  it('renders a stable size="3xl" dialog snapshot (no overflow regression)', async () => {
    const user = userEvent.setup();
    render(<MonteCarloMethodologyModal />);
    await user.click(
      screen.getByRole('button', {
        name: /how is success probability calculated/i,
      }),
    );
    expect(withStableAriaIds(screen.getByRole('dialog'))).toMatchSnapshot();
  });

  it('normalizes the snapshot ids so an id-sequence shift alone cannot redden it', async () => {
    // Burns `useId` slots ahead of the modal, reproducing exactly what a React
    // Aria internal change does to the id sequence.
    const IdBurner: React.FC = () => {
      useId();
      useId();
      useId();
      return null;
    };
    const openAndNormalize = async (withBurner: boolean) => {
      const user = userEvent.setup();
      render(
        <>
          {withBurner ? <IdBurner /> : null}
          <MonteCarloMethodologyModal />
        </>,
      );
      await user.click(
        screen.getByRole('button', {
          name: /how is success probability calculated/i,
        }),
      );
      const dialog = screen.getByRole('dialog');
      const result = {
        raw: dialog.getAttribute('aria-labelledby') ?? '',
        normalized: withStableAriaIds(dialog).outerHTML,
      };
      cleanup();
      return result;
    };

    const plain = await openAndNormalize(false);
    const shifted = await openAndNormalize(true);

    // Guard the guard: if the burner did not actually move the raw ids, the
    // equality below would hold trivially and prove nothing.
    expect(shifted.raw).not.toBe(plain.raw);
    expect(shifted.normalized).toBe(plain.normalized);
  });

  it('does not promise the longer-life approximations lean one way', async () => {
    const user = userEvent.setup();
    render(<MonteCarloMethodologyModal />);
    await user.click(
      screen.getByRole('button', {
        name: /how is success probability calculated/i,
      }),
    );

    // NEGATIVE assertion: the padded extra years have NO knowable net
    // direction. `extendHorizon` can carry joint filing and BOTH members'
    // income through the extension, which can lower modeled tax or retain
    // income a rebuilt survivor schedule would have dropped, and the appended
    // fresh draws can help or hurt. Any "more cautious, not less" style
    // reassurance is a false promise and must not come back.
    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).not.toMatch(/more cautious,?\s+not\s+less/i);
    expect(text).not.toMatch(/leans?\s+are\s+conservative/i);
    expect(text).not.toMatch(/both\s+leans\s+make/i);
    // And the honest replacement is present: an estimate, either direction.
    expect(
      screen.getByText(/an estimate\s+rather than an exact re-run/i),
    ).toBeInTheDocument();
    expect(text).toMatch(/move the result in either\s+direction/i);
  });

  it('keeps the content-heavy body inside the shared viewport-capped scroll region', async () => {
    const user = userEvent.setup();
    render(<MonteCarloMethodologyModal />);
    await user.click(
      screen.getByRole('button', {
        name: /how is success probability calculated/i,
      }),
    );

    // The cap + scroll + keyboard-focusable region are owned by the shared
    // Modal (see Modal.test.tsx); this modal opts in via `scrollBodyLabel`.
    // Assert the explainer copy lands inside that named, focusable scroll
    // region so the whole dialog stays on-screen on short viewports.
    const region = screen.getByRole('region', {
      name: /success probability methodology details/i,
    });
    expect(region).toContainElement(
      screen.getByText(/share of 10,000 simulated retirement futures/i),
    );
    expect(region).toHaveAttribute('tabindex', '0');
  });

  it('closes the dialog on Escape', async () => {
    const user = userEvent.setup();
    render(<MonteCarloMethodologyModal />);
    await user.click(
      screen.getByRole('button', {
        name: /how is success probability calculated/i,
      }),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the dialog on scrim click', async () => {
    const user = userEvent.setup();
    render(<MonteCarloMethodologyModal />);
    await user.click(
      screen.getByRole('button', {
        name: /how is success probability calculated/i,
      }),
    );
    const dialog = screen.getByRole('dialog');
    const overlay = dialog.closest('.fixed')!;
    await user.click(overlay);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('body copy renders at text-sm (typography baseline)', async () => {
    const user = userEvent.setup();
    render(<MonteCarloMethodologyModal />);
    await user.click(
      screen.getByRole('button', {
        name: /how is success probability calculated/i,
      }),
    );
    // The opening paragraph is the clearest body-copy surface.
    const openingPara = screen.getByText(
      /share of 10,000 simulated retirement futures/i,
    );
    expect(openingPara).toHaveClass('text-sm');
  });

  it('has no a11y violations with trigger only (closed)', async () => {
    const { container } = render(<MonteCarloMethodologyModal />);
    await expectNoA11yViolations(container);
  });

  it('has no a11y violations when the dialog is open', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<MonteCarloMethodologyModal />);
    await user.click(
      screen.getByRole('button', {
        name: /how is success probability calculated/i,
      }),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await expectNoA11yViolations(baseElement);
  });
});
