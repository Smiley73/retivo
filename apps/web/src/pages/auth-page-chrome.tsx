/** Shared chrome for the unauthenticated auth pages: centered card wrapper, field and button classes, password field and brand row. */
import React from 'react';
import { Badge } from '../components/Badge';
import { BrandMark } from '../components/BrandMark';
import { TextInput } from '../components/TextInput';
import { RepoLink } from '../components/RepoLink';
import { APP_NAME, APP_TAGLINE } from '../lib/brand';

export const AUTH_PAGE_WRAP =
  'grid min-h-screen place-items-center px-4 py-8';

export const AUTH_CARD_WIDTH =
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum `.signin` mock 430
  'w-full max-w-[430px] shadow-lg ' +
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum `.signin` mock 20px corner radius
  'rounded-[20px]';

/** Shared by the card and any sibling beneath it (e.g. the public-computer advisory) so they align to the same edge. */
export const AUTH_COLUMN_WIDTH =
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum `.signin` mock 430
  'w-full max-w-[430px]';

export function authFieldClass(extra?: string): string {
  const base = 'mb-3 min-w-0';
  return extra ? `${base} ${extra}` : base;
}

export const authLabelClass =
  'mb-1 block text-sm font-medium text-ink';

/** The control boundary uses the `input-line` token (WCAG 1.4.11 non-text contrast in both themes). */
export const authInputClass =
  'block w-full min-w-0 rounded-md border border-input-line bg-surface px-3 py-2 ' +
  'text-ink placeholder:text-muted ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring';

export const authPrimaryButtonClass =
  'mt-1 inline-flex w-full items-center justify-center rounded-md ' +
  'bg-accent px-4 py-2 text-sm font-medium text-accent-ink shadow-sm ' +
  'transition-colors hover:bg-accent/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const authSecondaryButtonClass =
  'inline-flex w-full items-center justify-center rounded-md ' +
  'border border-line-strong bg-surface-raised px-4 py-2 text-sm font-medium text-accent-link ' +
  'transition-colors hover:bg-surface-sunken focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const authHeadingClass =
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum `.signin h2` mock -.03em tracking
  'mt-2 mb-3 text-3xl font-extrabold tracking-[-0.03em] text-ink';

/** Sits in the label row so it never collides with a password-manager icon at the input's right edge. */
export const authShowHideButtonClass =
  'rounded-md border border-accent px-2 py-0.5 text-xs font-medium text-accent-link ' +
  'transition-colors hover:bg-accent-subtle hover:text-ink focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

interface AuthPasswordFieldProps {
  /** Input id, also the label `htmlFor` + the toggle's `aria-controls`. */
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly label?: string;
  readonly autoComplete?: string;
  readonly required?: boolean;
  /** Marks the input `aria-invalid` after a failed validation. */
  readonly ariaInvalid?: boolean;
  readonly describedBy?: string;
}

/** Password entry with a Show/Hide toggle (an aria-pressed button wired by aria-controls, type="button" so it stays out of the submit path). */
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

export const authMutedClass = 'text-muted';

/** Dev-only shortcut pill; the pill plus the underlined link are non-color cues (WCAG 1.4.1). */
export const DevShortcutBadge: React.FC = () => (
  <Badge tone="disabled" className="mr-1.5 uppercase tracking-wide">
    Dev shortcut
  </Badge>
);

export const authDevLinkClass =
  'font-semibold text-accent-link underline underline-offset-2 hover:no-underline';

export function authNoticeClass(tone: 'neutral' | 'success'): string {
  const base =
    'mb-4 inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium';
  return tone === 'success'
    ? `${base} border-positive/40 bg-surface-sunken text-positive`
    : `${base} border-line bg-surface-sunken text-muted`;
}

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
