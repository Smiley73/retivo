/**
 * Shared chrome for the five unauthenticated auth pages (Login, Signup,
 * VerifyEmail, ApproveSignup, DeclineSignup) — the semantic-token
 * replacement for the legacy `.card` / `.field` / `.secondary` / `.muted`
 * markup each page hand-rolled.
 *
 * The legacy code duplicated the centered-card wrapper + the `BrandRow`
 * across all five pages; this module is the single typed source so the
 * unauthenticated surface stays visually consistent. Visual style only —
 * no behavioral contract. Every fg/bg pair is an AA-safe Graphite Spectrum
 * pair from apps/web/src/lib/contrast.ts.
 */
import React from 'react';
import { Badge } from '../components/Badge';
import { BrandMark } from '../components/BrandMark';
import { TextInput } from '../components/TextInput';
import { RepoLink } from '../components/RepoLink';
import { APP_NAME, APP_TAGLINE } from '../lib/brand';

/** Full-viewport centered wrapper for the auth card. */
export const AUTH_PAGE_WRAP =
  'grid min-h-screen place-items-center px-4 py-8';

/**
 * The auth card sizing — passed to `<Card className>`. The shared `Card` is
 * 16px-radius; the Graphite Spectrum `.signin` mock pins the auth card to a
 * 430px max-width and a 20px corner radius, so both are applied here as
 * arbitrary values (no default-scale token matches the specified pixels).
 */
export const AUTH_CARD_WIDTH =
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum `.signin` mock 430
  'w-full max-w-[430px] shadow-lg ' +
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum `.signin` mock 20px corner radius
  'rounded-[20px]';

/**
 * The auth column width — the card AND any sibling beneath it (e.g. the
 * LoginPage public-computer advisory) share this so they align to the same
 * 430px edge. Without it the advisory inherited a wider `max-w-md` column and
 * over-hung the card on the right.
 */
export const AUTH_COLUMN_WIDTH =
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum `.signin` mock 430
  'w-full max-w-[430px]';

/** Form field wrapper (legacy `.field`: bottom margin + flex-shrink guard). */
export function authFieldClass(extra?: string): string {
  const base = 'mb-3 min-w-0';
  return extra ? `${base} ${extra}` : base;
}

/** Field label (legacy `.field label`). */
export const authLabelClass =
  'mb-1 block text-sm font-medium text-ink';

/**
 * Text input (legacy bespoke input reset). Control boundary uses the
 * dedicated `input-line` token (AA-safe non-text 1.4.11 ≥ 3.0 in both
 * themes via the `.dark` variable swap). Pair registered in contrast.ts.
 */
export const authInputClass =
  'block w-full min-w-0 rounded-md border border-input-line bg-surface px-3 py-2 ' +
  'text-ink placeholder:text-muted ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring';

/**
 * Full-width primary button (legacy default button variant). The lime
 * accent fill with the dark `accent-ink` label (`bg-accent
 * text-accent-ink`, 7.97:1 light / 10.68:1 dark). Dark mode is the same
 * tokens re-pointed by the `.dark` variable swap; no `dark:` twins.
 * Registered "primary button label on accent" in contrast.ts.
 */
export const authPrimaryButtonClass =
  'mt-1 inline-flex w-full items-center justify-center rounded-md ' +
  'bg-accent px-4 py-2 text-sm font-medium text-accent-ink shadow-sm ' +
  'transition-colors hover:bg-accent/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/** Full-width secondary button (legacy `.secondary`). */
export const authSecondaryButtonClass =
  'inline-flex w-full items-center justify-center rounded-md ' +
  'border border-line-strong bg-surface-raised px-4 py-2 text-sm font-medium text-accent-link ' +
  'transition-colors hover:bg-surface-sunken focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Card heading (Preflight strips default `<h1>` size — restore it). The
 * Graphite Spectrum `.signin h2` mock pins the heading to 30px / 800 weight
 * with -.03em tracking; `text-3xl` (30px) + `font-extrabold` (800) are the
 * nearest default-scale tokens, and the tracking is an arbitrary value.
 */
export const authHeadingClass =
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum `.signin h2` mock -.03em tracking
  'mt-2 mb-3 text-3xl font-extrabold tracking-[-0.03em] text-ink';

