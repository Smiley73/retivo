/**
 * Form field wrapper — the typed Tailwind-defaults replacement for the
 * legacy `.field` class.
 *
 * Wraps a labelled control: a `<label>` (associated to the control via
 * `htmlFor`/`id`) above the field children, with a consistent bottom
 * margin. Optional helper / error text renders below.
 *
 * BEHAVIORAL RULE — the wrapper carries `min-width: 0`
 * (Tailwind `min-w-0`). A `.field` used as a flex item must be able to
 * shrink below its content's intrinsic width; the default
 * `min-width: auto` resolves to `min-content` and blows constrained
 * parents (e.g. modals) out on first paint. This is the same
 * framework-independent flex-shrink guard the legacy `.field` baked in,
 * re-expressed in Tailwind.
 */
import React from 'react';

interface FieldProps {
  /** Associates the `<label>` to the control (`htmlFor` ↔ control `id`). */
  htmlFor: string;
  label: React.ReactNode;
  children: React.ReactNode;
  /** Muted helper text below the control. */
  hint?: React.ReactNode;
  /** Error message below the control (announced via `role="alert"`). */
  error?: React.ReactNode;
  className?: string;
}

// `min-w-0` is the flex-shrink guard.
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
        // Stable id (`${htmlFor}-error`) so a caller whose control needs
        // more than the automatic label association — e.g. an
        // `aria-describedby` pointer, when the AT contract calls for the
        // error to be explicitly tied to the field that caused it — can
        // reference this element without re-deriving its id.
        <p id={`${htmlFor}-error`} role="alert" className={ERROR_CLASS}>
          {error}
        </p>
      )}
    </div>
  );
};
