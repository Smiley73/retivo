/**
 * Pure helpers for the QCD sub-page Save path. Builds the
 * sparse `qualifiedCharitableDistributions` override fragment the page spreads
 * into one `nextOverrides` object and dispatches via a single `saveScenario`.
 *
 * Sparse-persist rule (mirrors the Roth-conversions save helpers):
 *  - the QCD array is OMITTED when it resolves to empty (so an all-removed
 *    scenario inherits / carries no key);
 *  - an entry is PRUNED at save (orphan cleanup) unless its source resolves to an
 *    ACTIVE `RETIREMENT_IRA` with `PRE_TAX` treatment owned by the entry's
 *    `memberId` (equality, never truthiness), so a re-save never carries a
 *    wrong-type, inactive, cross-owner, or dangling id forward;
 *  - the amount is sanitised to a finite, non-negative whole-dollar figure.
 *
 * The engine resolver (`resolveQcdForScenario`) re-hardens type/treatment/owner/
 * window at the engine boundary (import-bundle threat surface). This
 * UI-side save-prune adds an ACTIVE-account check on top of those resolver
 * checks (matching the editor's source picker + the Roth-conversion eligibility
 * precedent), so a closed/inactive IRA never survives a re-save.
 */
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  HouseholdRole,
  ScenarioPayload,
} from '../db/types';
import type { DraftQcd } from './scenario-qcd-draft-hook';

type ScenarioOverrides = ScenarioPayload['overrides'];

/** A persisted QCD entry — the exact stored shape on `ScenarioOverrides`. */
export type PersistedQcd = NonNullable<
  ScenarioOverrides['qualifiedCharitableDistributions']
>[number];

/** True when `account` is an ACTIVE traditional IRA (`RETIREMENT_IRA` +
 *  `PRE_TAX`) owned by `memberId` — the same eligibility predicate the
 *  editor's source `<Select>` filters by. The active-account check mirrors the
 *  Roth-conversion eligibility precedent (`isConvertibleRothConversionSource` /
 *  `isWorkingYearsRothConversionTarget` both require `active`); the engine
 *  resolver re-checks type/treatment/owner but not `active`, so this predicate
 *  is what excludes a closed IRA from the picker and prunes it on save. */
export function isEligibleQcdSource(
  account: AccountPayload | undefined,
  memberId: string,
): boolean {
  if (!account) return false;
  if (account.active !== true) return false;
  return (
    account.type === 'RETIREMENT_IRA' &&
    account.taxTreatment === 'PRE_TAX' &&
    account.ownerId === memberId
  );
}

/** The giver's `HouseholdRole` for an entry's `memberId` (a member UUID). A
 *  QCD's eligibility window is intrinsically the giver's (their 70½), and the
 *  engine resolves the age window from the giver's birthdate (ignoring the
 *  anchor's own member), so the persisted age anchor must always carry the
 *  giver's role. Defaults to `'primary'` for a dangling member id. */
function giverRole(
  memberId: string,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): HouseholdRole {
  return members.find((m) => m.id === memberId)?.payload.isPrimary === false
    ? 'secondary'
    : 'primary';
}

/** Force an `age` anchor's `memberId` to the giver's role (a `year` anchor has
 *  none). The member selector is hidden in the editor, but a stored cross-member
 *  anchor (or an older persisted entry) is normalized here so the persisted
 *  anchor never carries a non-giver member. */
function withGiverAnchorMember<A extends PersistedQcd['start'] | PersistedQcd['end']>(
  anchor: A,
  role: HouseholdRole,
): A {
  return anchor.kind === 'age'
    ? ({ kind: 'age', memberId: role, years: anchor.years, months: anchor.months } as A)
    : anchor;
}

/** Sanitise one draft entry into the stored shape: amount → finite, ≥ 0, whole
 *  dollars; `age` anchors normalized to the giver's role (the engine resolves
 *  the window from the giver's birthdate, so the anchor member must always be
 *  the giver). The transient `draftId` (a UI-only React key) is STRIPPED
 *  so it never persists. */
function toPersistedQcd(
  d: DraftQcd,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): PersistedQcd {
  const raw = d.annualAmountDollars;
  const amount = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
  const role = giverRole(d.memberId, members);
  return {
    memberId: d.memberId,
    sourceAccountId: d.sourceAccountId,
    annualAmountDollars: amount,
    start: withGiverAnchorMember(d.start, role),
    end: withGiverAnchorMember(d.end, role),
  };
}

/**
 * QCD-array fragment. Prunes an entry (orphan cleanup) unless its source is an
 * ACTIVE `RETIREMENT_IRA` + `PRE_TAX` account owned by the entry's `memberId`
 * (`isEligibleQcdSource`), so a re-save never carries a wrong-type, inactive,
 * cross-owner, or dangling id forward. (The engine resolver re-checks
 * type/treatment/owner/window; the active-account check is added here on the
 * UI side, matching the editor's source picker.) Then sanitises amounts and
 * OMITS the key entirely when nothing survives (sparse — empty array is never
 * persisted). The scenario then inherits / carries no QCDs. Each surviving
 * entry's `age` anchors are normalized to the giver's role — the engine
 * resolves the QCD window from the giver's birthdate, so a non-giver anchor
 * member is never persisted.
 */
export function buildNextQcd(args: {
  drafts: ReadonlyArray<DraftQcd>;
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
}): {
  qualifiedCharitableDistributions?: ReadonlyArray<PersistedQcd>;
} {
  const { drafts, accounts, members } = args;
  const accountById = new Map<string, AccountPayload>();
  for (const a of accounts) accountById.set(a.id, a.payload);
  const kept = drafts
    .filter((d) =>
      isEligibleQcdSource(accountById.get(d.sourceAccountId), d.memberId),
    )
    .map((d) => toPersistedQcd(d, members));
  return kept.length > 0
    ? { qualifiedCharitableDistributions: kept }
    : {};
}
