/** Social Security claim-age modal: whole-year claim-age sliders (62-70), optional survivor claim ages for two-member plans, and COLA and reduction knobs, behind the unsaved-edits guard. */
import React, { useMemo, useState } from 'react';
import { textLinkClass } from '../components/TextLink';
import { Link, useNavigate } from 'react-router';
import { Modal } from '../components/Modal';
import { RangeSlider } from '../components/RangeSlider';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { formatPercent } from '../components/PercentInput';
import { useDirtyModalClose } from '../components/UnsavedChangesGuard';
import { Alert } from '../components/Alert';
import { Muted } from '../components/Muted';
import { saveScenario } from '../lib/scenario-mutations';
import { LiveBenefitAmount } from './ss-modal-live-amount';
import { resolveScenario } from '../lib/scenario-resolution';
import {
  btnPrimaryClass,
  btnSecondaryClass,
  FieldGroup,
} from './scenarios-page-chrome';
import {
  DEFAULT_BENEFIT_REDUCTION_PCT,
  DEFAULT_SS_CLAIM,
  SS_PER_MEMBER_DEFAULT,
} from './scenario-age-modal-shared';
import type {
  Aggregate,
  HouseholdMemberPayload,
  RetirementAgePerMember,
  ScenarioPayload,
  SocialSecurityClaimAgeOverride,
} from '../db/types';
import { DEFAULT_COLA_PCT, DEFAULT_INFLATION_PCT } from '../db/types';
import {
  BENEFIT_REDUCTION_MAX,
  BENEFIT_REDUCTION_MIN,
  COLA_MAX,
  COLA_MIN,
  SS_CLAIM_MAX,
  SS_CLAIM_MIN,
} from '../lib/scenario-input-bounds';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

const BENEFIT_REDUCTION_STEP = 5;
const COLA_STEP = 0.5;

// Whole-year-only entry: ageMonths is always 0 going forward and stored months collapse to the nearest year on first paint.
const SS_CLAIM_STEP = 1;

function collapseAgeToSliderYear(
  years: number,
  months: number,
  min: number,
  max: number,
): number {
  const raw = Math.round(years + months / 12);
  return Math.max(min, Math.min(max, raw));
}

/** Collapses to the slider's whole year (half-away-from-zero) and clamps into [62, 70], e.g. 65y6m → 66 and 61y → 62. Exported for isolation tests. */
export function claimAgeToSliderYear(years: number, months: number): number {
  return collapseAgeToSliderYear(years, months, SS_CLAIM_MIN, SS_CLAIM_MAX);
}

// Survivor benefits are a separate decision from the member's own claim age: payable from 60 (reduced) up to the survivor's own FRA.
const SURVIVOR_CLAIM_MIN = 60;
const SURVIVOR_CLAIM_MAX = 70;
const SURVIVOR_CLAIM_SEED = 67;

/** Same collapse clamped into the survivor window [60, 70]. Exported for isolation tests. */
export function survivorAgeToSliderYear(years: number, months: number): number {
  return collapseAgeToSliderYear(years, months, SURVIVOR_CLAIM_MIN, SURVIVOR_CLAIM_MAX);
}

function seedOverrideDraft(
  baseline: SocialSecurityClaimAgeOverride,
  hasSecondary: boolean,
): SocialSecurityClaimAgeOverride {
  const base: SocialSecurityClaimAgeOverride = {
    primary: {
      ageYears: claimAgeToSliderYear(
        baseline.primary.ageYears,
        baseline.primary.ageMonths,
      ),
      ageMonths: 0,
    },
    benefitReductionPct: baseline.benefitReductionPct ?? DEFAULT_BENEFIT_REDUCTION_PCT,
    colaPct: baseline.colaPct ?? DEFAULT_COLA_PCT,
    colaTracksInflation: baseline.colaTracksInflation !== false,
  };
  if (hasSecondary) {
    const sec = baseline.secondary ?? SS_PER_MEMBER_DEFAULT;
    base.secondary = {
      ageYears: claimAgeToSliderYear(sec.ageYears, sec.ageMonths),
      ageMonths: 0,
    };
    const survivorPrimary = baseline.survivor?.primary;
    const survivorSecondary = baseline.survivor?.secondary;
    if (survivorPrimary || survivorSecondary) {
      base.survivor = {
        ...(survivorPrimary
          ? {
              primary: {
                ageYears: survivorAgeToSliderYear(
                  survivorPrimary.ageYears,
                  survivorPrimary.ageMonths,
                ),
                ageMonths: 0,
              },
            }
          : {}),
        ...(survivorSecondary
          ? {
              secondary: {
                ageYears: survivorAgeToSliderYear(
                  survivorSecondary.ageYears,
                  survivorSecondary.ageMonths,
                ),
                ageMonths: 0,
              },
            }
          : {}),
      };
    }
  }
  return base;
}

