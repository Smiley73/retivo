/**
 * Password-manager interop helpers: `HiddenUsernameField` and `PM_IGNORE_ATTRS`. See "Password managers" in
 * docs/ui-conventions.md.
 */
import React from 'react';

/**
 * Vendor opt-out attributes for secrets that are not credentials; Keeper and browser built-ins have
 * none and rely on `autocomplete="off"`.
 */
export const PM_IGNORE_ATTRS = {
  /** 1Password */
  'data-1p-ignore': true,
  /** LastPass */
  'data-lpignore': 'true',
  /** Bitwarden */
  'data-bwignore': true,
  /** Dashlane */
  'data-form-type': 'other',
} as const;

interface HiddenUsernameFieldProps {
  /** The account email; renders nothing when empty (unknown). */
  readonly email: string;
}

/**
 * Visually-hidden username field that lets password managers associate a password-entry form with
 * the right credential. `sr-only` rather than `display:none`, which managers skip. A raw `<input>`
 * per the AGENTS.md non-React-Aria exception: it is non-interactive and AT-hidden.
 */
export const HiddenUsernameField: React.FC<HiddenUsernameFieldProps> = ({
  email,
}) =>
  email ? (
    <input
      className="sr-only"
      type="email"
      name="username"
      autoComplete="username"
      value={email}
      readOnly
      tabIndex={-1}
      aria-hidden="true"
    />
  ) : null;
