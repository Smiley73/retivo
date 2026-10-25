/**
 * Bordered, tinted inline message. Error and warning tones announce via `role="alert"`, the others via
 * `role="status"` ("Accessibility" in docs/ui-conventions.md); override `role` only with a stated reason.
 */
import React from 'react';

type AlertTone = 'error' | 'warning' | 'info' | 'success';

interface AlertProps {
  children: React.ReactNode;
  tone?: AlertTone;
  role?: 'alert' | 'status';
  className?: string;
  /**
   * Test hook: two alerts of the same tone render identically, so a test cannot otherwise tell
   * which surface a message came from.
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
