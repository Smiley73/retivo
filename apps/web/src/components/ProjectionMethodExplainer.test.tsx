/**
 * ProjectionMethodExplainer — trigger + dialog content + close +
 * a11y smoke.
 *
 * Keyboard/pointer interaction goes through user-event (React Aria's
 * usePress model can't be driven by fireEvent). The opened modal is
 * portaled by React Aria to document.body, outside the render
 * container, so the opened-state axe scan runs against `baseElement`
 * (the documented pattern in Modal.test.tsx) — a container-scoped scan
 * would miss the dialog tree entirely.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectionMethodExplainer } from './ProjectionMethodExplainer';
import { expectNoA11yViolations } from '../test/a11y';

const METHOD_NAMES = [
  'Planned',
  'Historical',
  'Typical',
  'Pessimistic',
  'Bad-luck',
] as const;

const EXPLANATIONS = [
  /Each account grows at the return % you set for it/,
  // The Historical gloss must carry the past-performance disclaimer, not just
  // describe the mechanic.
  /it has actually earned in your balance history.*Past performance is not a forecast/s,
  /The middle outcome of 10,000 simulated market histories/,
  /A rough 1-in-4 bad case \(the 25th-percentile outcome\)\./,
  /A rough 1-in-10 bad case \(the 10th-percentile outcome\)\./,
];

const UNIT_NAMES = ["Today's dollars", 'Future dollars'] as const;

const UNIT_EXPLANATIONS = [
  /Adjusted for inflation and shown in today's money/,
  /The raw projected amount for that year with inflation left in/,
];

describe('ProjectionMethodExplainer', () => {
  it('renders the trigger and no dialog by default', () => {
    render(<ProjectionMethodExplainer />);
    expect(
      screen.getByRole('button', { name: 'What do these mean?' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the dialog with the methods and the display-unit modes on click', async () => {
    const user = userEvent.setup();
    render(<ProjectionMethodExplainer />);

    await user.click(
      screen.getByRole('button', { name: 'What do these mean?' }),
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('How to read these figures');
    expect(
      screen.getByText(
        'Planned and Historical each assume one fixed return rate. ' +
          'Typical, Pessimistic, and Bad-luck come from a 10,000-run market ' +
          'stress test.',
      ),
    ).toBeInTheDocument();
    for (const name of METHOD_NAMES) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    for (const explanation of EXPLANATIONS) {
      expect(screen.getByText(explanation)).toBeInTheDocument();
    }
    expect(
      screen.getByText(
        "The Today's / Future dollars toggle next to this button changes " +
          'how every amount above is shown.',
      ),
    ).toBeInTheDocument();
    for (const name of UNIT_NAMES) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    for (const explanation of UNIT_EXPLANATIONS) {
      expect(screen.getByText(explanation)).toBeInTheDocument();
    }
  });

  it('closes the dialog on Escape', async () => {
    const user = userEvent.setup();
    render(<ProjectionMethodExplainer />);

    await user.click(
      screen.getByRole('button', { name: 'What do these mean?' }),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the dialog on scrim (backdrop) click', async () => {
    const user = userEvent.setup();
    render(<ProjectionMethodExplainer />);

    await user.click(
      screen.getByRole('button', { name: 'What do these mean?' }),
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();

    // React Aria's isDismissable overlay closes when a pointer press
    // lands on the overlay (scrim) outside the modal panel — the only
    // mouse-only dismissal for this no-action-row dialog.
    const overlay = dialog.closest('.fixed')!;
    await user.click(overlay);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('has no a11y violations (trigger-only, closed)', async () => {
    const { container } = render(<ProjectionMethodExplainer />);
    await expectNoA11yViolations(container);
  });

  it('has no a11y violations when the dialog is open', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<ProjectionMethodExplainer />);

    await user.click(
      screen.getByRole('button', { name: 'What do these mean?' }),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // React Aria portals the dialog outside the render container; axe
    // the whole document body so the dialog tree is in scope.
    await expectNoA11yViolations(baseElement);
  });
});
