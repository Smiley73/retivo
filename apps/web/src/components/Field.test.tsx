/** Field: label association, hint and error (error as a live region), and the min-w-0 flex-shrink guard. */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Field } from './Field';
import { expectNoA11yViolations } from '../test/a11y';

describe('Field', () => {
  it('associates the label with the control', () => {
    render(
      <Field htmlFor="email" label="Email">
        <input id="email" type="text" />
      </Field>,
    );
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('renders hint and error (error as a live region)', () => {
    render(
      <Field
        htmlFor="amt"
        label="Amount"
        hint="Pre-tax dollars"
        error="Required"
      >
        <input id="amt" type="text" />
      </Field>,
    );
    expect(screen.getByText('Pre-tax dollars')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Required');
  });

  it('carries the preserved min-w-0 flex-shrink guard on the wrapper', () => {
    const { container } = render(
      <Field htmlFor="x" label="X">
        <input id="x" type="text" />
      </Field>,
    );
    expect(container.firstElementChild?.className).toContain('min-w-0');
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <Field htmlFor="name" label="Full name" hint="As it appears on file">
        <input id="name" type="text" />
      </Field>,
    );
    await expectNoA11yViolations(container);
  });
});
