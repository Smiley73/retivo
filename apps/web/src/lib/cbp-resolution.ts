/**
 * Shared Cash Balance Pension resolver + validator.
 *
 * Every engine that touches CBP payouts — the deterministic balance
 * projection, the Monte Carlo input builder, and the stress-test
 * card — reads the same resolved election + validation result so
 * remediation banners stay in sync. CBP elections
 * live on the linked IncomeStream via `linkedCbpAccountId`;
 * this module does the per-CBP-account walk and applies the
 * annuity-match predicate.
 *
 * Pure module — no IndexedDB, no React, no Date.now().
 */
import { resolveIncomeForScenarioSparse } from './income-override-resolution';
import type { ScenarioAggregate } from './scenario-resolution';
import type {
  AccountPayload,
  Aggregate,
  IncomeStreamPayload,
} from '../db/types';

/**
 * The elected CBP payout for a given CBP account in the active
 * scenario. `lumpSum` carries the target account the balance rolls
 * into at retirement; `annuity` references the linked income stream
 * that carries the monthly benefit forward.
 */
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
 * For every Cash Balance Pension account in the household, returns
 * the resolved payout election that the active scenario produces.
 *
 * The walk:
 * 1. Resolve the scenario's full income list via the per-id sparse
 *    resolver — this folds parent / child overrides, disables, and
 *    re-enables into a single flat list.
 * 2. Index resolved streams by `linkedCbpAccountId`.
 * 3. For each CBP account, apply the annuity-match rule: exactly one matching
 *    pension stream wins. Zero matches or multiple matches surface
 *    via `validateCbpResolution` instead of returning an entry.
 *    When the matching stream's owner differs from the CBP account
 *    owner on an `INDIVIDUAL` account, the match is rejected
 *    (treated as zero matches).
 *
 * Accounts that aren't CBP type are absent from the returned map.
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
 * CBP validation result: surfaces every account in the household
 * that needs remediation before any engine should run.
 *
 * - `unconfigured` — CBP account with **no** linked income stream of
 *   any payout type. The user hasn't elected a payout — engines hard-
 *   block.
 * - `annuityMissingStream` — currently identical to `unconfigured`
 *   for v1; reserved for future "user picked annuity but the linked
 *   stream is missing" semantics if a separate election surface ever
 *   reappears. Today it is always empty (the form-level path is
 *   covered by `unconfigured`).
 * - `annuityDuplicateStream` — CBP account with two or more matching
 *   linked streams. Engines hard-block; remediation UI
 *   surfaces the conflict.
 *
 * `ok` is true iff every CBP account resolved to exactly one valid
 * election.
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
    // Exactly one match — valid.
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

/**
 * Deep-link path to the Income form, pre-filled to elect a payout for a
 * Cash Balance Pension account. The form understands the query params
 * (`kind=pension`, `payoutType`, `linkedCbpAccountId`, `memberId`).
 *
 * Account-only: `memberId` derives from the account owner, so the link
 * needs no member/scenario context. Shared by `CbpRemediationBanner`
 * and the custom-drawdown-order info section (an in-app relative path,
 * not a user-controlled redirect).
 */
export function incomeAddPath(account: Aggregate<AccountPayload>): string {
  const params = new URLSearchParams({
    kind: 'pension',
    payoutType: 'annuity',
    linkedCbpAccountId: account.id,
    memberId: account.payload.ownerId,
  });
  return `/income/new?${params.toString()}`;
}
