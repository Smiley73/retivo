/** DatePicker: the shared React Aria date field keeps the frozen YYYY-MM-DD value contract. */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DatePicker } from './DatePicker';
import { expectNoA11yViolations } from '../test/a11y';
import { firedReactAriaMissingLabelWarning } from '../test/react-aria-warnings';

describe('DatePicker', () => {
  it('renders the controlled YYYY-MM-DD value in the segments', () => {
    render(
      <DatePicker ariaLabel="Birthdate" value="1965-03-20" onChange={() => {}} />,
    );
    const group = screen.getByRole('group', { name: 'Birthdate' });
    expect(group).toHaveTextContent('3/20/1965');
    expect(
      screen.getByRole('spinbutton', { name: /month/ }),
    ).toHaveAttribute('aria-valuetext', expect.stringContaining('March'));
  });

  it('renders date segments at the text-sm page baseline (font-size regression guard)', () => {
    // jsdom cannot measure computed px, so the segment class is the contract for matching the page text size.
    render(
      <DatePicker ariaLabel="Birthdate" value="1965-03-20" onChange={() => {}} />,
    );
    expect(
      screen.getByRole('spinbutton', { name: /month/ }),
    ).toHaveClass('text-sm');
  });

  it('treats an empty string as no value (native-input parity)', () => {
    render(
      <DatePicker ariaLabel="Birthdate" value="" onChange={() => {}} />,
    );
    expect(
      screen.getByRole('group', { name: 'Birthdate' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('1965')).not.toBeInTheDocument();
  });

  it('opens the calendar and emits the picked date as a YYYY-MM-DD string', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DatePicker
        ariaLabel="Birthdate"
        value="2026-05-10"
        onChange={onChange}
      />,
    );
    // React Aria composes the trigger name from label plus value; match the stable "calendar" token.
    await user.click(screen.getByRole('button', { name: /calendar/i }));
    const grid = await screen.findByRole('application');
    await user.click(
      within(grid).getByRole('button', { name: /Friday, May 15, 2026/ }),
    );
    expect(onChange).toHaveBeenCalledWith('2026-05-15');
  });

  it('advances a segment via the keyboard and emits the new string', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DatePicker
        ariaLabel="Birthdate"
        value="2026-05-10"
        onChange={onChange}
      />,
    );
    await user.tab();
    await user.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenCalledWith('2026-06-10');
  });

  it('takes its accessible name from an external <label htmlFor> when only id is given', () => {
    render(
      <>
        <label htmlFor="bd">Birthdate</label>
        <DatePicker id="bd" value="1965-03-20" onChange={() => {}} />
      </>,
    );
    expect(
      screen.getByRole('group', { name: 'Birthdate' }),
    ).toBeInTheDocument();
  });

  it('reuses the external label own id and never clobbers it', () => {
    render(
      <>
        <label id="my-own-bd-label" htmlFor="bd3">
          Birthdate
        </label>
        <DatePicker id="bd3" value="1965-03-20" onChange={() => {}} />
      </>,
    );
    expect(document.getElementById('my-own-bd-label')?.id).toBe(
      'my-own-bd-label',
    );
    expect(
      screen.getByRole('group', { name: 'Birthdate' }),
    ).toBeInTheDocument();
  });

  it('resolves an unambiguous accessible name when a same-named id already exists', () => {
    render(
      <>
        <span id="bd4-label">Some other text</span>
        <label htmlFor="bd4">Birthdate</label>
        <DatePicker id="bd4" value="1965-03-20" onChange={() => {}} />
      </>,
    );
    expect(
      screen.getByRole('group', { name: 'Birthdate' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: 'Some other text' }),
    ).not.toBeInTheDocument();
    expect(document.getElementById('bd4-label')?.textContent).toBe(
      'Some other text',
    );
  });

  it('does not trip the React Aria visible-label warning on first render for an id-only external-label DatePicker', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(
      <>
        <label htmlFor="dp-x">Birthdate</label>
        <DatePicker id="dp-x" value="1965-03-20" onChange={() => {}} />
      </>,
    );
    expect(firedReactAriaMissingLabelWarning(warn)).toBe(false);
    warn.mockRestore();
  });

  it('still warns for an id-only DatePicker with no external label and no ariaLabel', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<DatePicker id="dp-orphan" value="1965-03-20" onChange={() => {}} />);
    expect(firedReactAriaMissingLabelWarning(warn)).toBe(true);
    warn.mockRestore();
  });

  it('still honours an explicit ariaLabel over an external label', () => {
    render(
      <>
        <label htmlFor="bd2">Visible</label>
        <DatePicker
          id="bd2"
          ariaLabel="Explicit name"
          value="1965-03-20"
          onChange={() => {}}
        />
      </>,
    );
    expect(
      screen.getByRole('group', { name: 'Explicit name' }),
    ).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <DatePicker ariaLabel="Birthdate" value="1965-03-20" onChange={() => {}} />,
    );
    await expectNoA11yViolations(container);
  });
});
