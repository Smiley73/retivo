/**
 * Qualified Charitable Distribution (QCD) list editor.
 *
 * Non-modal page editor hosted by ScenarioQcdPage: owns the draft (via
 * useQcdDraft), the per-entry list UI, an explicit Save (sparse-persist via the
 * save helpers), and the page-level unsaved-changes guard (beforeunload +
 * in-app nav / Cancel).
 *
 * Each entry directs a fixed REAL annual gift from a designated traditional IRA
 * (a `RETIREMENT_IRA` with `PRE_TAX` treatment) owned by the chosen member to
 * charity at 70½+. The member picker lists only members who own at least one
 * eligible IRA; the source picker lists only that member's eligible IRAs (the
 * same cross-owner filter the resolver re-checks). The gift drops out of that
 * member's taxable income / MAGI, and once an IRA RMD applies it counts toward
 * that RMD.
 *
 * Each owner-year gift is automatically capped at the smaller of the indexed
 * per-person IRS limit and the IRA's available balance (disclosed below); the
 * editor never enforces the cap on the input. A documented double-counting
 * warning reminds the user a QCD is independent of any charitable expense.
 */
import React, { useMemo, useState } from 'react';
import { MoneyInput } from '../components/MoneyInput';
import { Badge } from '../components/Badge';
import { Select } from '../components/Select';
import { ScheduleAnchorPicker } from '../components/ScheduleAnchorPicker';
import { Alert } from '../components/Alert';
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
import { cryptoUuid } from '../lib/crypto-uuid';
import { formatCurrency } from '../lib/format-currency';
import { buildQcdResolveCtx, resolveQcdYears } from '../lib/qcd-window';
import { qcdFirstEligibleTaxYear } from '../lib/qcd';
import { QCD_LIMITS } from '../lib/qcd-limits';
import { saveScenario } from '../lib/scenario-mutations';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type {
  AccountPayload,
  Aggregate,
  GlideAnchor,
  HouseholdMemberPayload,
  HouseholdRole,
  QcdEntry,
} from '../db/types';
import { btnPrimaryClass, btnSecondaryClass } from './scenarios-page-chrome';
import { useQcdDraft, type DraftQcd } from './scenario-qcd-draft-hook';
import { buildNextQcd, isEligibleQcdSource } from './scenario-qcd-save-helpers';

/** Latest published indexed per-person §408(d)(8) limit — used only for the
 *  read-only disclosure copy. The engine inflation-extrapolates this forward
 *  per year; the editor shows the most-recently published figure as the
 *  current-dollar cap reference. */
function latestPublishedQcdLimitDollars(): number {
  const years = Object.keys(QCD_LIMITS.values)
    .map((y) => Number(y))
    .filter((y) => Number.isFinite(y));
  const latest = years.length > 0 ? Math.max(...years) : undefined;
  return latest !== undefined
    ? QCD_LIMITS.values[latest].annualLimitDollars
    : 0;
}

/** A fresh entry seed: the first eligible member + their first eligible IRA, a
 *  $10k/yr placeholder, and a window from the member's 70½ first-eligible tax
 *  year through that same year (a one-year gift — the resolver clamps `start`
 *  up to 70½ regardless). */
function defaultQcd(
  memberId: string,
  sourceAccountId: string,
  firstEligibleYear: number,
): DraftQcd {
  return {
    // Stable per-entry key so removing a middle row never mis-associates
    // uncommitted picker UI state. STRIPPED before persist (save helpers).
    draftId: cryptoUuid('qcd'),
    memberId,
    sourceAccountId,
    annualAmountDollars: 10000,
    start: { kind: 'year', year: firstEligibleYear },
    end: { kind: 'year', year: firstEligibleYear },
  };
}

/** Floor for the QCD window age slider. 70 on the whole-year slider represents
 *  the 70½ statutory first-eligible floor — the engine clamps the resolved start
 *  up to the precise 70½ tax year, so the slider never needs a half-year notch. */
const QCD_MIN_AGE = 70;

interface MemberOption {
  id: string;
  name: string;
}

