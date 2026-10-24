/** QCD list editor hosted by ScenarioQcdPage; each gift is capped by the indexed IRS limit and the IRA balance (disclosed below), never enforced on the input. */
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

// Latest published indexed §408(d)(8) limit, for the read-only disclosure copy; the engine extrapolates it forward per year.
function latestPublishedQcdLimitDollars(): number {
  const years = Object.keys(QCD_LIMITS.values)
    .map((y) => Number(y))
    .filter((y) => Number.isFinite(y));
  const latest = years.length > 0 ? Math.max(...years) : undefined;
  return latest !== undefined
    ? QCD_LIMITS.values[latest].annualLimitDollars
    : 0;
}

function defaultQcd(
  memberId: string,
  sourceAccountId: string,
  firstEligibleYear: number,
): DraftQcd {
  return {
    // Stable key so removing a middle row never mis-associates picker state; stripped before persist.
    draftId: cryptoUuid(),
    memberId,
    sourceAccountId,
    annualAmountDollars: 10000,
    start: { kind: 'year', year: firstEligibleYear },
    end: { kind: 'year', year: firstEligibleYear },
  };
}

// 70 on the whole-year slider stands for the 70½ floor; the engine clamps the resolved start to the precise 70½ tax year.
const QCD_MIN_AGE = 70;

interface MemberOption {
  id: string;
  name: string;
}

interface AccountOption {
  id: string;
  name: string;
}

function nameOf(options: ReadonlyArray<AccountOption>, id: string): string {
  return options.find((o) => o.id === id)?.name ?? 'Missing account';
}

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

// The age anchor must always carry the giver's role: resolveQcdForScenario resolves the window from the giver's birthdate and ignores the anchor's own memberId. Defaults to 'primary' for a dangling member id.
function giverRoleFor(
  member: Aggregate<HouseholdMemberPayload> | undefined,
): HouseholdRole {
  return member?.payload.isPrimary === false ? 'secondary' : 'primary';
}

function withGiverAnchorMember<A extends QcdEntry['start'] | QcdEntry['end']>(
  anchor: A,
  giverRole: HouseholdRole,
): A {
  return anchor.kind === 'age'
    ? ({ kind: 'age', memberId: giverRole, years: anchor.years, months: anchor.months } as A)
    : anchor;
}

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
  const giverRole = giverRoleFor(members.find((m) => m.id === entry.memberId));
  const giverStart = withGiverAnchorMember(entry.start, giverRole);
  const giverEnd = withGiverAnchorMember(entry.end, giverRole);
  const startAnchor: GlideAnchor = magiCapEndToGlideAnchor(giverStart);
  const endAnchor: GlideAnchor = magiCapEndToGlideAnchor(giverEnd);
  // Floor the whole window at 70½: age slider min 70, year slider min the giver's first-eligible year (no birthdate means no year floor, never invent one).
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
  backPath: string;
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

  const sourcesForMember = useMemo<(memberId: string) => AccountOption[]>(
    () =>
      (memberId: string): AccountOption[] =>
        accounts
          .filter((a) => isEligibleQcdSource(a.payload, memberId))
          .map((a) => ({ id: a.id, name: a.payload.name })),
    [accounts],
  );

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

  const accountById = useMemo<Map<string, AccountPayload>>(
    () => new Map(accounts.map((a) => [a.id, a.payload])),
    [accounts],
  );

  // A row failing the kept-draft predicate is pruned on save, so the window validations must not flag it or block the prune cleanup.
  const isKeptDraft = useMemo<(q: DraftQcd) => boolean>(
    () =>
      (q: DraftQcd): boolean =>
        isEligibleQcdSource(accountById.get(q.sourceAccountId), q.memberId),
    [accountById],
  );

  // Anchors are normalized to the giver's role before resolving; a null entry is unresolvable (missing birthdate, or a source the save-prune drops) and both validations skip it.
  const resolvedYears = useMemo<({ startYear: number; endYear: number } | null)[]>(
    () => {
      const ctx = buildQcdResolveCtx(members);
      return qcds.map((q) => {
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

  const backwardsRows = useMemo<number[]>(() => {
    const offending: number[] = [];
    resolvedYears.forEach((years, i) => {
      if (years && years.startYear > years.endYear) offending.push(i + 1);
    });
    return offending;
  }, [resolvedYears]);
  const hasBackwardsWindow = backwardsRows.length > 0;

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

  const [openRowId, setOpenRowId] = useState<string | null>(null);

  // The global pushState/replaceState patch also intercepts the breadcrumb <Link>.
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
      // Strip the key first so a sparse omit deletes the previously stored key.
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
                    // Switching the giver re-points the source and the age anchors' member to the new giver (the window resolves from the giver's birthdate).
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
