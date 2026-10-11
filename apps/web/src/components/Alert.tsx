/**
 * Inline alert — the typed message block for the Graphite Spectrum
 * semantic-token system.
 *
 * A bordered, soft-tinted message block. `tone="error"` (default) is the
 * negative (red) state; the other tones map to the `warning` / `info` /
 * `positive` state tokens. Each renders its state-token text on the
 * sunken surface with a state-tinted hairline — every painted text pair
 * is registered WCAG-AA-safe in contrast.ts. Dark mode is the `.dark`
 * variable swap (no `dark:` colour twins).
 *
 * PRESERVED BEHAVIORAL RULE — error/warning alerts announce via
 * `role="alert"` (live region), the framework-independent a11y rule
 * the app already relies on (see "Accessibility" in
 * docs/ui-conventions.md). Informational/success tones use
 * `role="status"` (polite). Override
 * with an explicit `role` only with a stated reason.
 */
import React from 'react';

type AlertTone = 'error' | 'warning' | 'info' | 'success';

interface AlertProps {
  children: React.ReactNode;
  tone?: AlertTone;
  /** Override the default live-region role (error/warning → assertive). */
  role?: 'alert' | 'status';
  className?: string;
  /**
   * Optional test hook. Two alerts of the same tone on one page render
   * identically (same role, same classes), so a test cannot otherwise tell
   * which surface a message arrived on — see `SignupPage`'s page-level vs
   * clickwrap/field alerts.
   */
  'data-testid'?: string;
}

const BASE_CLASS = 'mb-4 rounded-md border px-3.5 py-2.5 text-sm';

const TONE_CLASS: Record<AlertTone, string> = {
  error: 'border-negative/40 bg-surface-sunken text-negative',
  warning: 'border-warning/40 bg-surface-sunken text-warning',
  info: 'border-info/40 bg-surface-sunken text-info',
  success: 'border-positive/40 bg-surface-sunken text-positive',
};

const ASSERTIVE_TONES: ReadonlySet<AlertTone> = new Set(['error', 'warning']);

export const Alert: React.FC<AlertProps> = ({
  children,
  tone = 'error',
  role,
  className,
  'data-testid': testId,
}) => {
  const resolvedRole =
    role ?? (ASSERTIVE_TONES.has(tone) ? 'alert' : 'status');
  const classes = [BASE_CLASS, TONE_CLASS[tone], className]
    .filter(Boolean)
    .join(' ');
  return (
    <div role={resolvedRole} className={classes} data-testid={testId}>
      {children}
    </div>
  );
};
