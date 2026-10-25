// Shared Cash Balance Pension resolver and validator, so every engine and the remediation banners read one election.
// Elections live on the linked IncomeStream via `linkedCbpAccountId`.

import { resolveIncomeForScenarioSparse } from './income-override-resolution';
import type { ScenarioAggregate } from './scenario-resolution';
import type {
  AccountPayload,
  Aggregate,
  IncomeStreamPayload,
} from '../db/types';

/** `lumpSum` rolls the balance into `targetAccountId` at retirement; `annuity` references the income stream carrying the monthly benefit. */
export type ResolvedCbpElection =
  | {
      readonly kind: 'lumpSum';
      readonly streamId: string;
      readonly targetAccountId: string;
    }
  | {
      readonly kind: 'annuity';
      readonly streamId: string;
    };

export interface ResolveLinkedCbpInput {
  readonly scenarioId: string;
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
}

/**
 * The payout election per Cash Balance Pension account for the active scenario,
 * from the sparse-resolved income list indexed by `linkedCbpAccountId`. Exactly
 * one matching pension stream wins; zero or several surface via
 * `validateCbpResolution` instead. On an `INDIVIDUAL` account a stream owned by
 * someone else does not match. Non-CBP accounts are absent.
 */
export function resolveLinkedCbpIncomeStreams(
  input: ResolveLinkedCbpInput,
): Map<string, ResolvedCbpElection> {
  const { scenarioId, scenarios, accounts, incomeStreams } = input;
  const resolved = resolveIncomeForScenarioSparse(
    scenarioId,
    scenarios as ScenarioAggregate[],
    incomeStreams,
  );
  const streamsByLink = new Map<
    string,
    Array<{ payload: IncomeStreamPayload; id: string }>
  >();
  for (const r of resolved) {
    const link = r.payload.linkedCbpAccountId;
    if (typeof link !== 'string' || link.length === 0) continue;
    if (r.payload.kind !== 'pension') continue;
    const arr = streamsByLink.get(link) ?? [];
    arr.push({ payload: r.payload, id: r.id });
    streamsByLink.set(link, arr);
  }

  const out = new Map<string, ResolvedCbpElection>();
  for (const acct of accounts) {
    if (acct.payload.type !== 'RETIREMENT_CASH_BALANCE') continue;
    const candidates = streamsByLink.get(acct.id) ?? [];
    const owned = candidates.filter((c) =>
      ownerMatchesAccount(c.payload, acct.payload),
    );
    if (owned.length !== 1) continue;
    const c = owned[0];
    if (c.payload.payoutType === 'annuity') {
      out.set(acct.id, { kind: 'annuity', streamId: c.id });
    } else if (c.payload.payoutType === 'lumpSum') {
      const target = c.payload.targetAccountId;
      if (typeof target !== 'string' || target.length === 0) continue;
      out.set(acct.id, { kind: 'lumpSum', streamId: c.id, targetAccountId: target });
    }
  }
  return out;
}

/**
 * Accounts needing remediation before any engine runs. `unconfigured`: no linked
 * stream, so engines hard-block. `annuityDuplicateStream`: two or more matching
 * streams. `annuityMissingStream` is reserved and always empty. `ok` means every
 * CBP account resolved to exactly one election.
 */
export interface CbpValidationResult {
  readonly ok: boolean;
  readonly unconfigured: ReadonlyArray<string>;
  readonly annuityMissingStream: ReadonlyArray<string>;
  readonly annuityDuplicateStream: ReadonlyArray<string>;
}

export function validateCbpResolution(
  input: ResolveLinkedCbpInput,
): CbpValidationResult {
  const { scenarioId, scenarios, accounts, incomeStreams } = input;
  const resolved = resolveIncomeForScenarioSparse(
    scenarioId,
    scenarios as ScenarioAggregate[],
    incomeStreams,
  );
  const streamsByLink = new Map<
    string,
    Array<{ payload: IncomeStreamPayload }>
  >();
  for (const r of resolved) {
    const link = r.payload.linkedCbpAccountId;
    if (typeof link !== 'string' || link.length === 0) continue;
    if (r.payload.kind !== 'pension') continue;
    const arr = streamsByLink.get(link) ?? [];
    arr.push({ payload: r.payload });
    streamsByLink.set(link, arr);
  }

  const unconfigured: string[] = [];
  const annuityDuplicateStream: string[] = [];
  for (const acct of accounts) {
    if (acct.payload.type !== 'RETIREMENT_CASH_BALANCE') continue;
    const candidates = streamsByLink.get(acct.id) ?? [];
    const owned = candidates.filter((c) =>
      ownerMatchesAccount(c.payload, acct.payload),
    );
    if (owned.length === 0) {
      unconfigured.push(acct.id);
      continue;
    }
    if (owned.length > 1) {
      annuityDuplicateStream.push(acct.id);
      continue;
    }
  }

  return {
    ok:
      unconfigured.length === 0 &&
      annuityDuplicateStream.length === 0,
    unconfigured,
    annuityMissingStream: [],
    annuityDuplicateStream,
  };
}

function ownerMatchesAccount(
  stream: IncomeStreamPayload,
  account: AccountPayload,
): boolean {
  if (account.ownershipType !== 'INDIVIDUAL') return true;
  return stream.memberId === account.ownerId;
}

/** Deep link to the Income form pre-filled to elect a payout for a Cash Balance Pension account; `memberId` comes from the account owner. */
export function incomeAddPath(account: Aggregate<AccountPayload>): string {
  const params = new URLSearchParams({
    kind: 'pension',
    payoutType: 'annuity',
    linkedCbpAccountId: account.id,
    memberId: account.payload.ownerId,
  });
  return `/income/new?${params.toString()}`;
}
