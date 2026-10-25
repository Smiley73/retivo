/**
 * Form field wrapper: a `<label>` associated by `htmlFor` / `id` above the control, with optional hint and error
 * text. `min-w-0` keeps a flex-item field from blowing out constrained parents such as modals.
 */
import React from 'react';

interface FieldProps {
  htmlFor: string;
  label: React.ReactNode;
  children: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  className?: string;
}

const FIELD_CLASS = 'mb-3 min-w-0';

const LABEL_CLASS = 'mb-1 block text-sm font-medium text-ink';

const HINT_CLASS = 'mt-1 text-xs text-muted';

const ERROR_CLASS = 'mt-1 text-xs text-negative';

export const Field: React.FC<FieldProps> = ({
  htmlFor,
  label,
  children,
  hint,
  error,
  className,
}) => {
  const classes = className ? `${FIELD_CLASS} ${className}` : FIELD_CLASS;
  return (
    <div className={classes}>
      <label htmlFor={htmlFor} className={LABEL_CLASS}>
        {label}
      </label>
      {children}
      {hint && <p id={`${htmlFor}-hint`} className={HINT_CLASS}>{hint}</p>}
      {error && (
        // Stable id so a caller can point `aria-describedby` at the error without re-deriving it.
        <p id={`${htmlFor}-error`} role="alert" className={ERROR_CLASS}>
          {error}
        </p>
      )}
    </div>
  );
};