interface AccountOption {
  id: string;
  name: string;
}

/** Resolve a picker option's display name, falling back to a plain-English
 *  placeholder when the id no longer matches an offered option (e.g. a
 *  dangling/pruned account). */
function nameOf(options: ReadonlyArray<AccountOption>, id: string): string {
  return options.find((o) => o.id === id)?.name ?? 'Missing account';
}

/** Resolve a member's display name, falling back to the member id. */
function memberDisplayName(
  member: Aggregate<HouseholdMemberPayload> | undefined,
  memberId: string,
): string {
  if (!member) return memberId;
  const first = member.payload.firstName?.trim() ?? '';
  const last = member.payload.lastName?.trim() ?? '';
  const full = `${first} ${last}`.trim();
  return full.length > 0 ? full : memberId;
}

/** Resolve a member's 70½ first-eligible tax year from their birthdate, or
 *  `undefined` when the birthdate is missing / malformed (the hint is then
 *  suppressed and the resolver drops the entry). */
function firstEligibleYearFor(
  member: Aggregate<HouseholdMemberPayload> | undefined,
): number | undefined {
  const birthdate = member?.payload.birthdate;
  if (!birthdate) return undefined;
  try {
    return qcdFirstEligibleTaxYear(birthdate);
  } catch {
    return undefined;
  }
}

/** Resolve the giver's `HouseholdRole` from the entry's `memberId` (a member
 *  UUID). A QCD's eligibility window is intrinsically the giver's (their 70½),
 *  and `resolveQcdForScenario` resolves the age window from the GIVER's
 *  birthdate, ignoring the anchor's own `memberId`. So the age anchor must
 *  ALWAYS carry the giver's role — never a different member — for honest display
 *  + correct slider bounds. Defaults to `'primary'` for a dangling member id. */
function giverRoleFor(
  member: Aggregate<HouseholdMemberPayload> | undefined,
): HouseholdRole {
  return member?.payload.isPrimary === false ? 'secondary' : 'primary';
}

/** Force an `age` anchor's `memberId` to the giver's role (a `year` anchor has
 *  no member). Keeps the persisted/displayed anchor honest with the engine's
 *  giver-based window resolution — the member selector is hidden, but a
 *  freshly-switched `age` kind or a stored cross-member anchor is normalized
 *  here so the slider bounds + display always reflect the giver. Generic over
 *  the `start` / `end` anchor (both are the `age | year` subset). */
function withGiverAnchorMember<A extends QcdEntry['start'] | QcdEntry['end']>(
  anchor: A,
  giverRole: HouseholdRole,
): A {
  return anchor.kind === 'age'
    ? ({ kind: 'age', memberId: giverRole, years: anchor.years, months: anchor.months } as A)
    : anchor;
}

/** One QCD row editor: a collapsed one-line summary that expands to the
 *  member + source pickers, annual amount, the start/end window, and the
 *  inline 70½ eligibility hint. */
