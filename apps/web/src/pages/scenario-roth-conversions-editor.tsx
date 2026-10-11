/**
 * Working-years Roth-conversions list editor.
 *
 * Non-modal page editor hosted by ScenarioRothConversionsPage: owns the draft
 * (via useRothConversionsDraft), the per-entry list UI, the scenario-level
 * assumed tax-rate field, the per-year tax-burden display + disclosure, an
 * explicit Save (sparse-persist via the save helpers), and the page-level
 * unsaved-changes guard (beforeunload + in-app nav / X / Esc / scrim).
 *
 * Source picker: active PRE_TAX or MIXED accounts (excluding cash-balance
 * pensions). Target picker is source-aware: for a PRE_TAX or MIXED source it
 * lists active Roth IRA accounts, plus (for a MIXED Roth-designated source)
 * the same account as a same-account in-plan Roth conversion option.
 *
 * Tax burden: the displayed burden is computed via the shared
 * `resolveConversionLeg` cents helper (one math home — no re-derivation) and is
 * informational only — it is NEVER deducted from the projection.
 */
import React, { useMemo, useState } from 'react';
import { MoneyInput } from '../components/MoneyInput';
import { PercentInput } from '../components/PercentInput';
import { Select } from '../components/Select';
import { ScheduleAnchorPicker } from '../components/ScheduleAnchorPicker';
import { Alert } from '../components/Alert';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { EntryDisclosureRow } from '../components/EntryDisclosureRow';
import { Muted } from '../components/Muted';
import { textLinkClass } from '../components/TextLink';
import { useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import {
  glideAnchorToMagiCapEnd,
  magiCapEndToGlideAnchor,
} from '../lib/schedule-anchor-bridge';
import { describeEnd, describeStart } from '../lib/schedule-format';
import { resolveConversionLeg } from '../lib/roth-conversion-utils';
import {
  buildRothConversionResolveCtx,
  resolveConversionYears,
} from '../lib/roth-conversion-window';
import {
  isConvertibleRothConversionSource,
  isSameAccountMixedInPlanConversion,
  isWorkingYearsRothConversionTarget,
} from '../lib/roth-conversion-eligibility';
import { resolveMemberRetirementDates } from '../lib/retirement-date-math';
import { cryptoUuid } from '../lib/crypto-uuid';
import { formatCurrency } from '../lib/format-currency';
import { saveScenario } from '../lib/scenario-mutations';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type {
  AccountPayload,
  Aggregate,
  GlideAnchor,
  HouseholdMemberPayload,
  RetirementAgeOverride,
} from '../db/types';
import { btnPrimaryClass, btnSecondaryClass } from './scenarios-page-chrome';
import {
  useRothConversionsDraft,
  type DraftRothConversion,
} from './scenario-roth-conversions-draft-hook';
import {
  buildNextRothConversions,
  buildNextRothConversionTaxRate,
} from './scenario-roth-conversions-save-helpers';

/** A fresh entry seed: the first available pre-tax source + Roth-IRA target,
 *  a $10k/yr placeholder, and a single calendar-year window at the current
 *  year (a one-year "convert $X in year Y" entry).
 *
 *  Window semantics (matches the sibling MAGI-cap convention + the engine):
 *  a `year` END anchor is INCLUSIVE of its calendar year. `resolveEndMonth`
 *  maps `end:{kind:'year', year:Y}` to Jan 1 of Y+1 (the exclusive month
 *  boundary), so the engine's half-open `[startYear, endYear)` month window
 *  fully includes calendar year Y. Therefore `start = end = year Y` converts
 *  exactly the one calendar year Y (NOT zero) — the "Convert through Y" label
 *  is honest, and the default Add always converts ≥ 1 working year. The
 *  end-to-end binding of this default to the engine year-set is locked by
 *  scenario-roth-conversions-editor.default-window.test.ts.
 *
 *  Exported only so that regression test can run this exact default-Add seed
 *  through the save helper + engine (no UI-layer-only assertion). */
export function defaultConversion(
  sourceId: string,
  targetId: string,
): DraftRothConversion {
  const thisYear = new Date().getFullYear();
  return {
    // Stable per-entry key so removing a middle row never mis-associates
    // uncommitted picker UI state. STRIPPED before persist (save helpers).
    draftId: cryptoUuid('prc'),
    sourceAccountId: sourceId,
    targetRothAccountId: targetId,
    annualAmountDollars: 10000,
    start: { kind: 'year', year: thisYear },
    end: { kind: 'year', year: thisYear },
  };
}

interface PickerOption {
  id: string;
  name: string;
}

/** Resolve a picker option's display name, falling back to a plain-English
 *  placeholder when the id no longer matches an offered option (e.g. a
 *  dangling/pruned account). */
function nameOf(options: ReadonlyArray<PickerOption>, id: string): string {
  return options.find((o) => o.id === id)?.name ?? 'Missing account';
}

/** Cap for the two window pickers of one conversion row — the source-account
 *  owner's last convertible working point. The engine converts ONLY in years
 *  strictly BEFORE the owner retires, so a pickable value at/after retirement
 *  would be a dead (silently-dropped) year. `age` = owner's last working age;
 *  `year` = owner's last working calendar year. Undefined ⇒ no resolvable
 *  retirement (missing birthdate / no `retirementAge`) ⇒ leave the picker
 *  uncapped. */
function conversionWindowCap(
  sourceAccountId: string,
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
  retirementAge: RetirementAgeOverride | undefined,
  now: Date = new Date(),
): { age?: number; year?: number } | undefined {
  if (!retirementAge) return undefined;
  const ownerId = accounts.find((a) => a.id === sourceAccountId)?.payload.ownerId;
  if (!ownerId) return undefined;
  const owner = members.find((m) => m.id === ownerId);
  if (!owner) return undefined;

  // ISO retirement date for the owner (honors same-date snapping). The year
  // before it is the owner's last convertible calendar year.
  const retIso = resolveMemberRetirementDates(
    retirementAge,
    members.map((m) => ({
      id: m.id,
      isPrimary: m.payload.isPrimary,
      birthdate: m.payload.birthdate ?? '',
    })),
  ).get(ownerId);
  if (!retIso) return undefined;

  const retYear = Number(retIso.slice(0, 4));
  if (!Number.isFinite(retYear)) return undefined;
  // Already retired (last working year is in the past) ⇒ don't invert the
  // range; fall back to uncapped so the slider stays usable.
  if (retYear - 1 < now.getUTCFullYear()) return undefined;

  const ownerAgeYears = owner.payload.isPrimary
    ? retirementAge.primary?.ageYears
    : retirementAge.secondary?.ageYears;
  const ageCap =
    typeof ownerAgeYears === 'number' && ownerAgeYears - 1 >= 0
      ? ownerAgeYears - 1
      : undefined;

  return { age: ageCap, year: retYear - 1 };
}

/** One conversion row editor: a collapsed one-line summary that expands to
 *  the source + target pickers, annual amount, the start/end year window,
 *  and the per-year tax-burden line. */
const ConversionRow: React.FC<{
  index: number;
  entry: DraftRothConversion;
  sources: ReadonlyArray<PickerOption>;
  targets: ReadonlyArray<PickerOption>;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  taxRatePct: number;
  /** Upper bound for the window pickers — the source-owner's last working
   *  age/year. Undefined ⇒ no resolvable retirement, leave pickers uncapped. */
  windowCap: { age?: number; year?: number } | undefined;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** True when this row is implicated by the backwards-window or
   *  same-account-overlap guards. */
  hasWindowProblem: boolean;
  /** Defined when the row's SAVED target is absent from its eligible-target
   *  list (deleted, deactivated, marked inherited, or orphaned by a
   *  source-owner change). Carries the account's real display name when the
   *  account still exists, so the summary never calls a visible account
   *  "Missing". The row then shows a notice instead of silently converting
   *  nothing and being pruned at the next Save. */
  staleTarget: { name: string } | undefined;
  onChange: (next: DraftRothConversion) => void;
  onRemove: () => void;
}> = ({
  index,
  entry,
  sources,
  targets,
  members,
  taxRatePct,
  windowCap,
  expanded,
  onExpandedChange,
  hasWindowProblem,
  staleTarget,
  onChange,
  onRemove,
}) => {
  // Burden uses the shared cents helper so the page + report agree to the cent
  // (the math lives once in resolveConversionLeg, never re-derived here).
  const { taxBurdenCents } = resolveConversionLeg(
    Math.round(entry.annualAmountDollars * 100),
    taxRatePct,
  );
  const startAnchor: GlideAnchor = magiCapEndToGlideAnchor(entry.start);
  const endAnchor: GlideAnchor = magiCapEndToGlideAnchor(entry.end);

  // Same-account in-plan Roth conversion: the source and target ids are
  // identical (a MIXED account converting into its own Roth-designated
  // side) — show the account name once + an In-plan badge instead of a
  // confusing self-referential "X → X".
  const isInPlan = entry.sourceAccountId === entry.targetRothAccountId;
  const summary = (
    <>
      {isInPlan ? (
        <>
          {nameOf(sources, entry.sourceAccountId)}{' '}
          <Badge tone="roth">In-plan</Badge>
        </>
      ) : (
        <>
          {nameOf(sources, entry.sourceAccountId)}
          <span aria-hidden="true"> → </span>
          <span className="sr-only"> into </span>
          {staleTarget?.name ?? nameOf(targets, entry.targetRothAccountId)}
        </>
      )}
      {' · '}
      {describeStart(entry.start, members)}
      {' → '}
      {describeEnd(entry.end, members)}
    </>
  );

  return (
    <li>
      <EntryDisclosureRow
        label={`Conversion ${index + 1}`}
        summary={summary}
        amount={`${formatCurrency(entry.annualAmountDollars)}/yr`}
        problem={
          hasWindowProblem || staleTarget !== undefined ? 'Needs attention' : undefined
        }
        expanded={expanded}
        onExpandedChange={onExpandedChange}
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-4">
              <div className="flex flex-col gap-1">
                <label
                  htmlFor={`prc-source-${index}`}
                  className="text-sm font-medium text-ink"
                >
                  Move pre-tax money from
                </label>
                <Select
                  id={`prc-source-${index}`}
                  value={entry.sourceAccountId}
                  onChange={(v) => onChange({ ...entry, sourceAccountId: v })}
                  options={sources.map((a) => ({ value: a.id, label: a.name }))}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor={`prc-target-${index}`}
                  className="text-sm font-medium text-ink"
                >
                  Into Roth account
                </label>
                <Select
                  id={`prc-target-${index}`}
                  value={entry.targetRothAccountId}
                  onChange={(v) => onChange({ ...entry, targetRothAccountId: v })}
                  options={targets.map((a) => ({ value: a.id, label: a.name }))}
                />
                {/* Mirrors the Fill-mode window's `fillNoTarget` notice: a saved
                    target that dropped out of the eligible list must say so
                    rather than silently converting nothing and vanishing at
                    Save. */}
                {staleTarget && (
                  <Muted className="text-sm">
                    This conversion&apos;s Roth account can no longer receive
                    conversions (it may have been deleted, deactivated, or
                    marked as inherited). Pick a different Roth account above —
                    until then this conversion does nothing, and it will be
                    removed when you save.
                  </Muted>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor={`prc-amount-${index}`}
                  className="text-sm font-medium text-ink"
                >
                  Amount to convert each year
                </label>
                <div className="min-w-0 max-w-44">
                  <MoneyInput
                    variant="cell"
                    ariaLabel={`Amount to convert each year for conversion ${index + 1}`}
                    value={entry.annualAmountDollars}
                    onChange={(v) => onChange({ ...entry, annualAmountDollars: v })}
                    allowNegative={false}
                  />
                </div>
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              <ScheduleAnchorPicker
                label="Convert starting"
                hideRetirementStart
                members={members}
                value={startAnchor}
                cap={windowCap}
                onChange={(a) => onChange({ ...entry, start: glideAnchorToMagiCapEnd(a) })}
              />
              <ScheduleAnchorPicker
                label="Convert through"
                hideRetirementStart
                members={members}
                value={endAnchor}
                cap={windowCap}
                onChange={(a) => onChange({ ...entry, end: glideAnchorToMagiCapEnd(a) })}
              />
            </div>
          </div>
          <Muted className="m-0 text-sm">
            Extra income tax this would create:{' '}
            <span className="font-medium text-ink">
              {formatCurrency(taxBurdenCents / 100)}
            </span>{' '}
            per year (at the {taxRatePct}% rate below).
          </Muted>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onRemove}
              className="text-sm font-medium text-negative hover:text-negative/80"
              aria-label={`Remove conversion ${index + 1}`}
            >
              Remove
            </button>
          </div>
        </div>
      </EntryDisclosureRow>
    </li>
  );
};

export interface RothConversionsEditorProps {
  scenario: ScenarioAggregate;
  scenarios: ScenarioAggregate[];
  householdId: string;
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /** Route to return to (the scenario detail page). Cancel navigates here. */
  backPath: string;
  /** Persist succeeded — the page re-fetches the version-bumped scenario. */
  onSaved: () => Promise<void>;
}

export const RothConversionsEditor: React.FC<RothConversionsEditorProps> = ({
  scenario,
  scenarios,
  householdId,
  accounts,
  members,
  backPath,
  onSaved,
}) => {
  const {
    draft: { conversions, taxRatePct },
    effective,
    inheritedFromName,
    addConversion,
    updateConversion,
    removeConversion,
    setTaxRatePct,
    isDirty,
  } = useRothConversionsDraft(scenario, scenarios);

  // Source = active PRE_TAX or MIXED accounts (excluding cash-balance pensions).
  // Target = source-aware: Roth IRAs are always listed; for a MIXED Roth-designated
  // source the same account also appears as a same-account in-plan Roth conversion
  // option (even when the account's current post-tax balance is zero).
  const sources = useMemo<PickerOption[]>(
    () =>
      accounts
        .filter((a) => isConvertibleRothConversionSource(a.payload))
        .map((a) => ({ id: a.id, name: a.payload.name })),
    [accounts],
  );

  /** Compute target options for one conversion row given its current source id. */
  const targetsForSource = useMemo<(sourceId: string) => PickerOption[]>(
    () =>
      (sourceId: string): PickerOption[] => {
        const sourceAccount = accounts.find((a) => a.id === sourceId);
        // Filter Roth IRA targets to accounts owned by the SAME owner as the
        // source. Cross-owner conversions are silently pruned at save by the
        // `isValidWorkingYearsRothConversionPair` guard — showing cross-owner options
        // causes confusing silent disappearance on save.
        const sourceOwnerId = sourceAccount?.payload.ownerId;
        const rothIraTargets = accounts
          .filter(
            (a) =>
              isWorkingYearsRothConversionTarget(a.payload) &&
              (sourceOwnerId === undefined || a.payload.ownerId === sourceOwnerId),
          )
          .map((a) => ({ id: a.id, name: a.payload.name }));
        if (!sourceAccount) return rothIraTargets;
        // Same-account in-plan Roth conversion: when the source is an active
        // MIXED Roth-designated account, offer it as a target too.
        const sameAccountRec = { id: sourceAccount.id, payload: sourceAccount.payload };
        if (isSameAccountMixedInPlanConversion(sameAccountRec, sameAccountRec)) {
          return [
            ...rothIraTargets,
            {
              id: sourceAccount.id,
              name: `${sourceAccount.payload.name} (in-plan Roth conversion)`,
            },
          ];
        }
        return rothIraTargets;
      },
    [accounts],
  );

  // Find the first source that has at least one valid target — some sources
  // (e.g. MIXED OTHER with no same-owner Roth IRA) may have no targets at all.
  const firstUsableSource = sources.find((s) => targetsForSource(s.id).length > 0);
  const canAdd = firstUsableSource !== undefined;

  // Resolve every row to its inclusive `[startYear, endYear]`, keyed by index,
  // with the same helper the summary card uses. A `null` entry is unresolvable
  // (e.g. an `age` anchor whose member has no birthdate) and is skipped by
  // both validations below. Reused by the backwards + same-account-overlap
  // checks.
  const resolvedYears = useMemo<({ startYear: number; endYear: number } | null)[]>(
    () => {
      const ctx = buildRothConversionResolveCtx(members);
      return conversions.map((c) => resolveConversionYears(c, ctx));
    },
    [conversions, members],
  );

  // Backwards-window guard (1-based conversion numbers): a row whose START
  // resolves to a year AFTER its END converts nothing. An unresolvable anchor
  // (missing birthdate) is NOT a backwards window, so skip it here. start ==
  // end is a valid single-year conversion.
  const backwardsRows = useMemo<number[]>(() => {
    const offending: number[] = [];
    resolvedYears.forEach((years, i) => {
      if (years && years.startYear > years.endYear) offending.push(i + 1);
    });
    return offending;
  }, [resolvedYears]);
  const hasBackwardsWindow = backwardsRows.length > 0;

  // Same-account overlap guard: two rows converting FROM the same source
  // account whose inclusive year-ranges intersect (`a1 <= b2 AND b1 <= a2`).
  // Unlike QCD there is no single-giver framing here — group strictly by
  // `sourceAccountId`. Skip unresolvable or backwards rows (their range is
  // meaningless / handled by validation 1). Collects ALL 1-based row numbers
  // involved in any same-account overlap.
  const overlapRows = useMemo<number[]>(() => {
    const offending = new Set<number>();
    for (let i = 0; i < conversions.length; i += 1) {
      const a = resolvedYears[i];
      if (!a || a.startYear > a.endYear) continue;
      for (let j = i + 1; j < conversions.length; j += 1) {
        if (conversions[i].sourceAccountId !== conversions[j].sourceAccountId) continue;
        const b = resolvedYears[j];
        if (!b || b.startYear > b.endYear) continue;
        if (a.startYear <= b.endYear && b.startYear <= a.endYear) {
          offending.add(i + 1);
          offending.add(j + 1);
        }
      }
    }
    return [...offending].sort((x, y) => x - y);
  }, [conversions, resolvedYears]);
  const hasOverlap = overlapRows.length > 0;

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Single-open-at-a-time collapsible rows, keyed by the row's stable
  // `draftId` (removing a row above the open one renumbers labels but
  // must not steal or drop the open state). All rows start collapsed.
  const [openRowId, setOpenRowId] = useState<string | null>(null);

  // Page-level dirty guard hosted here (where `isDirty` lives). Its global
  // pushState/replaceState patch also intercepts the breadcrumb <Link>.
  const { pendingNavModal, navigateUnguarded } = useUnsavedChangesGuard(isDirty);

  const onAdd = (): void => {
    if (!canAdd || !firstUsableSource) return;
    const usableTargets = targetsForSource(firstUsableSource.id);
    const seed = defaultConversion(firstUsableSource.id, usableTargets[0].id);
    addConversion(seed);
    setOpenRowId(seed.draftId);
  };

  const onSave = async (): Promise<void> => {
    if (!isDirty || hasBackwardsWindow || hasOverlap) return;
    setSubmitting(true);
    setError(null);
    let savedOk = false;
    try {
      // Strip the pair first so a sparse OMIT (an all-removed list / a rate
      // dropped to 0) DELETES the previously-stored key, then re-spread only
      // the present fragments.
      const {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-omit: bindings exist only to strip the keys from the rest
        preRetirementRothConversions: _omitList,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-omit
        preRetirementRothConversionTaxRatePct: _omitRate,
        ...restOverrides
      } = scenario.payload.overrides;
      const nextOverrides = {
        ...restOverrides,
        ...buildNextRothConversions({ drafts: conversions, accounts }),
        ...buildNextRothConversionTaxRate({ taxRatePct }),
      };
      await saveScenario({
        scenario,
        payload: { ...scenario.payload, overrides: nextOverrides },
        householdId,
      });
      savedOk = true;
      await onSaved();
    } catch (e) {
      setError(
        savedOk
          ? 'Saved, but refreshing failed — your change is safe.'
          : e instanceof Error
            ? e.message
            : 'Failed to save.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {inheritedFromName && (
        <Muted className="text-sm">
          These conversions are inherited from {inheritedFromName}. Editing here
          overrides them for this scenario only.
        </Muted>
      )}

      {!canAdd && (
        <Alert tone="info">
          To set up a working-years Roth conversion you need at least one active
          pre-tax or mixed account to move money from and one active Roth IRA
          (or an eligible mixed employer plan for an in-plan Roth conversion) to
          move it into. Add them to your plan first.
        </Alert>
      )}

      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium text-ink">Conversions</h3>
            <Muted className="m-0 text-sm">
              Each conversion moves the full amount from the pre-tax side of an
              account into a Roth IRA (or, for mixed employer plans, into that
              same account&apos;s Roth-designated side) every year in its window.
              The money keeps growing tax-free in the Roth, and lowering your
              pre-tax balance can shrink your later required withdrawals.
            </Muted>
          </div>
          {conversions.length === 0 ? (
            <Muted className="m-0 text-sm">No conversions yet.</Muted>
          ) : (
            <ul
              className="flex flex-col gap-3 p-0"
              aria-label="Working-years Roth conversions"
            >
              {conversions.map((entry, i) => {
                const targets = targetsForSource(entry.sourceAccountId);
                // A row's SAVED target can drop out of its eligible-target
                // list after the fact — deleted, deactivated, marked inherited
                // (an inherited Roth IRA cannot receive conversions), or
                // orphaned by a source-owner change. Such a row converts
                // nothing (`resolvePreRetirementRothConversions` re-applies
                // the same predicate at the engine boundary) and
                // `buildNextRothConversions` prunes it at the next Save, so it
                // must SAY so — mirrors the Fill-mode window's `fillNoTarget`
                // notice. The real account name (when the account still
                // exists) keeps the collapsed summary from calling a visible
                // account "Missing".
                const staleTarget = targets.some(
                  (t) => t.id === entry.targetRothAccountId,
                )
                  ? undefined
                  : {
                      name:
                        accounts.find((a) => a.id === entry.targetRothAccountId)
                          ?.payload.name ?? 'Missing account',
                    };
                return (
                  <ConversionRow
                    key={entry.draftId}
                    index={i}
                    entry={entry}
                    sources={sources}
                    targets={targets}
                    members={members}
                    taxRatePct={taxRatePct}
                    windowCap={conversionWindowCap(
                      entry.sourceAccountId,
                      accounts,
                      members,
                      effective.retirementAge,
                    )}
                    expanded={openRowId === entry.draftId}
                    onExpandedChange={(open) =>
                      setOpenRowId(open ? entry.draftId : null)
                    }
                    hasWindowProblem={
                      backwardsRows.includes(i + 1) || overlapRows.includes(i + 1)
                    }
                    staleTarget={staleTarget}
                    onChange={(next) => {
                      if (next.sourceAccountId !== entry.sourceAccountId) {
                        const newTargets = targetsForSource(next.sourceAccountId);
                        if (
                          newTargets.length > 0 &&
                          !newTargets.some((t) => t.id === next.targetRothAccountId)
                        ) {
                          updateConversion(i, {
                            ...next,
                            targetRothAccountId: newTargets[0].id,
                          });
                          return;
                        }
                      }
                      updateConversion(i, next);
                    }}
                    onRemove={() => {
                      removeConversion(i);
                      if (openRowId === entry.draftId) setOpenRowId(null);
                    }}
                  />
                );
              })}
            </ul>
          )}
          <div>
            <button
              type="button"
              onClick={onAdd}
              disabled={!canAdd}
              className={`${textLinkClass} text-sm disabled:cursor-not-allowed disabled:text-muted`}
            >
              Add a conversion
            </button>
          </div>
        </div>
      </Card>

      {hasBackwardsWindow && (
        <Alert tone="error">
          {backwardsRows.length === 1
            ? `Conversion ${backwardsRows[0]}: the end year is before the start year — set the end to the same year or later.`
            : `Conversions ${backwardsRows.join(', ')}: the end year is before the start year — set each end to the same year or later.`}
        </Alert>
      )}

      {hasOverlap && (
        <Alert tone="error">
          {overlapRows.length === 2
            ? `Conversions ${overlapRows[0]} and ${overlapRows[1]} convert from the same account in overlapping years — change the source account or the windows so each account's conversion years don't overlap.`
            : `Conversions ${overlapRows.slice(0, -1).join(', ')} and ${overlapRows[overlapRows.length - 1]} convert from the same account in overlapping years — change the source account or the windows so each account's conversion years don't overlap.`}
        </Alert>
      )}

      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="prc-tax-rate" className="text-sm font-medium text-ink">
              Assumed tax rate on converted money
            </label>
            <div className="w-24">
              <PercentInput
                id="prc-tax-rate"
                value={taxRatePct}
                min={0}
                max={100}
                onChange={setTaxRatePct}
              />
            </div>
          </div>
          <Muted className="m-0 text-sm">
            Set this to the tax rate you expect to pay on the converted dollars —
            usually your top tax bracket while working, since a conversion stacks
            on top of your salary. It is used only to show the extra tax above; it
            does not change any balance.
          </Muted>
          <Muted className="m-0 text-sm">
            The yearly amount is the exact dollar figure converted every year — it
            does not grow with inflation.
          </Muted>
        </div>
      </Card>

      {error && <Alert tone="error">{error}</Alert>}

      {/* Left-aligned, primary action first — AGENTS action-order rule. */}
      <div className="flex justify-start gap-2">
        <button
          type="button"
          className={btnPrimaryClass}
          onClick={onSave}
          disabled={submitting || !isDirty || hasBackwardsWindow || hasOverlap}
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className={btnSecondaryClass}
          onClick={() => navigateUnguarded(backPath)}
        >
          Cancel
        </button>
      </div>
      {pendingNavModal}
    </div>
  );
};
