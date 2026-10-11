/**
 * Notes textarea — shared `<TextField>` + `<TextArea>` (React Aria)
 * wrapped by the typed `<Field>` for label + helper / error wiring. The
 * single typed control for every "Notes (optional)" surface; replaces
 * the raw `<textarea>` + `textareaClass` per-site pattern.
 *
 * Behavioral contract (per-site preservation):
 * - `rows` and `maxLength` pass through with NO defaults; each migrated
 *   site supplies its own contract (`rows=2 maxLength=200` Income,
 *   `rows=3 maxLength=2000` SS benefit / `rows=3` no max on the balance
 *   comment, `rows=4 maxLength=MAX_NOTES` Scenario, `rows=4` no max on
 *   Account notes). No silent text-limit shifts.
 * - `error` renders as a `role="alert"` paragraph (live region) below
 *   the textarea.
 */
import React from 'react';
import { TextField, TextArea } from 'react-aria-components';
import { Field } from './Field';

interface NotesFieldProps {
  id: string;
  label: React.ReactNode;
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  helpText?: React.ReactNode;
  error?: React.ReactNode;
  className?: string;
}

// Control vocabulary matches the shared input control: the load-bearing
// `input-line` boundary, the lime `ring` focus, and the normal surface
// fill (Graphite Spectrum semantic tokens); the disabled state recedes
// to the sunken surface. Dark mode is the `.dark` variable swap.
const TEXTAREA_CLASS =
  'block w-full min-w-0 rounded-md border border-input-line bg-surface px-3 py-2 ' +
  'text-sm text-ink placeholder:text-muted ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted';

export const NotesField: React.FC<NotesFieldProps> = ({
  id,
  label,
  value,
  onChange,
  rows,
  maxLength,
  placeholder,
  helpText,
  error,
  className,
}) => {
  return (
    <Field htmlFor={id} label={label} hint={helpText} error={error} className={className}>
      <TextField
        value={value}
        onChange={onChange}
        maxLength={maxLength}
      >
        <TextArea
          id={id}
          rows={rows}
          placeholder={placeholder}
          className={TEXTAREA_CLASS}
        />
      </TextField>
    </Field>
  );
};