const QcdRow: React.FC<{
  index: number;
  entry: DraftQcd;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  memberOptions: ReadonlyArray<MemberOption>;
  /** Eligible source IRAs for the row's currently-selected member. */
  sources: ReadonlyArray<AccountOption>;
  firstEligibleYear: number | undefined;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** True when this row is implicated by the backwards-window or
   *  same-account-overlap guards. */
  hasWindowProblem: boolean;
  onChange: (next: DraftQcd) => void;
  onRemove: () => void;
}> = ({
  index,
  entry,
  members,
  memberOptions,
  sources,
  firstEligibleYear,
  expanded,
  onExpandedChange,
  hasWindowProblem,
  onChange,
  onRemove,
}) => {
  // The age-anchor member is ALWAYS the giver — the engine resolves the QCD
  // window from the giver's birthdate (resolveQcdForScenario), ignoring the
  // anchor's own member. So normalize both anchors to the giver's role before
  // widening for the picker (honest display + correct slider bounds), and pass
  // `memberSelectable={false}` so the picker never offers a non-giver member.
  const giverRole = giverRoleFor(members.find((m) => m.id === entry.memberId));
  const giverStart = withGiverAnchorMember(entry.start, giverRole);
  const giverEnd = withGiverAnchorMember(entry.end, giverRole);
  const startAnchor: GlideAnchor = magiCapEndToGlideAnchor(giverStart);
  const endAnchor: GlideAnchor = magiCapEndToGlideAnchor(giverEnd);
  // Floor the whole window at the giver's 70½ eligibility: the age slider min is
  // 70 (the 70½ statutory floor on a whole-year slider) and the year slider min
  // is the giver's 70½ first-eligible year. A giver with no birthdate has no
  // resolvable year, so floor only the age (never invent a year floor). Both
  // pickers share the same floor — the entire QCD window must be ≥ 70½.
  const windowFloor =
    firstEligibleYear !== undefined
      ? { age: QCD_MIN_AGE, year: firstEligibleYear }
      : { age: QCD_MIN_AGE };

  const summary = (
    <>
      {memberDisplayName(members.find((m) => m.id === entry.memberId), entry.memberId)}{' '}
      <span className="text-muted">gives from</span> {nameOf(sources, entry.sourceAccountId)}
      {' · '}
      {describeStart(giverStart, members)}
      {' → '}
      {describeEnd(giverEnd, members)}
      {firstEligibleYear === undefined && (
        <>
          {' '}
          <Badge tone="modified">Add a birthdate</Badge>
        </>
      )}
    </>
  );

  return (
    <li>
      <EntryDisclosureRow
        label={`QCD ${index + 1}`}
        summary={summary}
        problem={hasWindowProblem ? 'Needs attention' : undefined}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-4">
              <div className="flex flex-col gap-1">
                <label
                  htmlFor={`qcd-member-${index}`}
                  className="text-sm font-medium text-ink"
                >
                  Who is giving
                </label>
                <Select
                  id={`qcd-member-${index}`}
                  value={entry.memberId}
                  onChange={(v) => onChange({ ...entry, memberId: v })}
                  options={memberOptions.map((m) => ({ value: m.id, label: m.name }))}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor={`qcd-source-${index}`}
                  className="text-sm font-medium text-ink"
                >
                  Give from this traditional IRA
                </label>
                <Select
                  id={`qcd-source-${index}`}
                  value={entry.sourceAccountId}
                  onChange={(v) => onChange({ ...entry, sourceAccountId: v })}
                  options={sources.map((a) => ({ value: a.id, label: a.name }))}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  htmlFor={`qcd-amount-${index}`}
                  className="text-sm font-medium text-ink"
                >
                  Amount to give each year
                </label>
                <div className="min-w-0 max-w-44">
                  <MoneyInput
                    variant="cell"
                    ariaLabel={`Amount to give each year for QCD ${index + 1}`}
                    value={entry.annualAmountDollars}
                    onChange={(v) => onChange({ ...entry, annualAmountDollars: v })}
                    allowNegative={false}
                  />
                </div>
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              <ScheduleAnchorPicker
                label="Give starting"
                hideRetirementStart
                members={members}
                memberSelectable={false}
                defaultMemberId={giverRole}
                floor={windowFloor}
                value={startAnchor}
                onChange={(a) =>
                  onChange({
                    ...entry,
                    start: withGiverAnchorMember(glideAnchorToMagiCapEnd(a), giverRole),
                  })
                }
              />
              <ScheduleAnchorPicker
                label="Give through"
                hideRetirementStart
                members={members}
                memberSelectable={false}
                defaultMemberId={giverRole}
                floor={windowFloor}
                value={endAnchor}
                onChange={(a) =>
                  onChange({
                    ...entry,
                    end: withGiverAnchorMember(glideAnchorToMagiCapEnd(a), giverRole),
                  })
                }
              />
            </div>
          </div>
          <Muted className="m-0 text-sm">
            {firstEligibleYear !== undefined
              ? `This gift starts no earlier than ${firstEligibleYear}, the year this person turns 70½ — the first year a QCD is allowed. An earlier start is automatically moved up to that year.`
              : 'This gift is allowed only from the year this person turns 70½. Add their birthdate on the Household page so the projection can apply the gift.'}
          </Muted>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onRemove}
              className="text-sm font-medium text-negative hover:text-negative/80"
              aria-label={`Remove QCD ${index + 1}`}
            >
              Remove
            </button>
          </div>
        </div>
      </EntryDisclosureRow>
    </li>
  );
};

