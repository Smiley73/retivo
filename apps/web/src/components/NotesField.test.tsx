/** NotesField: label association, rows and maxLength pass-through, and the error rendered via role="alert". */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NotesField } from './NotesField';
import { expectNoA11yViolations } from '../test/a11y';

describe('NotesField', () => {
  it('associates the label with the textarea', () => {
    render(
      <NotesField
        id="n1"
        label="Notes"
        value=""
        onChange={() => {}}
        rows={3}
      />,
    );
    const ta = screen.getByLabelText('Notes');
    expect(ta.tagName).toBe('TEXTAREA');
    expect(ta).toHaveAttribute('rows', '3');
  });

  it('forwards rows and maxLength without defaults', () => {
    render(
      <NotesField
        id="n2"
        label="Comment"
        value=""
        onChange={() => {}}
        rows={2}
        maxLength={200}
      />,
    );
    const ta = screen.getByLabelText('Comment') as HTMLTextAreaElement;
    expect(ta.rows).toBe(2);
    expect(ta.maxLength).toBe(200);
  });

  it('clamps typed input to maxLength', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <NotesField
        id="n3"
        label="Short"
        value=""
        onChange={onChange}
        rows={2}
        maxLength={5}
      />,
    );
    const ta = screen.getByLabelText('Short');
    await user.type(ta, 'abcdefghij');
    const lastCall = onChange.mock.calls.at(-1)?.[0] as string | undefined;
    expect(lastCall?.length ?? 0).toBeLessThanOrEqual(5);
  });

  it('renders the error string as a live region', () => {
    render(
      <NotesField
        id="n4"
        label="Notes"
        value=""
        onChange={() => {}}
        rows={2}
        error="Too long"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Too long');
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <NotesField
        id="n5"
        label="Notes"
        value="something"
        onChange={() => {}}
        rows={3}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
