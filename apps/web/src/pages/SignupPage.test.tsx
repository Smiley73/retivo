/**
 * SignupPage submit-handler client-side validation + the not-financial-advice
 * acknowledgement.
 *
 * The form is `noValidate`, so the onSubmit handler must block submission
 * (without calling signup()) when first name, last name, birthdate, or the
 * acknowledgement checkbox is missing/unchecked, and pass all through when
 * valid.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../test/a11y';
import { ApiRequestError } from '../api/client';

const signupMock = vi.fn();

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ signup: signupMock, resendVerification: vi.fn() }),
}));

import { SignupPage } from './SignupPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <SignupPage />
    </MemoryRouter>,
  );
}

async function fillEmailPassword(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'jane@example.test');
  await user.type(screen.getByLabelText('Password'), 'TestPassw0rd!Test');
}

async function fillProfile(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('First name'), 'Jane');
  await user.type(screen.getByLabelText('Last name'), 'Smith');
  await user.type(screen.getByRole('spinbutton', { name: /month/i }), '4');
  await user.type(screen.getByRole('spinbutton', { name: /day/i }), '15');
  await user.type(screen.getByRole('spinbutton', { name: /year/i }), '1980');
}

const submit = () => screen.getByRole('button', { name: /create account/i });
const CHECKBOX_LABEL = 'I understand this is not financial advice';
const agreeCheckbox = () => screen.getByRole('checkbox', { name: CHECKBOX_LABEL });

describe('SignupPage client-side validation', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('blocks submission and does not call signup when first name is empty', async () => {
    const user = userEvent.setup();
    renderPage();
    await fillEmailPassword(user);
    await user.type(screen.getByLabelText('Last name'), 'Smith');
    await user.click(submit());
    expect(signupMock).not.toHaveBeenCalled();
    expect(screen.getByText('Enter your first name.')).toBeInTheDocument();
  });

  it('blocks submission and does not call signup when last name is empty', async () => {
    const user = userEvent.setup();
    renderPage();
    await fillEmailPassword(user);
    await user.type(screen.getByLabelText('First name'), 'Jane');
    await user.click(submit());
    expect(signupMock).not.toHaveBeenCalled();
    expect(screen.getByText('Enter your last name.')).toBeInTheDocument();
  });

  it('blocks submission and does not call signup when birthdate is empty', async () => {
    const user = userEvent.setup();
    renderPage();
    await fillEmailPassword(user);
    await user.type(screen.getByLabelText('First name'), 'Jane');
    await user.type(screen.getByLabelText('Last name'), 'Smith');
    await user.click(submit());
    expect(signupMock).not.toHaveBeenCalled();
    expect(screen.getByText('Enter your date of birth.')).toBeInTheDocument();
  });

  it('blocks submission and does not call signup when birthdate is more than 120 years ago', async () => {
    const user = userEvent.setup();
    renderPage();
    await fillEmailPassword(user);
    await user.type(screen.getByLabelText('First name'), 'Jane');
    await user.type(screen.getByLabelText('Last name'), 'Smith');
    await user.type(screen.getByRole('spinbutton', { name: /month/i }), '1');
    await user.type(screen.getByRole('spinbutton', { name: /day/i }), '1');
    await user.type(screen.getByRole('spinbutton', { name: /year/i }), '1800');
    await user.click(agreeCheckbox());
    await user.click(submit());
    expect(signupMock).not.toHaveBeenCalled();
    expect(
      screen.getByText('Date of birth must be within the last 120 years.'),
    ).toBeInTheDocument();
  });

  // The account cannot be created until the unchecked checkbox is checked.
  // The Create account button stays present/clickable, but submit is blocked
  // with an accessible (role="alert") error and signup() is never called.
  it('blocks submission and announces an error when the checkbox is unchecked', async () => {
    const user = userEvent.setup();
    renderPage();
    await fillEmailPassword(user);
    await fillProfile(user);
    expect(agreeCheckbox()).not.toBeChecked();
    await user.click(submit());
    expect(signupMock).not.toHaveBeenCalled();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not financial advice/i);
  });

  it('calls signup with name + birthdate once all fields are valid and the box is checked', async () => {
    const user = userEvent.setup();
    signupMock.mockResolvedValue({ email: 'jane@example.test' });
    renderPage();
    await fillEmailPassword(user);
    await fillProfile(user);
    await user.click(agreeCheckbox());
    expect(agreeCheckbox()).toBeChecked();

    await user.click(submit());

    await waitFor(() =>
      expect(signupMock).toHaveBeenCalledWith(
        'jane@example.test',
        'TestPassw0rd!Test',
        'Jane',
        'Smith',
        '1980-04-15',
      ),
    );
  });

  // The visible label is the checkbox's accessible name (queried by role and
  // name above), and it is the only checkbox on the page.
  it('has exactly one checkbox, unchecked, required, named by its visible label', () => {
    renderPage();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(agreeCheckbox()).not.toBeChecked();
    expect(agreeCheckbox()).toBeRequired();
  });

  it('renders no Terms or Privacy link and no data-summary or waiver text', () => {
    const { container } = renderPage();
    expect(screen.queryByRole('link', { name: /terms/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /privacy/i })).not.toBeInTheDocument();
    expect(container.querySelector('a[href^="/terms"], a[href^="/privacy"]')).toBeNull();
    expect(container.textContent).not.toMatch(/terms|privacy|waive|stored/i);
  });

  it('makes no network request on mount', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderPage();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  // Submitting with the box unchecked shows the accessible error and never
  // calls signup(); checking the box clears the alert; a subsequent submit then
  // goes through.
  it('clears the error once the box is checked, then submits', async () => {
    const user = userEvent.setup();
    signupMock.mockResolvedValue({ email: 'jane@example.test' });
    renderPage();
    await fillEmailPassword(user);
    await fillProfile(user);
    await user.click(submit());
    expect(signupMock).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(/not financial advice/i);
    await user.click(agreeCheckbox());
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
    await user.click(submit());
    await waitFor(() => expect(signupMock).toHaveBeenCalledTimes(1));
  });

  // Password-manager interop: the email field
  // is the credential identifier, so it hints `username` (not `email`) —
  // managers capture it with the new-password save prompt. type="email"
  // keeps the email keyboard + native semantics.
  it('hints the email field as the credential identifier (autocomplete="username")', () => {
    renderPage();
    const email = screen.getByLabelText('Email');
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
  });

  // Password policy: the client-side
  // minLength hint reflects the raised 16-character minimum and the new
  // required special character. The field is `minLength`/`required` only for
  // the browser hint — the form is `noValidate`, so the server still enforces
  // the policy and surfaces PASSWORD_TOO_SHORT / PASSWORD_WEAK.
  it('reflects the 16-character + special-character policy in the field and info-icon tooltip', async () => {
    const user = userEvent.setup();
    renderPage();
    const password = screen.getByLabelText('Password');
    expect(password).toHaveAttribute('minLength', '16');
    // The requirement copy now lives behind an info-(i) tooltip next to the
    // "Password" label instead of an always-visible hint. It is hidden until
    // the keyboard-focusable trigger is focused, then reveals the full text.
    const trigger = screen.getByLabelText('Password requirements');
    expect(trigger).toHaveClass('cursor-help');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await user.hover(trigger);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'At least 16 characters with uppercase, lowercase, a digit, and a special character.',
    );
  });

  it('has no a11y violations on the signup form', async () => {
    const { container } = renderPage();
    await expectNoA11yViolations(container);
  });

  describe('server errors', () => {
    async function submitValidForm(user: ReturnType<typeof userEvent.setup>) {
      await fillEmailPassword(user);
      await fillProfile(user);
      await user.click(agreeCheckbox());
      await user.click(submit());
    }

    it('shows the server message verbatim (EMAIL_TAKEN)', async () => {
      const user = userEvent.setup();
      signupMock.mockRejectedValueOnce(
        new ApiRequestError(409, {
          code: 'EMAIL_TAKEN',
          message: 'An account with this email already exists.',
        }),
      );
      renderPage();
      await submitValidForm(user);

      expect(
        await screen.findByText('An account with this email already exists.'),
      ).toBeInTheDocument();
    });
  });

  // Inline "service is busy" copy: a gateway-level throttle/timeout with no
  // error envelope shows
  // the shared busy sentence in the page-level `signup-error` surface only —
  // never `signup-field-error`.
  describe('busy-response handling', () => {
    const BUSY_MESSAGE = 'The service is busy right now. Please try again in a moment.';

    async function submitValidForm(user: ReturnType<typeof userEvent.setup>) {
      await fillEmailPassword(user);
      await fillProfile(user);
      await user.click(agreeCheckbox());
      await user.click(submit());
    }

    it('shows the busy sentence for a no-envelope 5xx', async () => {
      const user = userEvent.setup();
      signupMock.mockRejectedValueOnce(
        new ApiRequestError(503, { code: 'UNKNOWN_ERROR', message: 'Service Unavailable' }),
      );
      renderPage();
      await submitValidForm(user);

      const alert = await screen.findByTestId('signup-error');
      expect(alert).toHaveTextContent(BUSY_MESSAGE);
      expect(screen.queryByTestId('signup-field-error')).not.toBeInTheDocument();
    });

    it('a genuine enveloped 5xx renders its own message, not the busy copy', async () => {
      const user = userEvent.setup();
      signupMock.mockRejectedValueOnce(
        new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Something broke.' }),
      );
      renderPage();
      await submitValidForm(user);

      const alert = await screen.findByTestId('signup-error');
      expect(alert).toHaveTextContent('Something broke.');
      expect(screen.queryByText(BUSY_MESSAGE)).not.toBeInTheDocument();
    });
  });
});
