/** Pure helpers for the QCD sub-page Save: builds the sparse qualifiedCharitableDistributions fragment, pruning entries whose source is not an active RETIREMENT_IRA + PRE_TAX owned by the entry's memberId (equality, never truthiness). The engine resolver re-hardens type, treatment, owner and window but not `active`, which is added here. */
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  HouseholdRole,
  ScenarioPayload,
} from '../db/types';
import type { DraftQcd } from './scenario-qcd-draft-hook';

type ScenarioOverrides = ScenarioPayload['overrides'];

export type PersistedQcd = NonNullable<
  ScenarioOverrides['qualifiedCharitableDistributions']
>[number];

/** An active traditional IRA (RETIREMENT_IRA + PRE_TAX) owned by `memberId`; the engine resolver does not re-check `active`, so this excludes a closed IRA from the picker and prunes it on save. */
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

// The age anchor must always carry the giver's role (the engine resolves the window from the giver's birthdate, ignoring the anchor's own member); defaults to 'primary' for a dangling member id.
function giverRole(
  memberId: string,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): HouseholdRole {
  return members.find((m) => m.id === memberId)?.payload.isPrimary === false
    ? 'secondary'
    : 'primary';
}

function withGiverAnchorMember<A extends PersistedQcd['start'] | PersistedQcd['end']>(
  anchor: A,
  role: HouseholdRole,
): A {
  return anchor.kind === 'age'
    ? ({ kind: 'age', memberId: role, years: anchor.years, months: anchor.months } as A)
    : anchor;
}

// Sanitises one draft entry: amount to a finite, ≥ 0 whole-dollar figure; the transient draftId (a React key) is stripped.
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

/** The QCD-array fragment: prunes orphan entries (see `isEligibleQcdSource`), sanitises amounts, normalizes age anchors to the giver, and omits the key when nothing survives (an empty array is never persisted). */
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