interface SurvivorAgeControlProps {
  memberName: string;
  otherName: string;
  value: RetirementAgePerMember | null;
  onToggle: (on: boolean) => void;
  onChange: (years: number) => void;
}

// The toggle is the explicit opt-in: while off nothing persists, because the app never assumes a survivor claim age.
const SurvivorAgeControl: React.FC<SurvivorAgeControlProps> = ({
  memberName,
  otherName,
  value,
  onToggle,
  onChange,
}) => (
  <div className="mt-2 flex flex-col gap-1">
    <ToggleSwitch
      className="text-sm"
      label="Set survivor claim age"
      ariaLabel={`Set survivor claim age for ${memberName}`}
      checked={value !== null}
      onChange={onToggle}
    />
    {value !== null ? (
      <>
        <div className="flex items-center gap-3">
          <span className="w-36 shrink-0 text-sm font-medium text-ink">
            Survivor claim age
          </span>
          <div className="min-w-0 flex-1">
            <RangeSlider
              ariaLabel={`${memberName} survivor benefit claim age`}
              min={SURVIVOR_CLAIM_MIN}
              max={SURVIVOR_CLAIM_MAX}
              step={SS_CLAIM_STEP}
              value={value.ageYears}
              onChange={onChange}
              formatValue={(v) => `${v} years`}
              formatAriaValue={(v) => `${v} years`}
            />
          </div>
        </div>
        <Muted className="text-sm">
          If {otherName} dies first, {memberName} starts the survivor benefit
          at this age — it can differ from {memberName}&apos;s own claim age
          and can start as early as 60. Starting before full retirement age
          reduces it; waiting past that age adds nothing.
        </Muted>
      </>
    ) : (
      <Muted className="text-sm">
        Not set — if {otherName} dies first, the projection leaves out the
        survivor benefit {memberName} could claim on {otherName}&apos;s
        record. Set a survivor claim age to include it.
      </Muted>
    )}
  </div>
);

interface SocialSecurityModalProps {
  open: boolean;
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  primaryMember: Aggregate<HouseholdMemberPayload> | null;
  secondaryMember: Aggregate<HouseholdMemberPayload> | null;
  /** PIA by member id from ScenarioDetailPage; null shows a link to the Social Security page. */
  benefitsByMemberId: Record<string, { pia: number | null }>;
  householdId: string;
  onClose: (saved: boolean) => void;
}

