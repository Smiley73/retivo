/** Scenario detail subsection cards (Life expectancy, Inflation, Discretionary spending adjustment, Downturn guardrails): each a summary with a Configure button opening a modal that owns its draft and saves via saveScenario. */
import React, { useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { formatPercent } from '../components/PercentInput';
import { RangeSlider, snapToStep } from '../components/RangeSlider';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { saveScenario } from '../lib/scenario-mutations';
import { memberLabel } from '../lib/expense-format';
import {
  resolveInflationForScenario,
  resolveScenario,
} from '../lib/scenario-resolution';
import { isGuardrailConfigValid } from '../lib/guardrails';
import {
  ADJUSTMENT_MAX,
  ADJUSTMENT_MIN,
  DURATION_MAX,
  DURATION_MIN,
  GUARDRAIL_DISCRETIONARY_FLOOR_MAX,
  GUARDRAIL_DISCRETIONARY_FLOOR_MIN,
  GUARDRAIL_LOWER_BAND_MAX,
  GUARDRAIL_LOWER_BAND_MIN,
  GUARDRAIL_MAX_RAISE_MAX,
  GUARDRAIL_MAX_RAISE_MIN,
  GUARDRAIL_STEP_MAX,
  GUARDRAIL_STEP_MIN,
  GUARDRAIL_UPPER_BAND_MAX,
  GUARDRAIL_UPPER_BAND_MIN,
  LIFE_MAX,
  LIFE_MIN,
} from '../lib/scenario-input-bounds';
import { medicalCategoryIdSet } from '../lib/expense-category-resolvers';
import { Alert } from '../components/Alert';
import {
  btnPrimaryClass,
  btnSecondaryClass,
  FieldGroup,
  SummarySectionCard,
  SummaryCardBody,
  ConfigureResetActions,
} from './scenarios-page-chrome';
import {
  DEFAULT_DISCRETIONARY_DURATION_YEARS,
  DEFAULT_DOWNTURN_GUARDRAILS,
  DEFAULT_LIFE_EXPECTANCY_AGE,
  DEFAULT_MEDICAL_INFLATION_SPREAD_PCT,
  type DiscretionarySpendingOverride,
  type DownturnGuardrailsOverride,
  type HouseholdMemberPayload,
  type LifeExpectancyOverride,
  type ScenarioPayload,
  type Aggregate,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

// Capitalises a leading-sentence fallback slot (primary/secondary); memberLabel keeps its lowercase fallback for mid-sentence callers ("Form controls" in docs/ui-conventions.md).
function capitaliseFirst(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const LIFE_STEP = 5;

interface LifeExpectancyCardProps {
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  primaryMember: Aggregate<HouseholdMemberPayload> | undefined | null;
  secondaryMember: Aggregate<HouseholdMemberPayload> | undefined | null;
  onConfigure: () => void;
  onResetToInherited: () => void;
}

export const LifeExpectancyCard: React.FC<LifeExpectancyCardProps> = ({
  scenario,
  scenarios,
  primaryMember,
  secondaryMember,
  onConfigure,
  onResetToInherited,
}) => {
  const ownOverride = scenario.payload.overrides.lifeExpectancy;
  const isOverriddenLocally = ownOverride !== undefined;
  const canResetToInherited = isOverriddenLocally && !scenario.payload.isPrimary;

  const resolved = useMemo(() => {
    if (scenario.payload.parentScenarioId === null) return ownOverride;
    const inherited = resolveScenario(scenario.payload.parentScenarioId, scenarios);
    return ownOverride ?? inherited?.lifeExpectancy;
  }, [scenario, scenarios, ownOverride]);

  const primaryAge = resolved?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE;
  const secondaryAge = resolved?.secondary ?? DEFAULT_LIFE_EXPECTANCY_AGE;

  const primaryName = memberLabel(primaryMember ?? undefined, undefined, 'primary');
  const secondaryName = memberLabel(secondaryMember ?? undefined, undefined, 'secondary');
  const summary = secondaryMember
    ? `${capitaliseFirst(primaryName)} to ${primaryAge} years, ${secondaryName} to ${secondaryAge} years.`
    : `To ${primaryAge} years.`;

  return (
    <SummarySectionCard
      title="Life expectancy"
      headingId="life-expectancy-heading"
      overridden={scenario.payload.isPrimary ? undefined : isOverriddenLocally}
      actions={
        <ConfigureResetActions
          subject="life expectancy"
          onConfigure={onConfigure}
          onReset={canResetToInherited ? onResetToInherited : undefined}
        />
      }
    >
      <SummaryCardBody>
        {isOverriddenLocally || scenario.payload.isPrimary
          ? summary
          : 'No scenario overrides.'}
      </SummaryCardBody>
    </SummarySectionCard>
  );
};

interface LifeExpectancyModalProps {
  scenario: ScenarioAggregate;
  primaryMember: Aggregate<HouseholdMemberPayload> | undefined | null;
  secondaryMember: Aggregate<HouseholdMemberPayload> | undefined | null;
  householdId: string;
  onClose: (saved: boolean) => void;
}

export const LifeExpectancyModal: React.FC<LifeExpectancyModalProps> = ({
  scenario,
  primaryMember,
  secondaryMember,
  householdId,
  onClose,
}) => {
  const seeded = scenario.payload.overrides.lifeExpectancy ?? {};
  const seedPrimary = seeded.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE;
  const seedSecondary = seeded.secondary ?? DEFAULT_LIFE_EXPECTANCY_AGE;

  const [primaryYears, setPrimaryYears] = useState(
    snapToStep(seedPrimary, LIFE_MIN, LIFE_MAX, LIFE_STEP),
  );
  const [secondaryYears, setSecondaryYears] = useState(
    snapToStep(seedSecondary, LIFE_MIN, LIFE_MAX, LIFE_STEP),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const primaryName = memberLabel(primaryMember ?? undefined, undefined, 'primary');
  const secondaryName = memberLabel(secondaryMember ?? undefined, undefined, 'secondary');

  const onSave = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const override: LifeExpectancyOverride = { primary: primaryYears };
      if (secondaryMember) {
        override.secondary = secondaryYears;
      }
      const payload: ScenarioPayload = {
        ...scenario.payload,
        overrides: { ...scenario.payload.overrides, lifeExpectancy: override },
      };
      await saveScenario({ scenario, payload, householdId });
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open title="Life expectancy" onClose={() => onClose(false)} size="lg">
      <div className="flex flex-col gap-2">
        <p className="m-0 text-sm">
          Set how long to plan for each member to live. The projection needs to
          cover spending all the way to this age, so planning for a longer life
          means your savings have to stretch further.
        </p>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-muted">
            Plan for <strong>{primaryName}</strong> to live to:
          </span>
          <RangeSlider
            id="life-primary"
            ariaLabel={`${capitaliseFirst(primaryName)} life expectancy years`}
            min={LIFE_MIN}
            max={LIFE_MAX}
            step={LIFE_STEP}
            value={primaryYears}
            onChange={setPrimaryYears}
            formatValue={(v) => `${v} years`}
            formatAriaValue={(v) => `${v} years`}
          />
        </div>
        {secondaryMember && (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-muted">
              Plan for <strong>{secondaryName}</strong> to live to:
            </span>
            <RangeSlider
              id="life-secondary"
              ariaLabel={`${capitaliseFirst(secondaryName)} life expectancy years`}
              min={LIFE_MIN}
              max={LIFE_MAX}
              step={LIFE_STEP}
              value={secondaryYears}
              onChange={setSecondaryYears}
              formatValue={(v) => `${v} years`}
              formatAriaValue={(v) => `${v} years`}
            />
          </div>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-start gap-2">
          <button type="button" className={btnPrimaryClass} onClick={onSave} disabled={submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className={btnSecondaryClass} onClick={() => onClose(false)}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
};

interface InflationCardProps {
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  medicalCategoryIds?: ReadonlyArray<string>;
  onConfigure: () => void;
  onResetToInherited: () => void;
}

export const InflationCard: React.FC<InflationCardProps> = ({
  scenario,
  scenarios,
  medicalCategoryIds,
  onConfigure,
  onResetToInherited,
}) => {
  const ownOverride = scenario.payload.overrides.inflation;
  const isOverriddenLocally = ownOverride !== undefined;
  const canResetToInherited = isOverriddenLocally && !scenario.payload.isPrimary;

  const summaryText = useMemo(() => {
    const medicalIds = medicalCategoryIdSet(medicalCategoryIds);
    const resolved = resolveInflationForScenario(
      scenario.id,
      scenarios,
      medicalIds,
    );
    const generalPct = resolved.ratePct;
    const firstMedicalId = [...medicalIds][0];
    const medicalPct =
      firstMedicalId !== undefined
        ? resolved.categoryRates.get(firstMedicalId) ?? generalPct
        : generalPct;
    // Custom means a resolved rate differing from its default (general, or general + 2pp for medical); the materialised medical default is not counted.
    let customCount = 0;
    for (const [catId, rate] of resolved.categoryRates) {
      const def = medicalIds.has(catId)
        ? generalPct + DEFAULT_MEDICAL_INFLATION_SPREAD_PCT
        : generalPct;
      if (rate !== def) customCount += 1;
    }
    const parts = [
      `General ${formatPercent(generalPct)}`,
      `Medical ${formatPercent(medicalPct)}`,
    ];
    if (customCount > 0) parts.push(`+${customCount} custom`);
    return parts.join(' · ');
  }, [scenario.id, scenarios, medicalCategoryIds]);

  return (
    <SummarySectionCard
      title="Inflation"
      headingId="inflation-heading"
      overridden={scenario.payload.isPrimary ? undefined : isOverriddenLocally}
      actions={
        <ConfigureResetActions
          subject="inflation"
          onConfigure={onConfigure}
          onReset={canResetToInherited ? onResetToInherited : undefined}
        />
      }
    >
      <SummaryCardBody>
        {isOverriddenLocally || scenario.payload.isPrimary
          ? summaryText
          : 'No scenario overrides.'}
      </SummaryCardBody>
    </SummarySectionCard>
  );
};

interface DiscretionaryCardProps {
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  onConfigure: () => void;
  onResetToInherited: () => void;
}

export const DiscretionaryAdjustmentCard: React.FC<DiscretionaryCardProps> = ({
  scenario,
  scenarios,
  onConfigure,
  onResetToInherited,
}) => {
  const ownOverride = scenario.payload.overrides.discretionarySpending;
  const isOverriddenLocally = ownOverride !== undefined;
  const canResetToInherited = isOverriddenLocally && !scenario.payload.isPrimary;

  const resolved = useMemo(() => {
    if (scenario.payload.parentScenarioId === null) return ownOverride;
    const inherited = resolveScenario(scenario.payload.parentScenarioId, scenarios);
    return ownOverride ?? inherited?.discretionarySpending;
  }, [scenario, scenarios, ownOverride]);

  // Clamp to match the projection math (silently bound stored values outside UI domain).
  const bumpPct = Math.max(-100, Math.min(100, resolved?.bumpPct ?? 0));
  const durationYears = resolved?.durationYears ?? null;

  const signed = (n: number): string =>
    n > 0 ? `+${n}%` : `−${Math.abs(n)}%`;

  const summary =
    bumpPct === 0
      ? 'No discretionary adjustment.'
      : durationYears === null
        ? `${signed(bumpPct)} on discretionary spending, whole retirement.`
        : `${signed(bumpPct)} on discretionary spending for the first ${durationYears} year${durationYears === 1 ? '' : 's'}.`;

  return (
    <SummarySectionCard
      title="Discretionary adjustment"
      headingId="discretionary-heading"
      overridden={scenario.payload.isPrimary ? undefined : isOverriddenLocally}
      actions={
        <ConfigureResetActions
          subject="discretionary adjustment"
          onConfigure={onConfigure}
          onReset={canResetToInherited ? onResetToInherited : undefined}
        />
      }
    >
      <SummaryCardBody>
        {isOverriddenLocally || scenario.payload.isPrimary
          ? summary
          : 'No scenario overrides.'}
      </SummaryCardBody>
    </SummarySectionCard>
  );
};

interface DiscretionaryModalProps {
  scenario: ScenarioAggregate;
  householdId: string;
  onClose: (saved: boolean) => void;
}

const ADJUSTMENT_STEP = 5;
const DURATION_STEP = 1;

export const DiscretionaryAdjustmentModal: React.FC<DiscretionaryModalProps> = ({
  scenario,
  householdId,
  onClose,
}) => {
  const seeded = scenario.payload.overrides.discretionarySpending;
  const [bumpPct, setBumpPct] = useState<number>(
    snapToStep(seeded?.bumpPct ?? 0, ADJUSTMENT_MIN, ADJUSTMENT_MAX, ADJUSTMENT_STEP),
  );
  const [duration, setDuration] = useState<'whole' | 'firstN'>(() => {
    if (!seeded || seeded.bumpPct === 0) return 'firstN';
    return seeded.durationYears === null ? 'whole' : 'firstN';
  });
  const [years, setYears] = useState<number>(
    seeded?.durationYears ?? DEFAULT_DISCRETIONARY_DURATION_YEARS,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSave = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const override: DiscretionarySpendingOverride = {
        bumpPct,
        durationYears: bumpPct === 0 ? null : duration === 'whole' ? null : years,
      };
      const payload: ScenarioPayload = {
        ...scenario.payload,
        overrides: { ...scenario.payload.overrides, discretionarySpending: override },
      };
      await saveScenario({ scenario, payload, householdId });
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open title="Discretionary spending adjustment" onClose={() => onClose(false)} size="md">
      <div className="flex flex-col gap-2">
        <p className="m-0 text-sm">
          Raise or lower your optional, non-essential spending (travel, hobbies,
          dining out) for some or all of retirement. Use it to model a
          go-go-years splurge or a leaner budget and see how it affects whether
          your money lasts.
        </p>
        <FieldGroup id="disc-adjustment-amount-heading" legend="Adjustment amount">
          <RangeSlider
            ariaLabel="Discretionary adjustment percentage"
            min={ADJUSTMENT_MIN}
            max={ADJUSTMENT_MAX}
            step={ADJUSTMENT_STEP}
            value={bumpPct}
            onChange={setBumpPct}
            formatValue={(v) =>
              v === 0 ? 'No adjustment' : v > 0 ? `+${v}%` : `−${Math.abs(v)}%`
            }
            formatAriaValue={(v) =>
              v === 0
                ? 'No adjustment'
                : v > 0
                  ? `plus ${v} percent`
                  : `minus ${Math.abs(v)} percent`
            }
          />
        </FieldGroup>

        <FieldGroup
          id="disc-adjustment-duration-heading"
          legend="Duration"
          ariaDisabled={bumpPct === 0}
          className={bumpPct === 0 ? 'opacity-55' : undefined}
        >
          <SegmentedRadioGroup<'whole' | 'firstN'>
            ariaLabel="Duration"
            value={duration}
            onChange={(v) => setDuration(v)}
            disabled={bumpPct === 0}
            options={[
              { value: 'whole', label: 'Whole retirement' },
              { value: 'firstN', label: 'First N years' },
            ]}
          />
          {duration === 'firstN' && (
            <div className="mt-2">
              <RangeSlider
                ariaLabel="First N years"
                min={DURATION_MIN}
                max={DURATION_MAX}
                step={DURATION_STEP}
                value={years}
                onChange={setYears}
                disabled={bumpPct === 0}
                formatValue={(v) => `${v} year${v === 1 ? '' : 's'}`}
                formatAriaValue={(v) => `${v} year${v === 1 ? '' : 's'}`}
              />
            </div>
          )}
        </FieldGroup>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-start gap-2">
          <button type="button" className={btnPrimaryClass} onClick={onSave} disabled={submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className={btnSecondaryClass} onClick={() => onClose(false)}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
};


interface GuardrailsCardProps {
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  onConfigure: () => void;
  onResetToInherited: () => void;
}

export const DownturnGuardrailsCard: React.FC<GuardrailsCardProps> = ({
  scenario,
  scenarios,
  onConfigure,
  onResetToInherited,
}) => {
  const ownOverride = scenario.payload.overrides.downturnGuardrails;
  const isOverriddenLocally = ownOverride !== undefined;
  const canResetToInherited = isOverriddenLocally && !scenario.payload.isPrimary;

  const resolved = useMemo(() => {
    if (scenario.payload.parentScenarioId === null) return ownOverride;
    const inherited = resolveScenario(scenario.payload.parentScenarioId, scenarios);
    return ownOverride ?? inherited?.downturnGuardrails;
  }, [scenario, scenarios, ownOverride]);

  const summary =
    resolved?.enabled === true
      ? `On — cut below ${resolved.lowerBandPct}% (keep ${resolved.discretionaryFloorPct ?? DEFAULT_DOWNTURN_GUARDRAILS.discretionaryFloorPct ?? 0}% discretionary), raise above ${resolved.upperBandPct}%, ${resolved.stepPct}% steps, raise cap ${resolved.maxRaisePct}%.`
      : 'Off — spending stays fixed regardless of market ups and downs.';

  return (
    <SummarySectionCard
      title="Spending guardrails"
      headingId="guardrails-heading"
      overridden={scenario.payload.isPrimary ? undefined : isOverriddenLocally}
      actions={
        <ConfigureResetActions
          subject="spending guardrails"
          onConfigure={onConfigure}
          onReset={canResetToInherited ? onResetToInherited : undefined}
        />
      }
    >
      <SummaryCardBody>
        {isOverriddenLocally || scenario.payload.isPrimary
          ? summary
          : 'No scenario overrides.'}
      </SummaryCardBody>
    </SummarySectionCard>
  );
};

interface GuardrailsModalProps {
  scenario: ScenarioAggregate;
  householdId: string;
  onClose: (saved: boolean) => void;
}

// A UX-sensible sub-range of what isGuardrailConfigValid allows; a band, step or cap outside it is not a realistic planning choice.
const GUARDRAIL_MAX_RAISE_STEP = 5;
// 0 trims all discretionary in a deep downturn (essentials are never cut); 100 protects discretionary entirely.
const GUARDRAIL_DISCRETIONARY_FLOOR_STEP = 5;

const formatGuardrailPct = (v: number): string => `${v}%`;

const GUARDRAIL_SLIDER_ROW_CLASS = 'flex items-center gap-3';
const GUARDRAIL_SLIDER_LABEL_CLASS = 'w-52 shrink-0 text-sm font-medium text-ink';
const GUARDRAIL_SLIDER_WRAP_CLASS = 'min-w-0 flex-1';

export const DownturnGuardrailsModal: React.FC<GuardrailsModalProps> = ({
  scenario,
  householdId,
  onClose,
}) => {
  const seeded = scenario.payload.overrides.downturnGuardrails ?? DEFAULT_DOWNTURN_GUARDRAILS;
  const [enabled, setEnabled] = useState(seeded.enabled);
  const [lowerBandPct, setLowerBandPct] = useState(seeded.lowerBandPct);
  const [upperBandPct, setUpperBandPct] = useState(seeded.upperBandPct);
  const [stepPct, setStepPct] = useState(seeded.stepPct);
  const [maxRaisePct, setMaxRaisePct] = useState(seeded.maxRaisePct);
  const [discretionaryFloorPct, setDiscretionaryFloorPct] = useState(
    seeded.discretionaryFloorPct ?? DEFAULT_DOWNTURN_GUARDRAILS.discretionaryFloorPct ?? 0,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Enforced only when the guardrail is ON: a disabled config ships inert, so an out-of-range field on it cannot break the projection.
  const configValid = isGuardrailConfigValid({
    lowerBandPct,
    upperBandPct,
    stepPct,
    maxRaisePct,
    discretionaryFloorPct,
  });
  const blocked = enabled && !configValid;

  const onSave = async (): Promise<void> => {
    if (blocked) {
      setError(
        'Fix the guardrail bands first: the lower band must be below the upper band, the step must be between 0 and 100%, and the raise cap must be at least 100%.',
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const override: DownturnGuardrailsOverride = {
        enabled,
        lowerBandPct,
        upperBandPct,
        stepPct,
        maxRaisePct,
        discretionaryFloorPct,
      };
      const payload: ScenarioPayload = {
        ...scenario.payload,
        overrides: { ...scenario.payload.overrides, downturnGuardrails: override },
      };
      await saveScenario({ scenario, payload, householdId });
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open title="Spending guardrails" onClose={() => onClose(false)} size="2xl">
      <div className="flex flex-col gap-3">
        <p className="m-0 text-sm">
          Guardrails automatically trim your spending when markets fall and let
          you spend more when they rise, based on how well your savings cover the
          spending that guaranteed income (Social Security, pensions) does not.
          Cuts never drop below your essential spending, and raises are capped.
        </p>
        <ToggleSwitch
          label="Use spending guardrails in this scenario"
          checked={enabled}
          onChange={setEnabled}
        />
        <div className={enabled ? undefined : 'opacity-55'}>
          <FieldGroup id="guardrails-bands-heading" legend="Bands, step, cap, and floor">
            <div className="flex flex-col gap-3">
              <div className={GUARDRAIL_SLIDER_ROW_CLASS}>
                <span id="guardrails-lower-band-label" className={GUARDRAIL_SLIDER_LABEL_CLASS}>
                  Cut spending when savings cover below
                </span>
                <div className={GUARDRAIL_SLIDER_WRAP_CLASS}>
                  <RangeSlider
                    id="guardrails-lower-band"
                    ariaLabel="Cut spending when savings cover below"
                    min={GUARDRAIL_LOWER_BAND_MIN}
                    max={GUARDRAIL_LOWER_BAND_MAX}
                    step={1}
                    value={lowerBandPct}
                    onChange={setLowerBandPct}
                    formatValue={formatGuardrailPct}
                    disabled={!enabled}
                  />
                </div>
              </div>
              <div className={GUARDRAIL_SLIDER_ROW_CLASS}>
                <span id="guardrails-upper-band-label" className={GUARDRAIL_SLIDER_LABEL_CLASS}>
                  Raise spending when savings cover above
                </span>
                <div className={GUARDRAIL_SLIDER_WRAP_CLASS}>
                  <RangeSlider
                    id="guardrails-upper-band"
                    ariaLabel="Raise spending when savings cover above"
                    min={GUARDRAIL_UPPER_BAND_MIN}
                    max={GUARDRAIL_UPPER_BAND_MAX}
                    step={1}
                    value={upperBandPct}
                    onChange={setUpperBandPct}
                    formatValue={formatGuardrailPct}
                    disabled={!enabled}
                  />
                </div>
              </div>
              <div className={GUARDRAIL_SLIDER_ROW_CLASS}>
                <span id="guardrails-step-label" className={GUARDRAIL_SLIDER_LABEL_CLASS}>
                  Adjust spending by (each step)
                </span>
                <div className={GUARDRAIL_SLIDER_WRAP_CLASS}>
                  <RangeSlider
                    id="guardrails-step"
                    ariaLabel="Adjust spending by (each step)"
                    min={GUARDRAIL_STEP_MIN}
                    max={GUARDRAIL_STEP_MAX}
                    step={1}
                    value={stepPct}
                    onChange={setStepPct}
                    formatValue={formatGuardrailPct}
                    disabled={!enabled}
                  />
                </div>
              </div>
              <div className={GUARDRAIL_SLIDER_ROW_CLASS}>
                <span id="guardrails-max-raise-label" className={GUARDRAIL_SLIDER_LABEL_CLASS}>
                  Never raise spending above (% of plan)
                </span>
                <div className={GUARDRAIL_SLIDER_WRAP_CLASS}>
                  <RangeSlider
                    id="guardrails-max-raise"
                    ariaLabel="Never raise spending above (% of plan)"
                    min={GUARDRAIL_MAX_RAISE_MIN}
                    max={GUARDRAIL_MAX_RAISE_MAX}
                    step={GUARDRAIL_MAX_RAISE_STEP}
                    value={maxRaisePct}
                    onChange={setMaxRaisePct}
                    formatValue={formatGuardrailPct}
                    disabled={!enabled}
                  />
                </div>
              </div>
              <div className={GUARDRAIL_SLIDER_ROW_CLASS}>
                <span
                  id="guardrails-discretionary-floor-label"
                  className={GUARDRAIL_SLIDER_LABEL_CLASS}
                >
                  Keep at least this much discretionary (%)
                </span>
                <div className={GUARDRAIL_SLIDER_WRAP_CLASS}>
                  <RangeSlider
                    id="guardrails-discretionary-floor"
                    ariaLabel="Keep at least this much discretionary (%)"
                    min={GUARDRAIL_DISCRETIONARY_FLOOR_MIN}
                    max={GUARDRAIL_DISCRETIONARY_FLOOR_MAX}
                    step={GUARDRAIL_DISCRETIONARY_FLOOR_STEP}
                    value={discretionaryFloorPct}
                    onChange={setDiscretionaryFloorPct}
                    formatValue={formatGuardrailPct}
                    disabled={!enabled}
                  />
                </div>
              </div>
              <p className="m-0 text-xs text-muted">
                Essentials are never cut. 0% lets guardrails trim all discretionary
                spending in a deep downturn; 100% protects your discretionary
                spending entirely.
              </p>
            </div>
          </FieldGroup>
        </div>
        {blocked && (
          <Alert tone="warning">
            The lower band must be below the upper band, the step must be between
            0 and 100%, and the raise cap must be at least 100%.
          </Alert>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-start gap-2">
          <button
            type="button"
            className={btnPrimaryClass}
            onClick={onSave}
            disabled={submitting || blocked}
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className={btnSecondaryClass} onClick={() => onClose(false)}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
};
