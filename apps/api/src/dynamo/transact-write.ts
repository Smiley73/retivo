// Shared helper for the atomic auth-state transactions: decodes TransactionCanceledException reasons, since a transaction never
// throws ConditionalCheckFailedException by name.
import {
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';

// Cancellation reasons treated as transient: retried, then surfaced as a transient error.
const TRANSIENT_CANCELLATION_CODES = new Set([
  'TransactionConflict',
  'ThrottlingError',
  'ProvisionedThroughputExceeded',
  'RequestLimitExceeded',
]);

const MAX_TRANSACTION_ATTEMPTS = 3;

const BACKOFF_JITTER_MS = 20;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Backoff before the next transient retry: linear base plus jitter so contending writers do not retry in lockstep.
 * Shared with the key-envelope stable-set read.
 */
export const backoffMs = (attempt: number): number =>
  20 * attempt + Math.floor(Math.random() * BACKOFF_JITTER_MS);

/**
 * Thrown when a transaction is cancelled for a transient reason that survives the bounded retry; callers map it to
 * 503, never a business conflict.
 */
export class TransientTransactionError extends Error {
  constructor(message = 'Transaction could not commit right now; retry later') {
    super(message);
    this.name = 'TransientTransactionError';
  }
}

type CancellationReason = { Code?: string };

export type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

/**
 * Sends a `TransactWriteItems` with per-reason decoding and bounded transient retry. On ConditionalCheckFailed,
 * `onConditionFailed` runs with the reasons and must throw the operation conflict error; a transient reason that
 * persists throws TransientTransactionError.
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