export interface QcdEditorProps {
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

export const QcdEditor: React.FC<QcdEditorProps> = ({
  scenario,
  scenarios,
  householdId,
  accounts,
  members,
  backPath,
  onSaved,
}) => {
  const {
    draft: { qcds },
    inheritedFromName,
    addQcd,
    updateQcd,
    removeQcd,
    isDirty,
  } = useQcdDraft(scenario, scenarios);

  // Eligible source IRAs for a given member: active `RETIREMENT_IRA` with
  // `PRE_TAX` treatment owned by that member (the same cross-owner filter the
  // resolver re-checks). `isEligibleQcdSource` already excludes inactive
  // accounts, so a closed IRA never seeds a dead source.
  const sourcesForMember = useMemo<(memberId: string) => AccountOption[]>(
    () =>
      (memberId: string): AccountOption[] =>
        accounts
          .filter((a) => isEligibleQcdSource(a.payload, memberId))
          .map((a) => ({ id: a.id, name: a.payload.name })),
    [accounts],
  );

  // Members who own at least one eligible IRA — the only members offered.
  const memberOptions = useMemo<MemberOption[]>(
    () =>
      members
        .filter((m) => sourcesForMember(m.id).length > 0)
        .map((m) => ({ id: m.id, name: memberDisplayName(m, m.id) })),
    [members, sourcesForMember],
  );

  const firstUsableMember = memberOptions[0];
  const canAdd = firstUsableMember !== undefined;

  const memberById = useMemo<Map<string, Aggregate<HouseholdMemberPayload>>>(
    () => new Map(members.map((m) => [m.id, m])),
    [members],
  );

  // Account payload by id (mirrors `buildNextQcd`) — used to scope window
  // validation to the rows that will SURVIVE the save-prune.
  const accountById = useMemo<Map<string, AccountPayload>>(
    () => new Map(accounts.map((a) => [a.id, a.payload])),
    [accounts],
  );

  // True iff a draft row's source passes the same kept-draft predicate
  // `buildNextQcd` prunes by (active `RETIREMENT_IRA` + `PRE_TAX` owned by the
  // giver). A row that FAILS this is going to be pruned on save, so the window
  // validations below must NOT flag it — a prunable bad-source row's backwards
  // or overlapping window must never block the documented save-prune cleanup.
  const isKeptDraft = useMemo<(q: DraftQcd) => boolean>(
    () =>
      (q: DraftQcd): boolean =>
        isEligibleQcdSource(accountById.get(q.sourceAccountId), q.memberId),
    [accountById],
  );

  // Resolve every row to its inclusive `[startYear, endYear]`, keyed by index.
  // Each row's anchors are EXPLICITLY normalized to the giver's role here
  // (mirroring the display / save / engine paths) BEFORE resolution, so the age
  // window always resolves against the giver's birthdate — never a stored or
  // imported non-giver anchor member (which differs in age). A `null` entry is
  // unresolvable — EITHER missing birthdate OR an ineligible source that the
  // save-prune will drop (so its window is never validated/flagged). Both
  // validations skip a `null` entry. Reused by the backwards +
  // same-account-overlap checks below.
  const resolvedYears = useMemo<({ startYear: number; endYear: number } | null)[]>(
    () => {
      const ctx = buildQcdResolveCtx(members);
      return qcds.map((q) => {
        // A row whose source is ineligible will be PRUNED on save, so treat it
        // as not-validated (null) — never flag a window that won't persist.
        if (!isKeptDraft(q)) return null;
        const giverRole = giverRoleFor(memberById.get(q.memberId));
        return resolveQcdYears(
          {
            start: withGiverAnchorMember(q.start, giverRole),
            end: withGiverAnchorMember(q.end, giverRole),
          },
          ctx,
        );
      });
    },
    [qcds, members, memberById, isKeptDraft],
  );

  // Validation 1 — backwards window (end year before start year). A row whose
  // resolved startYear > endYear gives nothing. `start == end` (single-year) is
  // valid; an unresolvable row is skipped (handled by the missing-birthdate
  // hint, not flagged here). 1-based row numbers.
  const backwardsRows = useMemo<number[]>(() => {
    const offending: number[] = [];
    resolvedYears.forEach((years, i) => {
      if (years && years.startYear > years.endYear) offending.push(i + 1);
    });
    return offending;
  }, [resolvedYears]);
  const hasBackwardsWindow = backwardsRows.length > 0;

  // Validation 2 — two rows that draw from the SAME source IRA over overlapping
  // years. Inclusive year-ranges intersect iff `a1 <= b2 AND a2 <= b1`. Skip
  // unresolvable or backwards rows (their range is meaningless / handled by
  // validation 1). Group strictly by `sourceAccountId` (a source is owned by a
  // single giver, so same account ⟹ same giver). Collects ALL 1-based row
  // numbers involved in any same-account overlap.
  const overlapRows = useMemo<number[]>(() => {
    const offending = new Set<number>();
    for (let i = 0; i < qcds.length; i += 1) {
      const a = resolvedYears[i];
      if (!a || a.startYear > a.endYear) continue;
      for (let j = i + 1; j < qcds.length; j += 1) {
        if (qcds[i].sourceAccountId !== qcds[j].sourceAccountId) continue;
        const b = resolvedYears[j];
        if (!b || b.startYear > b.endYear) continue;
        if (a.startYear <= b.endYear && b.startYear <= a.endYear) {
          offending.add(i + 1);
          offending.add(j + 1);
        }
      }
    }
    return [...offending].sort((x, y) => x - y);
  }, [qcds, resolvedYears]);
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
    if (!canAdd || !firstUsableMember) return;
    const usableSources = sourcesForMember(firstUsableMember.id);
    if (usableSources.length === 0) return;
    const firstEligibleYear =
      firstEligibleYearFor(memberById.get(firstUsableMember.id)) ??
      new Date().getFullYear();
    const seed = defaultQcd(
      firstUsableMember.id,
      usableSources[0].id,
      firstEligibleYear,
    );
    addQcd(seed);
    setOpenRowId(seed.draftId);
  };

