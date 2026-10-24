/** Scenario detail Asset allocation card (post-retirement growth vs income bucket model) with a Configure modal. Stored at overrides.retirementAllocation (glide: "The Asset allocation glide" in docs/math-income-expenses-and-returns.md); the override stores endYear and the modal converts the entered end age as primaryBirthYear + endAge on save. */
import React, { useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { formatPercent } from '../components/PercentInput';
import { RangeSlider } from '../components/RangeSlider';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { saveScenario } from '../lib/scenario-mutations';
import { resolveScenario } from '../lib/scenario-resolution';
import { resetField } from '../lib/scenario-resolution';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import { Alert } from '../components/Alert';
import { Muted } from '../components/Muted';
import {
  btnPrimaryClass,
  btnSecondaryClass,
  SummarySectionCard,
  SummaryCardBody,
  ConfigureResetActions,
} from './scenarios-page-chrome';
import {
  MAX_AGE,
  type Aggregate,
  type HouseholdMemberPayload,
  type RetirementAllocationOverride,
  type ScenarioPayload,
} from '../db/types';

const DEFAULT_GROWTH_RATE_PCT = 7;
const DEFAULT_INCOME_RATE_PCT = 3;
const DEFAULT_START_GROWTH_PCT = 50;
const DEFAULT_END_GROWTH_PCT = 30;
const DEFAULT_END_AGE = 85;
const DEFAULT_INCOME_ONLY_AGE = 90;
const RATE_MIN = 0;
const RATE_MAX = 10;
const RATE_STEP = 0.5;
const PCT_MIN = 0;
const PCT_MAX = 100;
const START_GROWTH_STEP = 5;
const GLIDE_OFFSET_MIN = 0;
const GLIDE_OFFSET_MAX = 30;
const AGE_MIN = 50;

function birthYearOf(member: Aggregate<HouseholdMemberPayload> | null): number | null {
  const iso = member?.payload.birthdate;
  if (!iso) return null;
  const year = Number(iso.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

function endYearToAge(endYear: number | null, birthYear: number | null): number | null {
  if (endYear === null || birthYear === null) return null;
  return endYear - birthYear;
}

function memberFirstName(
  member: Aggregate<HouseholdMemberPayload> | null,
): string {
  const name = member?.payload.firstName?.trim();
  return name && name.length > 0 ? name : 'the primary member';
}

// The primary member's retirement age from the scenario chain; null when no override defines one, so the glide-start offset can't anchor to a year and the modal disables that field.
function primaryRetirementAgeOf(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
): number | null {
  const resolved = resolveScenario(scenario.id, scenarios);
  return resolved.retirementAge?.primary?.ageYears ?? null;
}

interface CardProps {
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  primaryMember: Aggregate<HouseholdMemberPayload> | null;
  onConfigure: () => void;
  onResetToInherited: () => void;
}

export const AssetAllocationCard: React.FC<CardProps> = ({
  scenario,
  scenarios,
  primaryMember,
  onConfigure,
  onResetToInherited,
}) => {
  const ownOverride = scenario.payload.overrides.retirementAllocation;
  const isOverriddenLocally = ownOverride !== undefined;
  const canResetToInherited = isOverriddenLocally && !scenario.payload.isPrimary;

  const resolved = useMemo<RetirementAllocationOverride | undefined>(() => {
    if (scenario.payload.parentScenarioId === null) return ownOverride;
    const inherited = resolveScenario(scenario.payload.parentScenarioId, scenarios);
    return ownOverride ?? inherited?.retirementAllocation;
  }, [scenario, scenarios, ownOverride]);

  const summary = useMemo(() => {
    if (!resolved) return 'Off';
    const start = Math.round(resolved.startGrowthPct);
    const incomeShare = 100 - start;
    const ratePart = `${formatPercent(resolved.growthRatePct)} / ${formatPercent(resolved.incomeRatePct)}`;
    const birthYear = birthYearOf(primaryMember);
    const name = memberFirstName(primaryMember);
    const incomeOnlyYear = resolved.incomeOnlyYear ?? null;
    const incomeOnlySuffix = (() => {
      if (incomeOnlyYear === null) return '';
      const ageStr =
        birthYear !== null
          ? `${name}'s age ${incomeOnlyYear - birthYear}`
          : `${incomeOnlyYear}`;
      return `, 100% income by ${ageStr}`;
    })();
    if (resolved.endGrowthPct !== null && resolved.endYear !== null) {
      const endPct = Math.round(resolved.endGrowthPct);
      const endAgeStr =
        birthYear !== null
          ? `age ${resolved.endYear - birthYear}`
          : `${resolved.endYear}`;
      const glideStartYear = resolved.glideStartYear ?? null;
      const startAgeStr =
        glideStartYear !== null && birthYear !== null
          ? `age ${glideStartYear - birthYear}`
          : null;
      const window =
        startAgeStr !== null
          ? ` between ${name}'s ${startAgeStr} and ${endAgeStr}`
          : ` by ${name}'s ${endAgeStr}`;
      return `${start} → ${endPct}${window}, ${ratePart}${incomeOnlySuffix}`;
    }
    return `${start}/${incomeShare}, ${ratePart}, flat${incomeOnlySuffix}`;
  }, [resolved, primaryMember]);

  return (
    <SummarySectionCard
      title="Asset allocation"
      headingId="asset-allocation-heading"
      overridden={scenario.payload.isPrimary ? undefined : isOverriddenLocally}
      actions={
        <ConfigureResetActions
          subject="asset allocation"
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

interface ModalProps {
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  primaryMember: Aggregate<HouseholdMemberPayload> | null;
  householdId: string;
  onClose: (saved: boolean) => void;
}

export const AssetAllocationModal: React.FC<ModalProps> = ({
  scenario,
  scenarios,
  primaryMember,
  householdId,
  onClose,
}) => {
  const inherited = useMemo<RetirementAllocationOverride | undefined>(() => {
    if (scenario.payload.parentScenarioId === null) return undefined;
    const r = resolveScenario(scenario.payload.parentScenarioId, scenarios);
    return r?.retirementAllocation;
  }, [scenario, scenarios]);
  const seeded = scenario.payload.overrides.retirementAllocation ?? inherited;
  const birthYear = birthYearOf(primaryMember);
  const primaryName = memberFirstName(primaryMember);
  const primaryRetirementAge = useMemo(
    () => primaryRetirementAgeOf(scenario, scenarios),
    [scenario, scenarios],
  );
  const primaryRetirementYear =
    birthYear !== null && primaryRetirementAge !== null
      ? birthYear + primaryRetirementAge
      : null;

  const [enabled, setEnabled] = useState<boolean>(seeded !== undefined);
  const [growthRate, setGrowthRate] = useState<number>(
    seeded?.growthRatePct ?? DEFAULT_GROWTH_RATE_PCT,
  );
  const [incomeRate, setIncomeRate] = useState<number>(
    seeded?.incomeRatePct ?? DEFAULT_INCOME_RATE_PCT,
  );
  const [startGrowthPct, setStartGrowthPct] = useState<number>(
    seeded?.startGrowthPct ?? DEFAULT_START_GROWTH_PCT,
  );
  const seededEndAge = seeded ? endYearToAge(seeded.endYear, birthYear) : null;
  const seededIncomeOnlyAge = seeded
    ? endYearToAge(seeded.incomeOnlyYear ?? null, birthYear)
    : null;
  const seededGlideStartOffset =
    seeded?.glideStartYear != null && primaryRetirementYear !== null
      ? Math.max(0, seeded.glideStartYear - primaryRetirementYear)
      : 0;
  const [glideOn, setGlideOn] = useState<boolean>(
    seeded?.endGrowthPct !== null && seeded?.endGrowthPct !== undefined,
  );
  const [endGrowthPct, setEndGrowthPct] = useState<number>(
    seeded?.endGrowthPct ?? DEFAULT_END_GROWTH_PCT,
  );
  const [endAge, setEndAge] = useState<number>(seededEndAge ?? DEFAULT_END_AGE);
  const [glideStartOffset, setGlideStartOffset] = useState<number>(
    seededGlideStartOffset,
  );
  const [incomeOnlyOn, setIncomeOnlyOn] = useState<boolean>(
    seeded?.incomeOnlyYear != null,
  );
  const [incomeOnlyAge, setIncomeOnlyAge] = useState<number>(
    seededIncomeOnlyAge ?? DEFAULT_INCOME_ONLY_AGE,
  );

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const incomeShare = Math.max(0, Math.min(100, 100 - startGrowthPct));
  const endIncomeShare = Math.max(0, Math.min(100, 100 - endGrowthPct));

  const onSave = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      let nextPayload: ScenarioPayload;
      if (!enabled) {
        nextPayload = resetField(scenario.payload, 'retirementAllocation');
      } else {
        if (glideOn && birthYear === null) {
          throw new Error(
            `${primaryName}'s birthdate is required to set a glide end age.`,
          );
        }
        // End age must exceed the glide-start age (retirement + offset); skipped when retirement age can't resolve, since the inline warning already covers it.
        if (glideOn && primaryRetirementAge !== null) {
          const startAge = primaryRetirementAge + glideStartOffset;
          if (endAge <= startAge) {
            throw new Error(
              `End age must be greater than ${startAge}, ${primaryName}'s glide-start age.`,
            );
          }
        }
        if (incomeOnlyOn) {
          if (birthYear === null) {
            throw new Error(
              `${primaryName}'s birthdate is required to set the 100% income age.`,
            );
          }
          if (primaryRetirementAge !== null && incomeOnlyAge <= primaryRetirementAge) {
            throw new Error(
              `100% income age must be greater than ${primaryName}'s retirement age (${primaryRetirementAge}).`,
            );
          }
          if (glideOn && incomeOnlyAge <= endAge) {
            throw new Error(
              `100% income age must be greater than the glide end age (${endAge}).`,
            );
          }
        }
        const computedEndYear =
          glideOn && birthYear !== null ? birthYear + endAge : null;
        const computedGlideStartYear =
          glideOn && glideStartOffset > 0 && primaryRetirementYear !== null
            ? primaryRetirementYear + glideStartOffset
            : null;
        const computedIncomeOnlyYear =
          incomeOnlyOn && birthYear !== null ? birthYear + incomeOnlyAge : null;
        const override: RetirementAllocationOverride = {
          growthRatePct: growthRate,
          incomeRatePct: incomeRate,
          startGrowthPct,
          endGrowthPct: glideOn ? endGrowthPct : null,
          endYear: computedEndYear,
          glideStartYear: computedGlideStartYear,
          incomeOnlyYear: computedIncomeOnlyYear,
        };
        nextPayload = {
          ...scenario.payload,
          overrides: {
            ...scenario.payload.overrides,
            retirementAllocation: override,
          },
        };
      }
      await saveScenario({ scenario, payload: nextPayload, householdId });
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      title="Asset allocation"
      onClose={() => onClose(false)}
      size="2xl"
    >
      <div className="flex flex-col gap-2">
        <p className="m-0 text-sm">
          Split your retirement savings into a <strong>growth</strong> bucket
          (stocks) and an <strong>income</strong> bucket (bonds, cash, stable
          assets). Each bucket grows at its own rate; retirement spending is
          drawn from the income bucket first.
        </p>

        <ToggleSwitch
          label="Enable scenario asset allocation"
          checked={enabled}
          onChange={setEnabled}
        />

        {enabled && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <label
                  htmlFor="alloc-growth-rate"
                  className="w-44 shrink-0 text-sm font-medium text-ink"
                >
                  Growth rate
                </label>
                <div className="min-w-0 flex-1">
                  <RangeSlider
                    id="alloc-growth-rate"
                    ariaLabel="Growth rate"
                    min={RATE_MIN}
                    max={RATE_MAX}
                    step={RATE_STEP}
                    value={growthRate}
                    onChange={setGrowthRate}
                    formatValue={formatPercent}
                  />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <label
                  htmlFor="alloc-income-rate"
                  className="w-44 shrink-0 text-sm font-medium text-ink"
                >
                  Income rate
                </label>
                <div className="min-w-0 flex-1">
                  <RangeSlider
                    id="alloc-income-rate"
                    ariaLabel="Income rate"
                    min={RATE_MIN}
                    max={RATE_MAX}
                    step={RATE_STEP}
                    value={incomeRate}
                    onChange={setIncomeRate}
                    formatValue={formatPercent}
                  />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <label
                  htmlFor="alloc-start-growth"
                  className="w-44 shrink-0 text-sm font-medium text-ink"
                >
                  Initial growth allocation
                  <Muted as="span" className="block text-xs font-normal">
                    {formatPercent(incomeShare)} income
                  </Muted>
                </label>
                <div className="min-w-0 flex-1">
                  <RangeSlider
                    id="alloc-start-growth"
                    ariaLabel="Initial growth allocation"
                    min={PCT_MIN}
                    max={PCT_MAX}
                    step={START_GROWTH_STEP}
                    value={startGrowthPct}
                    onChange={setStartGrowthPct}
                    formatValue={(v) => formatPercent(v)}
                    formatAriaValue={(v) => `${formatPercent(v)} growth`}
                  />
                </div>
              </div>
            </div>

            <div className="mt-3 border-t border-line pt-3">
              <ToggleSwitch
                label="Glide path: shift the split with age"
                checked={glideOn}
                onChange={setGlideOn}
              />
            </div>

            {glideOn && (
              <div
                role="group"
                aria-label="Glide path window"
                className="flex flex-col gap-2"
              >
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-3">
                    <label
                      htmlFor="alloc-glide-start-offset"
                      className="w-44 shrink-0 text-sm font-medium text-ink"
                    >
                      Start glide after
                      {primaryRetirementAge !== null && (
                        <Muted as="span" className="block text-xs font-normal">
                          {primaryName}&apos;s age{' '}
                          {primaryRetirementAge + glideStartOffset}
                        </Muted>
                      )}
                    </label>
                    <div className="min-w-0 flex-1">
                      <RangeSlider
                        id="alloc-glide-start-offset"
                        ariaLabel="Start glide after"
                        min={GLIDE_OFFSET_MIN}
                        max={GLIDE_OFFSET_MAX}
                        step={1}
                        value={glideStartOffset}
                        onChange={setGlideStartOffset}
                        formatValue={(v) => `${v} yr${v === 1 ? '' : 's'}`}
                        formatAriaValue={(v) =>
                          `${v} year${v === 1 ? '' : 's'} into retirement`
                        }
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <label
                      htmlFor="alloc-end-growth"
                      className="w-44 shrink-0 text-sm font-medium text-ink"
                    >
                      End growth %
                      <Muted as="span" className="block text-xs font-normal">
                        {formatPercent(endIncomeShare)} income
                      </Muted>
                    </label>
                    <div className="min-w-0 flex-1">
                      <RangeSlider
                        id="alloc-end-growth"
                        ariaLabel="End growth percentage"
                        min={PCT_MIN}
                        max={PCT_MAX}
                        step={START_GROWTH_STEP}
                        value={endGrowthPct}
                        onChange={setEndGrowthPct}
                        formatValue={(v) => formatPercent(v)}
                        formatAriaValue={(v) => `${formatPercent(v)} growth`}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <label
                      htmlFor="alloc-end-age"
                      className="w-44 shrink-0 text-sm font-medium text-ink"
                    >
                      End age ({primaryName})
                    </label>
                    <div className="min-w-0 flex-1">
                      <RangeSlider
                        id="alloc-end-age"
                        ariaLabel={`End age (${primaryName})`}
                        min={AGE_MIN}
                        max={MAX_AGE}
                        step={1}
                        value={endAge}
                        onChange={setEndAge}
                        formatValue={(v) => `${v}`}
                        formatAriaValue={(v) => `age ${v}`}
                      />
                    </div>
                  </div>
                </div>
                {birthYear === null && (
                  <Muted as="p" className="m-0 text-sm">
                    Set {primaryName}&apos;s birthdate to anchor the glide
                    end age to a calendar year.
                  </Muted>
                )}
                {primaryRetirementAge === null && glideStartOffset > 0 && (
                  <Muted as="p" className="m-0 text-sm">
                    Set {primaryName}&apos;s retirement age to anchor the
                    glide-start offset to a calendar year.
                  </Muted>
                )}
              </div>
            )}

            <div className="mt-3 border-t border-line pt-3">
              <ToggleSwitch
                label="Force 100% income at a given age"
                checked={incomeOnlyOn}
                onChange={setIncomeOnlyOn}
              />
            </div>

            {incomeOnlyOn && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-3">
                  <label
                    htmlFor="alloc-income-only-age"
                    className="w-44 shrink-0 text-sm font-medium text-ink"
                  >
                    100% income at {primaryName}&apos;s age
                  </label>
                  <div className="min-w-0 flex-1">
                    <RangeSlider
                      id="alloc-income-only-age"
                      ariaLabel={`100% income at ${primaryName}'s age`}
                      min={AGE_MIN}
                      max={MAX_AGE}
                      step={1}
                      value={incomeOnlyAge}
                      onChange={setIncomeOnlyAge}
                      formatValue={(v) => `${v}`}
                      formatAriaValue={(v) => `age ${v}`}
                    />
                  </div>
                </div>
                <Muted as="p" className="m-0 text-xs">
                  Growth bucket snaps to 0% from this age forward.
                  {birthYear === null && (
                    <>
                      {' '}
                      Set {primaryName}&apos;s birthdate to anchor the 100%
                      income age to a calendar year.
                    </>
                  )}
                </Muted>
              </div>
            )}
          </div>
        )}

        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex justify-start gap-2">
          <button type="button" className={btnPrimaryClass} onClick={onSave} disabled={submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className={btnSecondaryClass}
            onClick={() => onClose(false)}
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
};
