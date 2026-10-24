/** Signup page: collects email and password, calls /auth/signup, then shows a "check your inbox" confirmation. In dev (no SES) the API returns the verification token and the link is shown inline. */
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Checkbox } from 'react-aria-components';
import { useAuth } from '../auth/AuthContext';
import { ApiRequestError } from '../api/client';
import { BUSY_MESSAGE, isBusyResponse } from '../api/busy-response';
import { Card } from '../components/Card';
import { Alert } from '../components/Alert';
import { TextInput } from '../components/TextInput';
import { DatePicker } from '../components/DatePicker';
import { Tooltip } from '../components/Tooltip';
import { InfoIcon } from '../components/icons';
import { birthdateBounds, validateBirthdate } from '../lib/birthdate-validation';
import {
  AUTH_PAGE_WRAP,
  AUTH_CARD_WIDTH,
  AuthBrandRow,
  authFieldClass,
  authLabelClass,
  authInputClass,
  authPrimaryButtonClass,
  authSecondaryButtonClass,
  authShowHideButtonClass,
  authMutedClass,
  authHeadingClass,
  DevShortcutBadge,
  authDevLinkClass,
} from './auth-page-chrome';

// Wider than the shared AUTH_CARD_WIDTH: signup packs name + birthdate and email + password into two-column rows that are too cramped at 430px.
const SIGNUP_CARD_WIDTH =
  // eslint-disable-next-line no-restricted-syntax -- signup-only widened card to fit paired-field rows
  'w-full max-w-[680px] shadow-lg rounded-[20px]';

