/**
 * Shared Notes textarea (React Aria `TextField` / `TextArea` in a `<Field>`); `rows` and `maxLength` pass through
 * with no defaults, so each site keeps its own limits.
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
