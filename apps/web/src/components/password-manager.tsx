/**
 * Password-manager interop helpers (see "Password managers" in
 * docs/ui-conventions.md). Two concerns, one module:
 *
 * 1. `HiddenUsernameField` — a visually-hidden username/email input
 *    placed inside every password-entry `<form>` that has no visible
 *    identifier field (re-auth prompts, change-password, unlock,
 *    password reset). Browser password managers key autofill and the
 *    "save / update password?" prompt on a `autocomplete="username"`
 *    field in the same form; without one they guess — or skip the form
 *    entirely (web.dev sign-in form best practices).
 *
 * 2. `PM_IGNORE_ATTRS` — vendor opt-out attributes for inputs that are
 *    secrets but NOT credentials (recovery key, type-to-confirm
 *    phrase). `autocomplete="off"` alone is widely ignored by manager
 *    extensions; these attributes stop the overlay icon / save prompt
 *    where the vendor supports one.
 */
import React from 'react';

/**
 * Spread onto a `TextInput` (alongside `autoComplete="off"`) to keep
 * password-manager extensions from offering to fill or save the field.
 * Keeper and the browser built-ins have no opt-out attribute and rely
 * on `autocomplete="off"` + a non-credential `type`/`name`.
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
 * Visually-hidden username field for password-entry forms. `sr-only`
 * (not `display:none` / `hidden` — password managers skip fields they
 * consider invisible-by-display), `readOnly`, out of the tab order, and
 * `aria-hidden` so neither users nor assistive tech ever interact with
 * it: it exists solely so password managers associate the form with the
 * right credential.
 *
 * Deliberately a raw `<input>` rather than the React Aria `TextInput`
 * (AGENTS.md non-RA-primitive exception): it is non-interactive and
 * AT-hidden, so RA's label/field wiring has nothing to wire.
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
