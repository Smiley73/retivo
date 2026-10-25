/** NotesIndicator: render gate (present, null, undefined, whitespace) and tooltip on focus. */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { NotesIndicator } from './NotesIndicator';
import { expectNoA11yViolations } from '../test/a11y';

describe('NotesIndicator', () => {
  it('renders the icon trigger when notes are present', () => {
    render(<NotesIndicator notes="watch this one" />);
    expect(screen.getByRole('img', { name: 'Notes' })).toBeInTheDocument();
  });

  it('renders nothing when notes are empty / null / undefined / whitespace', () => {
    const { rerender, container } = render(<NotesIndicator notes="" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<NotesIndicator notes={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<NotesIndicator notes={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<NotesIndicator notes="   " />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reveals the note text on keyboard focus', async () => {
    const user = userEvent.setup();
    render(<NotesIndicator notes="reconciled with statement" />);
    await user.tab();
    expect(
      await screen.findByText('reconciled with statement'),
    ).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <NotesIndicator notes="some explanatory note" />,
    );
    await expectNoA11yViolations(container);
  });
});
