/** Retirement-Age modal: age inputs per member, the retirement-timing mode picker and the same-date-anchor recompute with day-of-month snapping, behind the unsaved-edits guard. Shared primitives live in scenario-age-modal-shared.tsx. */
import React, { useMemo, useState } from 'react';
import { textLinkClass } from '../components/TextLink';
import { Link } from 'react-router';
import { Modal } from '../components/Modal';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import { useDirtyModalClose } from '../components/UnsavedChangesGuard';
import { Alert } from '../components/Alert';
import { Muted } from '../components/Muted';
import { saveScenario } from '../lib/scenario-mutations';
import { resolveScenario } from '../lib/scenario-resolution';
import { retirementDate } from '../lib/retirement-date-math';
import {
  bannerClass,
  btnPrimaryClass,
  btnSecondaryClass,
  FieldGroup,
} from './scenarios-page-chrome';
import {
  AgeInputs,
  RetirementDateLine,
  DEFAULT_PER_MEMBER_AGE,
  DEFAULT_RETIREMENT,
  modeOf,
  recomputeNonAnchorAge,
  type RetirementMode,
} from './scenario-age-modal-shared';
import type {
  Aggregate,
  HouseholdMemberPayload,
  RetirementAgeOverride,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

interface RetirementAgeModalProps {
  open: boolean;
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  primaryMember: Aggregate<HouseholdMemberPayload> | null;
  secondaryMember: Aggregate<HouseholdMemberPayload> | null;
  householdId: string;
  onClose: (saved: boolean) => void;
}

export const RetirementAgeModal: React.FC<RetirementAgeModalProps> = ({
  open,
  scenario,
  scenarios,
  primaryMember,
  secondaryMember,
  householdId,
  onClose,
}) => {
  const primaryBirthdate = primaryMember?.payload.birthdate;
  const secondaryBirthdate = secondaryMember?.payload.birthdate;
  const primaryName = primaryMember?.payload.firstName?.trim() || 'Primary';
  const secondaryName = secondaryMember?.payload.firstName?.trim() || 'Secondary';

  const baseline = useMemo<RetirementAgeOverride>(() => {
    const ownOverride = scenario.payload.overrides.retirementAge;
    if (ownOverride) return ownOverride;
    if (scenario.payload.parentScenarioId !== null) {
      const inherited = resolveScenario(
        scenario.payload.parentScenarioId,
        scenarios,
      );
      return inherited.retirementAge ?? DEFAULT_RETIREMENT;
    }
    return DEFAULT_RETIREMENT;
  }, [scenario, scenarios]);

  // Fills in a missing secondary value and recomputes any anchored side so storage reflects the new value even if the birthdates shifted since the last save.
  const initialDraft = useMemo<RetirementAgeOverride>(() => {
    let d: RetirementAgeOverride = { ...baseline };
    if (secondaryMember && !d.secondary) {
      d = { ...d, secondary: DEFAULT_PER_MEMBER_AGE };
    }
    return recomputeNonAnchorAge(d, primaryBirthdate, secondaryBirthdate);
  }, [baseline, secondaryMember, primaryBirthdate, secondaryBirthdate]);

  const [draft, setDraft] = useState<RetirementAgeOverride>(initialDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(initialDraft);
  const { guardedClose, immediateClose, confirmModal } = useDirtyModalClose(
    isDirty,
    () => onClose(false),
  );

  const mode = modeOf(draft);

  const updatePrimaryAge = (key: 'ageYears' | 'ageMonths', value: number) => {
    const next: RetirementAgeOverride = {
      ...draft,
      primary: { ...draft.primary, [key]: value },
    };
    setDraft(recomputeNonAnchorAge(next, primaryBirthdate, secondaryBirthdate));
  };

  const updateSecondaryAge = (key: 'ageYears' | 'ageMonths', value: number) => {
    if (!draft.secondary) return;
    const next: RetirementAgeOverride = {
      ...draft,
      secondary: { ...draft.secondary, [key]: value },
    };
    setDraft(recomputeNonAnchorAge(next, primaryBirthdate, secondaryBirthdate));
  };

  const onModeChange = (next: RetirementMode) => {
    let nextDraft: RetirementAgeOverride;
    if (next === 'independent') {
      nextDraft = {
        primary: draft.primary,
        secondary: draft.secondary ?? DEFAULT_PER_MEMBER_AGE,
      };
    } else if (next === 'sameDateAnchorPrimary') {
      nextDraft = {
        primary: draft.primary,
        secondary: draft.secondary ?? DEFAULT_PER_MEMBER_AGE,
        sameDateAnchor: 'primary',
      };
    } else {
      nextDraft = {
        primary: draft.primary,
        secondary: draft.secondary ?? DEFAULT_PER_MEMBER_AGE,
        sameDateAnchor: 'secondary',
      };
    }
    setDraft(
      recomputeNonAnchorAge(nextDraft, primaryBirthdate, secondaryBirthdate),
    );
  };

  const onSave = async () => {
    setSubmitting(true);
    try {
      const persisted: RetirementAgeOverride = secondaryMember
        ? draft
        : { primary: draft.primary };
      const payload: ScenarioPayload = {
        ...scenario.payload,
        overrides: { ...scenario.payload.overrides, retirementAge: persisted },
      };
      await saveScenario({ scenario, payload, householdId });
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
      setSubmitting(false);
    }
  };

  // Independent mode signals the user may want different dates, so it warns whatever the current ages; same-date modes guarantee one date and never warn.
  const showWarning = secondaryMember !== null && mode === 'independent';

  const primaryAriaPrefix = `${primaryName.toLocaleLowerCase()}-retirement`;
  const secondaryAriaPrefix = `${secondaryName.toLocaleLowerCase()}-retirement`;
  const primaryEditable = mode !== 'sameDateAnchorSecondary';
  const secondaryEditable = mode !== 'sameDateAnchorPrimary';

  // The non-anchor's "Retires" line snaps to the anchor's exact ISO date, since birthdate + age lands on different days when the birth days of month differ.
  let anchorDate: string | null = null;
  try {
    if (mode === 'sameDateAnchorPrimary' && primaryBirthdate) {
      anchorDate = retirementDate(primaryBirthdate, draft.primary);
    } else if (
      mode === 'sameDateAnchorSecondary' &&
      secondaryBirthdate &&
      draft.secondary
    ) {
      anchorDate = retirementDate(secondaryBirthdate, draft.secondary);
    }
  } catch {
    anchorDate = null;
  }

  return (
    <Modal open={open} onClose={guardedClose} title="Retirement Age" size="xl">
      <div className="flex flex-col gap-3">
        <p className="m-0 text-sm">
          Set the age each household member stops working. This is when the
          projection switches from saving to spending down your accounts, so it
          drives when income, expenses, and withdrawals begin.
        </p>

        {!primaryMember && (
          <Muted as="p">
            No primary household member yet. Add one from{' '}
            <Link to="/household" className={textLinkClass}>
              Household
            </Link>
            .
          </Muted>
        )}

        {primaryMember && secondaryMember && (
          <div className="flex flex-col gap-1.5">
            <header
              id="retirement-timing-heading"
              className="mb-1 text-sm font-medium text-muted"
            >
              Retirement timing
            </header>
            <SegmentedRadioGroup
              ariaLabel="Retirement timing"
              value={mode}
              onChange={(v) => onModeChange(v as RetirementMode)}
              options={[
                { value: 'independent', label: 'Each retires independently' },
                {
                  value: 'sameDateAnchorPrimary',
                  label: `Both retire when ${primaryName} retires`,
                },
                {
                  value: 'sameDateAnchorSecondary',
                  label: `Both retire when ${secondaryName} retires`,
                },
              ]}
            />
          </div>
        )}

        {primaryMember && (
          <FieldGroup
            id="primary-retirement-heading"
            legend={
              <>
                {primaryName} (primary)
                {!primaryEditable && (
                  <span className="ml-2 text-muted">
                    derived from {secondaryName}'s retirement date
                  </span>
                )}
              </>
            }
          >
            <AgeInputs
              ageYears={draft.primary.ageYears}
              ageMonths={draft.primary.ageMonths}
              onChange={updatePrimaryAge}
              ariaLabelPrefix={primaryAriaPrefix}
              disabled={!primaryEditable}
            />
            <RetirementDateLine
              birthdate={primaryBirthdate}
              age={draft.primary}
              ariaPrefix={primaryAriaPrefix}
              overrideIsoDate={
                mode === 'sameDateAnchorSecondary' ? anchorDate : null
              }
            />
          </FieldGroup>
        )}

        {secondaryMember && draft.secondary && (
          <FieldGroup
            id="secondary-retirement-heading"
            legend={
              <>
                {secondaryName} (secondary)
                {!secondaryEditable && (
                  <span className="ml-2 text-muted">
                    derived from {primaryName}'s retirement date
                  </span>
                )}
              </>
            }
          >
            <AgeInputs
              ageYears={draft.secondary.ageYears}
              ageMonths={draft.secondary.ageMonths}
              onChange={updateSecondaryAge}
              ariaLabelPrefix={secondaryAriaPrefix}
              disabled={!secondaryEditable}
            />
            <RetirementDateLine
              birthdate={secondaryBirthdate}
              age={draft.secondary}
              ariaPrefix={secondaryAriaPrefix}
              overrideIsoDate={
                mode === 'sameDateAnchorPrimary' ? anchorDate : null
              }
            />
          </FieldGroup>
        )}

        {showWarning && (
          <div className={bannerClass('warn')} role="status">
            Future retirement-spending projections (withdrawals, expenses, balance
            drawdown) will use the primary user's retirement date as the household
            start-of-retirement.
          </div>
        )}

        {error && <Alert tone="error">{error}</Alert>}

        <div className="flex justify-start gap-2">
          <button
            type="button"
            className={btnPrimaryClass}
            onClick={onSave}
            disabled={submitting || !isDirty}
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className={btnSecondaryClass}
            onClick={immediateClose}
            disabled={submitting}
          >
            Cancel
          </button>
        </div>
      </div>
      {confirmModal}
    </Modal>
  );
};