/**
 * Show/Hide reveal toggle styling for password fields. Placed in the label
 * row (outside the input) so it never collides with a password-manager icon
 * at the input's right edge — the same placement SignupPage established.
 */
export const authShowHideButtonClass =
  'rounded-md border border-accent px-2 py-0.5 text-xs font-medium text-accent-link ' +
  'transition-colors hover:bg-accent-subtle hover:text-ink focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

interface AuthPasswordFieldProps {
  /** Input id, also the label `htmlFor` + the toggle's `aria-controls`. */
  readonly id: string;
  readonly name: string;
  readonly value: string;
  /** Controlled value setter (receives the raw string, not the event). */
  readonly onValueChange: (value: string) => void;
  /** Visible label — defaults to "Password". */
  readonly label?: string;
  readonly autoComplete?: string;
  readonly required?: boolean;
  /** Marks the input `aria-invalid` after a failed validation. */
  readonly ariaInvalid?: boolean;
  /** id of a description element to wire via `aria-describedby`. */
  readonly describedBy?: string;
}

/**
 * Password entry with an in-label Show/Hide reveal toggle, shared by every
 * unauthenticated password field (sign-in, encryption setup, unlock) so they
 * reveal consistently. The toggle is a real `aria-pressed` button wired to the
 * input via `aria-controls`; `type="button"` keeps it out of the submit path.
 */
export const AuthPasswordField: React.FC<AuthPasswordFieldProps> = ({
  id,
  name,
  value,
  onValueChange,
  label = 'Password',
  autoComplete = 'current-password',
  required,
  ariaInvalid,
  describedBy,
}) => {
  const [show, setShow] = React.useState(false);
  return (
    <div className={authFieldClass()}>
      <div className="mb-1 flex items-center justify-between">
        <label htmlFor={id} className={`${authLabelClass} mb-0`}>
          {label}
        </label>
        <button
          type="button"
          className={authShowHideButtonClass}
          aria-pressed={show}
          aria-controls={id}
          onClick={() => setShow((v) => !v)}
        >
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
      <TextInput
        id={id}
        name={name}
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        required={required}
        aria-invalid={ariaInvalid ? true : undefined}
        aria-describedby={describedBy}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        className={authInputClass}
      />
    </div>
  );
};

/** Muted helper / footer copy (legacy `.muted`, AA-safe pair). */
export const authMutedClass = 'text-muted';

/**
 * Dev-only shortcut affordance: a red attention pill before the link(s).
 * Reuses `<Badge tone="disabled">` — an already AA-registered red pair,
 * so no new `contrast.ts` entry is needed — and makes the shortcut stand
 * out without relying on color alone (the pill + the underlined link are
 * the non-color cues, WCAG 1.4.1).
 */
export const DevShortcutBadge: React.FC = () => (
  <Badge tone="disabled" className="mr-1.5 uppercase tracking-wide">
    Dev shortcut
  </Badge>
);

/** Prominent, underlined link style for the dev shortcuts (not
 *  distinguished by color alone). */
export const authDevLinkClass =
  'font-semibold text-accent-link underline underline-offset-2 hover:no-underline';

/** Small status notice pill (legacy `.badge` used as a notice). */
export function authNoticeClass(tone: 'neutral' | 'success'): string {
  const base =
    'mb-4 inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium';
  return tone === 'success'
    ? `${base} border-positive/40 bg-surface-sunken text-positive`
    : `${base} border-line bg-surface-sunken text-muted`;
}

/**
 * Brand lockup shown at the top of every auth card — the legacy `BrandRow` that
 * was copy-pasted into four pages. Renders the RETIVO wordmark, the product
 * tagline, and the open-source line, so every page that mounts
 * `<AuthBrandRow />` carries it.
 */
export const AuthBrandRow: React.FC = () => (
  <div className="mb-2 flex flex-col gap-1">
    <div className="flex flex-wrap items-center gap-3">
      <BrandMark className="size-4 shrink-0" />
      <strong className="tracking-tight">{APP_NAME}</strong>
    </div>
    <p className="text-sm text-muted">{APP_TAGLINE}</p>
    <div className="text-xs">
      <RepoLink kind="open-source" />
    </div>
  </div>
);