export const SignupPage: React.FC = () => {
  const { signup, resendVerification } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [birthdate, setBirthdate] = useState('');
  // The not-financial-advice acknowledgement: held in the form only, nothing about it is sent to the server; submit is blocked with an accessible error until checked.
  const [agreed, setAgreed] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ email: string; devToken?: string } | null>(null);
  const [resending, setResending] = useState(false);
  const [resendStatus, setResendStatus] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);

  const birthdateRange = birthdateBounds();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // The form is noValidate, so guard the required profile fields here: names non-blank, birthdate a YYYY-MM-DD string.
    if (!firstName.trim()) {
      setFieldError('Enter your first name.');
      return;
    }
    if (!lastName.trim()) {
      setFieldError('Enter your last name.');
      return;
    }
    const birthdateError = validateBirthdate(birthdate);
    if (birthdateError) {
      setFieldError(birthdateError);
      return;
    }
    if (!agreed) {
      setFieldError('Tick the box to confirm you understand this is not financial advice.');
      return;
    }
    setFieldError(null);
    setSubmitting(true);
    setError(null);
    try {
      const res = await signup(
        email,
        password,
        firstName.trim(),
        lastName.trim(),
        birthdate,
      );
      setDone({ email: res.email, devToken: res.verificationToken });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        // A gateway-level throttle or timeout with no error envelope reads the shared busy copy.
        setError(isBusyResponse(err) ? BUSY_MESSAGE : err.error.message);
      } else {
        setError('Sign up failed. Try again in a moment.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onResend = async () => {
    if (!done) return;
    setResending(true);
    setResendStatus(null);
    try {
      const res = await resendVerification(done.email);
      // The server is opaque about whether anything was sent (no enumeration).
      setResendStatus({
        tone: 'success',
        text: res.verificationToken
          ? 'New link issued. Check your inbox (or use the dev shortcut below).'
          : 'If your account is still unverified, a fresh link is on its way.',
      });
      if (res.verificationToken) {
        setDone({ email: done.email, devToken: res.verificationToken });
      }
    } catch (err) {
      if (err instanceof ApiRequestError)
        setResendStatus({ tone: 'error', text: err.error.message });
      else
        setResendStatus({
          tone: 'error',
          text: 'Could not request a new link right now. Try again shortly.',
        });
    } finally {
      setResending(false);
    }
  };

  if (done) {
    return (
      <div className={AUTH_PAGE_WRAP}>
        <Card className={AUTH_CARD_WIDTH}>
          <section aria-labelledby="signup-done-heading" aria-busy="false">
            <AuthBrandRow />
            <h1 id="signup-done-heading" className={authHeadingClass}>
              Check your inbox
            </h1>
            <p>
              We sent a verification link to <strong>{done.email}</strong>. The link is
              valid for 15 minutes. Click it to activate your account, then sign in.
            </p>
            {done.devToken ? (
              <p className={authMutedClass}>
                <small>
                  <DevShortcutBadge />{' '}
                  <Link
                    to={`/auth/verify-email#token=${encodeURIComponent(done.devToken)}`}
                    className={authDevLinkClass}
                  >
                    verify now
                  </Link>
                  .
                </small>
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => navigate('/login')}
              className={authPrimaryButtonClass}
            >
              Go to sign in
            </button>
            <div className="my-3 flex items-center gap-3">
              <hr className="flex-1 border-t border-line" />
              <span className={`text-xs ${authMutedClass}`}>or</span>
              <hr className="flex-1 border-t border-line" />
            </div>
            <button
              type="button"
              className={authSecondaryButtonClass}
              onClick={onResend}
              disabled={resending}
            >
              {resending ? 'Sending…' : 'Resend verification email'}
            </button>
            {resendStatus ? (
              <p
                role={resendStatus.tone === 'error' ? 'alert' : 'status'}
                className={`mt-4 text-sm ${
                  resendStatus.tone === 'error' ? 'text-negative' : 'text-positive'
                }`}
              >
                {resendStatus.text}
              </p>
            ) : null}
          </section>
        </Card>
      </div>
    );
  }

  return (
    <div className={AUTH_PAGE_WRAP}>
      <Card className={SIGNUP_CARD_WIDTH}>
        <section aria-labelledby="signup-heading" aria-busy={submitting}>
          <AuthBrandRow />
          <h1 id="signup-heading" className={authHeadingClass}>
            Create your account
          </h1>
          {error ? (
            <Alert tone="error" data-testid="signup-error">
              {error}
            </Alert>
          ) : null}
          {fieldError ? (
            <Alert tone="error" data-testid="signup-field-error">
              {fieldError}
            </Alert>
          ) : null}
          <form onSubmit={onSubmit} noValidate>
            {/* eslint-disable-next-line no-restricted-syntax -- narrow fixed date-of-birth column, no default-scale token fits */}
            <div className={`${authFieldClass()} grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_150px]`}>
              <div className="min-w-0">
                <label htmlFor="signup-first-name" className={authLabelClass}>
                  First name
                </label>
                <TextInput
                  id="signup-first-name"
                  name="firstName"
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  autoComplete="given-name"
                  required
                  aria-required="true"
                  className={authInputClass}
                />
              </div>
              <div className="min-w-0">
                <label htmlFor="signup-last-name" className={authLabelClass}>
                  Last name
                </label>
                <TextInput
                  id="signup-last-name"
                  name="lastName"
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  autoComplete="family-name"
                  required
                  aria-required="true"
                  className={authInputClass}
                />
              </div>
              <div className="min-w-0">
                <label htmlFor="signup-birthdate" className={authLabelClass}>
                  Date of birth
                </label>
                <DatePicker
                  id="signup-birthdate"
                  value={birthdate}
                  onChange={setBirthdate}
                  min={birthdateRange.min}
                  max={birthdateRange.max}
                  required
                />
              </div>
            </div>
            <div className={`${authFieldClass()} grid grid-cols-1 gap-3 sm:grid-cols-2`}>
              <div className="min-w-0">
                <div className="mb-1 flex items-center justify-between">
                  <label htmlFor="signup-email" className={`${authLabelClass} mb-0`}>
                    Email
                  </label>
                  {/* Invisible same-sized twin of the Password column's Show/Hide button, so both label rows have the same height and the inputs align. */}
                  <span
                    aria-hidden="true"
                    className={`${authShowHideButtonClass} invisible`}
                  >
                    Show
                  </span>
                </div>
                {/* autocomplete="username", not "email": this is the credential identifier, so password managers capture it with the new-password save prompt; type="email" keeps the right keyboard. */}
                <TextInput
                  id="signup-email"
                  name="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  required
                  className={authInputClass}
                />
              </div>
              <div className="min-w-0">
                <div className="mb-1 flex items-center justify-between">
                  <span className="flex items-center gap-1">
                    <label htmlFor="signup-password" className={`${authLabelClass} mb-0`}>
                      Password
                    </label>
                    <Tooltip
                      multiline
                      content="At least 16 characters with uppercase, lowercase, a digit, and a special character."
                    >
                      <span
                        role="img"
                        aria-label="Password requirements"
                        className="inline-flex cursor-help text-muted"
                      >
                        <InfoIcon />
                      </span>
                    </Tooltip>
                  </span>
                  <button
                    type="button"
                    className={authShowHideButtonClass}
                    aria-pressed={showPassword}
                    aria-controls="signup-password"
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
                <TextInput
                  id="signup-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={16}
                  required
                  className={authInputClass}
                />
              </div>
            </div>
            <div className="mb-3 text-sm">
              <Checkbox
                isRequired
                isSelected={agreed}
                onChange={(v) => {
                  setAgreed(v);
                  if (v) setFieldError(null);
                }}
                className="group flex cursor-pointer items-start gap-2"
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex size-5 flex-none items-center justify-center rounded border border-input-line bg-surface text-accent-ink group-data-[selected]:border-accent group-data-[selected]:bg-accent group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-ring group-data-[focus-visible]:ring-offset-2"
                >
                  <svg
                    viewBox="0 0 16 16"
                    className="size-3.5 opacity-0 group-data-[selected]:opacity-100"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                  >
                    <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className="text-ink">I understand this is not financial advice</span>
              </Checkbox>
            </div>
            <button
              type="submit"
              disabled={submitting}
              className={authPrimaryButtonClass}
            >
              {submitting ? 'Creating account…' : 'Create account'}
            </button>
          </form>
          <p className={`mt-4 text-center ${authMutedClass}`}>
            Already have an account? <Link to="/login">Sign in</Link>
          </p>
        </section>
      </Card>
    </div>
  );
};
