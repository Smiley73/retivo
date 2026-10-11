/**
 * Social Security monthly-benefit (PIA) capture modal — Add / Edit flow
 * for the per-member SSA benefit record on the Social Security page.
 *
 * Extracted from `SocialSecurityPage.tsx` to keep the page file within
 * the ≤ 400 ln shape limit. Mirrors the `AccountBalanceEntryModal.tsx` /
 * `RetirementAgeModal.tsx` extraction pattern.
 *
 * `<Modal size="lg">` (viewport-centered, focus trap, Esc/scrim); left-
 * aligned, primary-action-first button row; PIA money field
 * (`type="text" inputMode="decimal"`, `parseCurrencyInput`) with
 * dirty-guard close (`onClose` = guarded, `onCancel` = immediate).
 */
import React, { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { TextInput } from '../components/TextInput';
import { Alert } from '../components/Alert';
import { Field } from '../components/Field';
import { Muted } from '../components/Muted';
import { NotesField } from '../components/NotesField';
import { DatePicker } from '../components/DatePicker';
import { btnPrimaryClass, btnSecondaryClass, inputClass } from './profile-page-chrome';
import { parseCurrencyInput } from './AccountBalancesPage';

interface PiaInputProps {
  id: string;
  label: string;
  value: number | null;
  onChange: (dollars: number | null) => void;
}

const PiaInput: React.FC<PiaInputProps> = ({ id, label, value, onChange }) => {
  const [display, setDisplay] = useState(value === null ? '' : value.toFixed(2));
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) setDisplay(value === null ? '' : value.toFixed(2));
  }, [value, isFocused]);

  return (
    <Field htmlFor={id} label={label} className="flex-1">
      <TextInput
        id={id}
        type="text"
        inputMode="decimal"
        pattern="[0-9]*[.,]?[0-9]*"
        placeholder="e.g. 3000"
        value={display}
        onFocus={() => {
          setIsFocused(true);
          setDisplay(value === null ? '' : String(value));
        }}
        onBlur={() => {
          setIsFocused(false);
          setDisplay(value === null ? '' : value.toFixed(2));
        }}
        onChange={(e) => {
          const raw = e.target.value;
          const sanitized = raw.replace(/-/g, '');
          setDisplay(sanitized);
          const cleaned = sanitized.replace(/[$,\s]/g, '');
          if (cleaned === '') {
            onChange(null);
            return;
          }
          const parsed = parseCurrencyInput(sanitized);
          if (parsed !== null && parsed >= 0) onChange(parsed);
        }}
        className={inputClass}
      />
    </Field>
  );
};

export interface SocialSecurityEditState {
  pia: number | null;
  piaAsOfDate: string;
  notes: string;
}

interface SocialSecurityBenefitModalProps {
  open: boolean;
  /** `true` when editing an existing record (drives the title verb). */
  isEdit: boolean;
  /** Resolved member name for the title (already first-name-first). */
  memberName: string;
  editState: SocialSecurityEditState;
  setEditState: React.Dispatch<React.SetStateAction<SocialSecurityEditState>>;
  formError: string | null;
  saving: boolean;
  /** Dirty-guarded close (scrim / Esc) — prompts while dirty. */
  onClose: () => void;
  /** Unguarded close — explicit Cancel button (intentional discard). */
  onCancel: () => void;
  onSave: () => void;
}

export const SocialSecurityBenefitModal: React.FC<
  SocialSecurityBenefitModalProps
> = ({
  open,
  isEdit,
  memberName,
  editState,
  setEditState,
  formError,
  saving,
  onClose,
  onCancel,
  onSave,
}) => (
  <Modal
    open={open}
    onClose={onClose}
    title={
      isEdit
        ? `Edit Social Security info for ${memberName}`
        : `Add Social Security info for ${memberName}`
    }
    size="lg"
    onEnter={() => !saving && onSave()}
  >
    {formError && <Alert tone="error">{formError}</Alert>}
    <div className="mb-3 flex flex-wrap items-start gap-3">
      <PiaInput
        id="ss-pia"
        label="Monthly benefit at full retirement age (today's dollars)"
        value={editState.pia}
        onChange={(v) => setEditState((s) => ({ ...s, pia: v }))}
      />
    </div>
    <div className="mb-3 flex flex-wrap items-start gap-3">
      <Field htmlFor="ss-as-of" label="Date on the SSA statement" className="flex-1">
        <DatePicker
          id="ss-as-of"
          ariaLabel="Date on the SSA statement"
          value={editState.piaAsOfDate}
          onChange={(v) =>
            setEditState((s) => ({ ...s, piaAsOfDate: v }))
          }
          // A statement can't be dated in the future — its year is the
          // engine's COLA anchor, and a future anchor would deflate near-term
          // benefits. Save also rejects a future date (no silent clamp).
          max={new Date().toISOString().slice(0, 10)}
        />
        {/* The statement date is the projection's cost-of-living anchor —
            the quoted amount already includes every increase through this
            date, so projections add increases only for later years. */}
        <Muted as="p" className="m-0 mt-1 text-xs">
          Projections use this date as the starting point for future
          cost-of-living increases — the statement amount already includes
          increases through this date. A newer statement keeps estimates
          accurate.
        </Muted>
      </Field>
    </div>
    <NotesField
      id="ss-notes"
      label="Notes (optional)"
      className="mb-2"
      value={editState.notes}
      onChange={(v) => setEditState((s) => ({ ...s, notes: v }))}
      rows={3}
      maxLength={2000}
    />
    {/* Left-aligned, primary (Save) first — AGENTS modal rule. */}
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <button
        type="button"
        className={btnPrimaryClass}
        onClick={onSave}
        disabled={saving}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        className={btnSecondaryClass}
        onClick={onCancel}
        disabled={saving}
      >
        Cancel
      </button>
    </div>
  </Modal>
);