export const SocialSecurityModal: React.FC<SocialSecurityModalProps> = ({
  open,
  scenario,
  scenarios,
  primaryMember,
  secondaryMember,
  benefitsByMemberId,
  householdId,
  onClose,
}) => {
  const navigate = useNavigate();
  const baseline = useMemo<SocialSecurityClaimAgeOverride>(() => {
    const ownOverride = scenario.payload.overrides.socialSecurity;
    if (ownOverride) return ownOverride;
    if (scenario.payload.parentScenarioId !== null) {
      const inherited = resolveScenario(
        scenario.payload.parentScenarioId,
        scenarios,
      );
      return inherited.socialSecurity ?? DEFAULT_SS_CLAIM;
    }
    return DEFAULT_SS_CLAIM;
  }, [scenario, scenarios]);

  const scenarioInflationPct = useMemo(() => {
    const resolved = resolveScenario(scenario.id, scenarios);
    return resolved.inflation?.ratePct ?? DEFAULT_INFLATION_PCT;
  }, [scenario.id, scenarios]);

  // The secondary input always shows when a secondary member exists, seeded from the baseline else the FRA default.
  // The survivor section seeds only from stored claim ages: an unset member stays unset (the projection withholds survivor-dependent results) until the user enables it.
  const hasSecondary = secondaryMember !== null;
  const [draft, setDraft] = useState<SocialSecurityClaimAgeOverride>(() =>
    seedOverrideDraft(baseline, hasSecondary),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Compare against the post-default, post-month-collapse shape so opening and closing without edits queues no no-op mutation.
  const initial = useMemo<SocialSecurityClaimAgeOverride>(
    () => seedOverrideDraft(baseline, hasSecondary),
    [baseline, hasSecondary],
  );
  const isDirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const { guardedClose, immediateClose, confirmModal } = useDirtyModalClose(
    isDirty,
    () => onClose(false),
  );
  const { guardedClose: guardedCloseToSsPage, confirmModal: ssNavConfirmModal } =
    useDirtyModalClose(isDirty, () => {
      onClose(false);
      navigate('/social-security');
    });

  const primaryName = primaryMember?.payload.firstName?.trim() || 'Primary';
  const secondaryName = secondaryMember?.payload.firstName?.trim() || 'Secondary';

  const updatePrimaryClaimAge = (years: number) => {
    setDraft({ ...draft, primary: { ageYears: years, ageMonths: 0 } });
  };

  const updateSecondaryClaimAge = (years: number) => {
    if (!draft.secondary) return;
    setDraft({ ...draft, secondary: { ageYears: years, ageMonths: 0 } });
  };

  // null clears the member's entry: Save persists no age and the projection withholds survivor-dependent results instead of assuming one.
  const setSurvivorAge = (role: 'primary' | 'secondary', years: number | null) => {
    setDraft((d) => {
      const next = { ...(d.survivor ?? {}) };
      if (years === null) delete next[role];
      else next[role] = { ageYears: years, ageMonths: 0 };
      const out = { ...d };
      if (Object.keys(next).length > 0) out.survivor = next;
      else delete out.survivor;
      return out;
    });
  };

  const updateBenefitReduction = (value: number) => {
    setDraft({ ...draft, benefitReductionPct: value });
  };

  const updateCola = (value: number) => {
    setDraft({ ...draft, colaPct: value });
  };

  const updateColaTracksInflation = (value: boolean) => {
    setDraft({ ...draft, colaTracksInflation: value });
  };

  const onSave = async () => {
    setSubmitting(true);
    try {
      const persisted: SocialSecurityClaimAgeOverride = secondaryMember
        ? draft
        : {
            primary: draft.primary,
            benefitReductionPct: draft.benefitReductionPct,
            colaPct: draft.colaPct,
            colaTracksInflation: draft.colaTracksInflation,
          };
      const payload: ScenarioPayload = {
        ...scenario.payload,
        overrides: { ...scenario.payload.overrides, socialSecurity: persisted },
      };
      await saveScenario({ scenario, payload, householdId });
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={guardedClose}
      title="Social Security Claim Age"
      size="xl"
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 text-sm">
          Choose the age each member starts taking Social Security. Claiming
          later means a larger monthly benefit, and that choice changes how much
          guaranteed income the projection counts on each year of retirement.
        </p>

        {primaryMember ? (
          <FieldGroup
            id="primary-ss-heading"
            legend={`${primaryName} (primary)`}
          >
            <div className="flex items-center gap-3">
              <span className="w-36 shrink-0 text-sm font-medium text-ink">
                Claim age
              </span>
              <div className="min-w-0 flex-1">
                <RangeSlider
                  ariaLabel={`${primaryName} Social Security claim age`}
                  min={SS_CLAIM_MIN}
                  max={SS_CLAIM_MAX}
                  step={SS_CLAIM_STEP}
                  value={draft.primary.ageYears}
                  onChange={updatePrimaryClaimAge}
                  formatValue={(v) => `${v} years`}
                  formatAriaValue={(v) => `${v} years`}
                />
              </div>
            </div>
            {primaryMember && (
              <LiveBenefitAmount
                member={primaryMember}
                claimAgeYears={draft.primary.ageYears}
                pia={benefitsByMemberId[primaryMember.id]?.pia ?? null}
                onNavigateToSsPage={guardedCloseToSsPage}
              />
            )}
            {secondaryMember && (
              <SurvivorAgeControl
                memberName={primaryName}
                otherName={secondaryName}
                value={draft.survivor?.primary ?? null}
                onToggle={(on) =>
                  setSurvivorAge('primary', on ? SURVIVOR_CLAIM_SEED : null)
                }
                onChange={(years) => setSurvivorAge('primary', years)}
              />
            )}
          </FieldGroup>
        ) : (
          <Muted as="p">
            No primary household member yet. Add one from{' '}
            <Link to="/household" className={textLinkClass}>
              Household
            </Link>
            .
          </Muted>
        )}

        {secondaryMember && draft.secondary && (
          <FieldGroup
            id="secondary-ss-heading"
            legend={`${secondaryName} (secondary)`}
          >
            <div className="flex items-center gap-3">
              <span className="w-36 shrink-0 text-sm font-medium text-ink">
                Claim age
              </span>
              <div className="min-w-0 flex-1">
                <RangeSlider
                  ariaLabel={`${secondaryName} Social Security claim age`}
                  min={SS_CLAIM_MIN}
                  max={SS_CLAIM_MAX}
                  step={SS_CLAIM_STEP}
                  value={draft.secondary.ageYears}
                  onChange={updateSecondaryClaimAge}
                  formatValue={(v) => `${v} years`}
                  formatAriaValue={(v) => `${v} years`}
                />
              </div>
            </div>
            {secondaryMember && (
              <LiveBenefitAmount
                member={secondaryMember}
                claimAgeYears={draft.secondary.ageYears}
                pia={benefitsByMemberId[secondaryMember.id]?.pia ?? null}
                onNavigateToSsPage={guardedCloseToSsPage}
              />
            )}
            <SurvivorAgeControl
              memberName={secondaryName}
              otherName={primaryName}
              value={draft.survivor?.secondary ?? null}
              onToggle={(on) =>
                setSurvivorAge('secondary', on ? SURVIVOR_CLAIM_SEED : null)
              }
              onChange={(years) => setSurvivorAge('secondary', years)}
            />
          </FieldGroup>
        )}

        <FieldGroup id="ss-assumptions-heading" legend="Assumptions">
          <div className="mb-3 flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <span className="w-36 shrink-0 text-sm font-medium text-ink">
                Benefit reduction
              </span>
              <div className="min-w-0 flex-1">
                <RangeSlider
                  ariaLabel="Benefit reduction percentage"
                  min={BENEFIT_REDUCTION_MIN}
                  max={BENEFIT_REDUCTION_MAX}
                  step={BENEFIT_REDUCTION_STEP}
                  value={draft.benefitReductionPct ?? DEFAULT_BENEFIT_REDUCTION_PCT}
                  onChange={updateBenefitReduction}
                  formatValue={(v) => (v === 0 ? 'Full benefit' : `−${v}%`)}
                  formatAriaValue={(v) =>
                    v === 0
                      ? 'Full benefit, no reduction'
                      : `${v} percent reduction`
                  }
                />
              </div>
            </div>
            <Muted className="text-sm">
              Models a hypothetical across-the-board cut to claimed benefits.
            </Muted>
          </div>
          <div className="flex flex-col gap-1">
            {/* The visible text is the switch label (WCAG 2.5.3 label-in-name and click-to-toggle). */}
            <ToggleSwitch
              className="mb-2 text-sm"
              label="Track inflation"
              checked={draft.colaTracksInflation ?? true}
              onChange={updateColaTracksInflation}
            />
            <div className="flex items-center gap-3">
              <span className="w-36 shrink-0 text-sm font-medium text-ink">
                Annual COLA
              </span>
              <div className="min-w-0 flex-1">
                <RangeSlider
                  ariaLabel="Annual cost-of-living adjustment percentage"
                  min={COLA_MIN}
                  max={COLA_MAX}
                  step={COLA_STEP}
                  value={
                    draft.colaTracksInflation
                      ? // Display-only while tracking: clamp into the slider's
                        // Capped at the 0–5 slider range: an out-of-range controlled value paints the fill past the track; the helper text carries the true rate.
                        Math.min(scenarioInflationPct, COLA_MAX)
                      : draft.colaPct ?? DEFAULT_COLA_PCT
                  }
                  disabled={draft.colaTracksInflation}
                  onChange={updateCola}
                  formatValue={(v) => formatPercent(v)}
                  formatAriaValue={(v) => `${v.toFixed(1)} percent`}
                />
              </div>
            </div>
            <Muted className="text-sm">
              {draft.colaTracksInflation
                ? `Social Security rises with the scenario inflation rate (${formatPercent(scenarioInflationPct)}), so its value holds in today's dollars. Turn off to set a fixed rate.`
                : "Cost-of-Living Adjustment, applied annually for years after each member's SSA statement date (or after the year they turn 62 when no statement date is on file)."}
            </Muted>
          </div>
        </FieldGroup>

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
      {ssNavConfirmModal}
    </Modal>
  );
};
