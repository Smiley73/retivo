/**
 * Shared helper for the atomic auth-state transactions.
 *
 * A DynamoDB `TransactWriteItems` NEVER throws the single-item
 * `ConditionalCheckFailedException` by name — it throws
 * `TransactionCanceledException` and reports each item's outcome in
 * `CancellationReasons[i].Code`. This helper runs a transaction and decodes
 * those reasons so callers map failures correctly:
 *
 *   - a `ConditionalCheckFailed` on any guarded item → the operation's existing
 *     application conflict error (the caller supplies it via `onConditionFailed`);
 *   - a `TransactionConflict` / throttling reason → TRANSIENT: retried with a
 *     small bounded backoff and, if still failing, surfaced as
 *     {@link TransientTransactionError} (which callers map to a `503`), so a
 *     network/throughput blip can never masquerade as another writer's edit.
 *
 * Any non-`TransactionCanceledException` error propagates untouched.
 */
import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';

/** Cancellation-reason codes treated as transient (retry, then transient error). */
const TRANSIENT_CANCELLATION_CODES = new Set([
  'TransactionConflict',
  'ThrottlingError',
  'ProvisionedThroughputExceeded',
  'RequestLimitExceeded',
]);

const MAX_TRANSACTION_ATTEMPTS = 3;

/** Upper bound (ms) of the random jitter added to each backoff step. */
const BACKOFF_JITTER_MS = 20;

/** Sleep for `ms` milliseconds (shared by the bounded-retry helpers). */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Backoff before the next transient retry: a linear base (`20 * attempt`) plus
 * randomized jitter so two writers contending on the same item do not retry in
 * lockstep.
 * Exported so the sibling bounded-read helpers (e.g. the key-envelope
 * stable-set bracketing read) reuse the same backoff/jitter shape rather than
 * re-deriving it.
 */
export const backoffMs = (attempt: number): number =>
  20 * attempt + Math.floor(Math.random() * BACKOFF_JITTER_MS);

/**
 * Thrown when a transaction is cancelled for a transient reason that survives
 * the bounded retry. Callers map this to a `503` — never a business conflict.
 */
export class TransientTransactionError extends Error {
  constructor(message = 'Transaction could not commit right now; retry later') {
    super(message);
    this.name = 'TransientTransactionError';
  }
}

type CancellationReason = { Code?: string };

/** One item of a `TransactWriteCommand`'s `TransactItems` array. */
export type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

/**
 * Send a `TransactWriteItems` with per-reason decoding and bounded transient
 * retry. On a `ConditionalCheckFailed` reason the caller's `onConditionFailed`
 * is invoked with the reasons array and MUST throw the operation's app-level
 * conflict error. A transient reason is retried; if it persists,
 * {@link TransientTransactionError} is thrown.
 */
export async function runTransactWrite(
  doc: DynamoDBDocumentClient,
  transactItems: NonNullable<
    ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
  >,
  onConditionFailed: (reasons: CancellationReason[]) => never,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt++) {
    try {
      await doc.send(new TransactWriteCommand({ TransactItems: transactItems }));
      return;
    } catch (err) {
      if (!(err instanceof TransactionCanceledException)) throw err;
      const reasons: CancellationReason[] = err.CancellationReasons ?? [];
      if (reasons.some((r) => r?.Code === 'ConditionalCheckFailed')) {
        onConditionFailed(reasons);
      }
      const transient = reasons.some(
        (r) => r?.Code && TRANSIENT_CANCELLATION_CODES.has(r.Code),
      );
      if (transient && attempt < MAX_TRANSACTION_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        continue;
      }
      if (transient) throw new TransientTransactionError();
      throw err;
    }
  }
}
