/**
 * Password-manager interop helpers — asserts the HiddenUsernameField
 * contract (sr-only, readOnly, untabbable, AT-hidden, correct
 * `name`/`autocomplete` tokens, renders nothing without an email), the
 * PM_IGNORE_ATTRS token set, and the shared-component axe rule (AGENTS
 * mandate).
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { expectNoA11yViolations } from '../test/a11y';
import { HiddenUsernameField, PM_IGNORE_ATTRS } from './password-manager';

describe('HiddenUsernameField', () => {
  it('renders a visually-hidden readOnly username input for password managers', () => {
    const { container } = render(
      <HiddenUsernameField email="ada@example.com" />,
    );
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    expect(input).toHaveAttribute('type', 'email');
    expect(input).toHaveAttribute('name', 'username');
    expect(input).toHaveAttribute('autocomplete', 'username');
    expect(input).toHaveValue('ada@example.com');
    expect(input).toHaveAttribute('readonly');
    // Out of the tab order + AT-hidden, but NOT display:none — managers
    // skip display-hidden fields.
    expect(input).toHaveAttribute('tabindex', '-1');
    expect(input).toHaveAttribute('aria-hidden', 'true');
    expect(input).toHaveClass('sr-only');
  });

  it('renders nothing when the email is unknown', () => {
    const { container } = render(<HiddenUsernameField email="" />);
    expect(container.querySelector('input')).toBeNull();
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <HiddenUsernameField email="ada@example.com" />,
    );
    await expectNoA11yViolations(container);
  });
});

describe('PM_IGNORE_ATTRS', () => {
  it('carries the four vendor opt-out attributes', () => {
    expect(PM_IGNORE_ATTRS).toEqual({
      'data-1p-ignore': true,
      'data-lpignore': 'true',
      'data-bwignore': true,
      'data-form-type': 'other',
    });
  });
});
