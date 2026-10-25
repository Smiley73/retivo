/** MonteCarloMethodologyModal: trigger, dialog sections, close and a11y. */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useId } from 'react';
import { describe, expect, it } from 'vitest';
import { MonteCarloMethodologyModal } from './MonteCarloMethodologyModal';
import { expectNoA11yViolations } from '../test/a11y';

// React Aria derives ids from React's `useId` counter, so rewrite each generated id to a stable first-seen token: the
// snapshot keeps the `aria-labelledby` wiring without churning when the id sequence shifts.
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

    expect(
      screen.getByText(/share of 10,000 simulated retirement futures/i),
    ).toBeInTheDocument();

    expect(
      screen.getByText(/what varies across simulations/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/each simulation draws a different sequence/i),
    ).toBeInTheDocument();

    expect(
      screen.getByText(/what stays the same across simulations/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/tracks scenario inflation/i),
    ).toBeInTheDocument();

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

    expect(
      screen.getByText(/spending guardrails are modeled when you turn them on/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/with guardrails off, spending never reacts/i),
    ).toBeInTheDocument();

    expect(
      screen.getByText(/10,000 paths carry their own sampling error/i),
    ).toBeInTheDocument();

    expect(
      screen.getByText(/medical costs rise faster, but not more erratically/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/move in\s+lockstep with general inflation/i),
    ).toBeInTheDocument();

    expect(
      screen.getByText(/simulated market histories are not a forecast/i),
    ).toBeInTheDocument();

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

    expect(
      screen.getByText(/clustered history, monthly-average prices/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/consecutive multi-month\s+stretches of real history/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/monthly-average prices, which\s+understate/i),
    ).toBeInTheDocument();

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

    expect(screen.queryByText(/does not account for taxes/i)).toBeNull();
    expect(screen.getByRole('dialog').textContent).not.toMatch(
      /does not account for taxes/i,
    );
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
    // Burns `useId` slots ahead of the modal, as a React Aria internal change would.
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

    // The burner must actually move the raw ids, or the equality below proves nothing.
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

    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).not.toMatch(/more cautious,?\s+not\s+less/i);
    expect(text).not.toMatch(/leans?\s+are\s+conservative/i);
    expect(text).not.toMatch(/both\s+leans\s+make/i);
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
    const openingPara = screen.getByText(
      /share of 10,000 simulated retirement futures/i,
    );
    expect(openingPara).toHaveClass('text-sm');
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
    // React Aria portals the modal to document.body, outside the render container.
    await expectNoA11yViolations(baseElement);
  });
});