  const onSave = async (): Promise<void> => {
    if (!isDirty || hasBackwardsWindow || hasOverlap) return;
    setSubmitting(true);
    setError(null);
    let savedOk = false;
    try {
      // Strip the key first so a sparse OMIT (an all-removed list) DELETES the
      // previously-stored key, then re-spread only the present fragment.
      const {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-omit: binding exists only to strip the key from the rest
        qualifiedCharitableDistributions: _omit,
        ...restOverrides
      } = scenario.payload.overrides;
      const nextOverrides = {
        ...restOverrides,
        ...buildNextQcd({ drafts: qcds, accounts, members }),
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

  const latestLimit = latestPublishedQcdLimitDollars();

  return (
    <div className="flex flex-col gap-4">
      {inheritedFromName && (
        <Muted className="text-sm">
          These QCDs are inherited from {inheritedFromName}. Editing here
          overrides them for this scenario only.
        </Muted>
      )}

      {!canAdd && (
        <Alert tone="info">
          To set up a Qualified Charitable Distribution you need at least one
          active traditional IRA (a tax-deferred IRA). Add one to your plan
          first; only the IRA&apos;s owner can give from it.
        </Alert>
      )}

      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium text-ink">
              Qualified Charitable Distributions
            </h3>
            <Muted className="m-0 text-sm">
              Each QCD gives the chosen amount directly from a traditional IRA to
              charity every year in its window, starting no earlier than the year
              the giver turns 70½. The gift stays out of that person&apos;s
              taxable income, and once an IRA required minimum distribution
              applies it counts toward that distribution.
            </Muted>
          </div>
          {qcds.length === 0 ? (
            <Muted className="m-0 text-sm">No QCDs yet.</Muted>
          ) : (
            <ul
              className="flex flex-col gap-3 p-0"
              aria-label="Qualified Charitable Distributions"
            >
              {qcds.map((entry, i) => (
                <QcdRow
                  key={entry.draftId}
                  index={i}
                  entry={entry}
                  members={members}
                  memberOptions={memberOptions}
                  sources={sourcesForMember(entry.memberId)}
                  firstEligibleYear={firstEligibleYearFor(
                    memberById.get(entry.memberId),
                  )}
                  expanded={openRowId === entry.draftId}
                  onExpandedChange={(open) =>
                    setOpenRowId(open ? entry.draftId : null)
                  }
                  hasWindowProblem={
                    backwardsRows.includes(i + 1) || overlapRows.includes(i + 1)
                  }
                  onChange={(next) => {
                    // Switching the giver re-points the source to that member's
                    // first eligible IRA when the current one no longer applies,
                    // and re-points the age anchors' member to the new giver's
                    // role (the anchor member must always follow the giver — the
                    // engine resolves the window from the giver's birthdate).
                    if (next.memberId !== entry.memberId) {
                      const newGiverRole = giverRoleFor(
                        memberById.get(next.memberId),
                      );
                      let repointed: DraftQcd = {
                        ...next,
                        start: withGiverAnchorMember(next.start, newGiverRole),
                        end: withGiverAnchorMember(next.end, newGiverRole),
                      };
                      const newSources = sourcesForMember(next.memberId);
                      if (
                        newSources.length > 0 &&
                        !newSources.some((s) => s.id === repointed.sourceAccountId)
                      ) {
                        repointed = {
                          ...repointed,
                          sourceAccountId: newSources[0].id,
                        };
                      }
                      updateQcd(i, repointed);
                      return;
                    }
                    updateQcd(i, next);
                  }}
                  onRemove={() => {
                    removeQcd(i);
                    if (openRowId === entry.draftId) setOpenRowId(null);
                  }}
                />
              ))}
            </ul>
          )}
          <div>
            <button
              type="button"
              onClick={onAdd}
              disabled={!canAdd}
              className={`${textLinkClass} text-sm disabled:cursor-not-allowed disabled:text-muted`}
            >
              Add a QCD
            </button>
          </div>
        </div>
      </Card>

      {hasBackwardsWindow && (
        <Alert tone="error">
          {backwardsRows.length === 1
            ? `Gift ${backwardsRows[0]}: the end year is before the start year — set the end to the same year or later.`
            : `Gifts ${backwardsRows.join(', ')}: the end year is before the start year — set each end to the same year or later.`}
        </Alert>
      )}

      {hasOverlap && (
        <Alert tone="error">
          {overlapRows.length === 2
            ? `Gifts ${overlapRows[0]} and ${overlapRows[1]} give from the same IRA in overlapping years — change the source account or the windows so each account's gift years don't overlap.`
            : `Gifts ${overlapRows.slice(0, -1).join(', ')} and ${overlapRows[overlapRows.length - 1]} give from the same IRA in overlapping years — change the source account or the windows so each account's gift years don't overlap.`}
        </Alert>
      )}

      <Card>
        <div className="flex flex-col gap-3">
          <Muted className="m-0 text-sm">
            Each year&apos;s gift is automatically capped at the smaller of the
            IRS per-person limit
            {latestLimit > 0
              ? ` (${formatCurrency(latestLimit)} for the latest published year, rising with inflation)`
              : ''}{' '}
            and the IRA&apos;s available balance — you never give more than
            either allows.
          </Muted>
          <Muted className="m-0 text-sm">
            The yearly amount is in today&apos;s dollars; the projection raises it
            with inflation each year.
          </Muted>
          <Alert tone="warning">
            A QCD is separate from any charitable giving you model as an expense.
            If you already capture this gift as a household expense, don&apos;t
            add it here too, or your plan will count the same money twice.
          </Alert>
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
