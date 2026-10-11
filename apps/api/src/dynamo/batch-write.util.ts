/**
 * Draining `BatchWriteItem` helper shared by the household-data sweep repos.
 *
 * DynamoDB can return HTTP 200 from a `BatchWriteItem` with a non-empty
 * `UnprocessedItems` map (throttling / capacity) — the AWS SDK does NOT
 * auto-resubmit those (it only retries throttling *exceptions*). Left
 * unhandled, a throttled sweep silently drops rows while the caller
 * proceeds to report success, breaking the sweep's completeness guarantee
 * (delete-account, encrypted-workspace reset, restore, and the
 * server-authoritative workspace clear all share this sweep).
 *
 * This helper drains `UnprocessedItems`: it resubmits exactly the returned
 * items with bounded exponential backoff + full jitter (deletes are
 * idempotent, so resubmitting is safe), until the map is empty; if it is
 * still non-empty after the bounded attempts it throws `BatchWriteDrainError`
 * so the sweep fails LOUD (complete-or-throws) rather than silently
 * incomplete. The happy path (no `UnprocessedItems`) is a single send with
 * no delay.
 */
import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

/** A `BatchWriteItem` `RequestItems` map (also the shape of `UnprocessedItems`). */
export type BatchWriteRequestItems = NonNullable<
  BatchWriteCommandInput['RequestItems']
>;

/** Total attempts (initial send + resubmits) before giving up. */
export const BATCH_WRITE_MAX_ATTEMPTS = 8;
/** First backoff delay; doubles each attempt, capped at `BATCH_WRITE_MAX_DELAY_MS`. */
const BATCH_WRITE_BASE_DELAY_MS = 50;
/** Ceiling for a single backoff delay (before jitter). */
const BATCH_WRITE_MAX_DELAY_MS = 1000;

/** Thrown when `UnprocessedItems` never drains within the bounded attempts. */
export class BatchWriteDrainError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BatchWriteDrainError';
  }
}

function pendingCount(items: BatchWriteRequestItems): number {
  let n = 0;
  for (const requests of Object.values(items)) {
    n += requests?.length ?? 0;
  }
  return n;
}

function backoffDelayMs(attempt: number): number {
  const capped = Math.min(
    BATCH_WRITE_MAX_DELAY_MS,
    BATCH_WRITE_BASE_DELAY_MS * 2 ** attempt,
  );
  // Full jitter (CODING_STANDARDS: retry transient failures with exponential
  // backoff + jitter) — a uniform draw in [0, capped] spreads concurrent
  // resubmits so they don't re-collide on the same throttled shard.
  return Math.random() * capped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a `BatchWriteItem` and drain any `UnprocessedItems`.
 *
 * @param doc shared DynamoDB document client.
 * @param requestItems the `RequestItems` map to write (≤ 25 requests — the
 *   BatchWriteItem cap; callers chunk to that size). Only the returned
 *   unprocessed subset (already ≤ 25) is ever resubmitted.
 * @throws {BatchWriteDrainError} if items remain unprocessed after
 *   `BATCH_WRITE_MAX_ATTEMPTS` attempts — the sweep must fail rather than
 *   silently leave rows behind.
 */
export async function batchWriteDraining(
  doc: DynamoDBDocumentClient,
  requestItems: BatchWriteRequestItems,
): Promise<void> {
  let pending: BatchWriteRequestItems = requestItems;
  for (let attempt = 0; attempt < BATCH_WRITE_MAX_ATTEMPTS; attempt++) {
    const output = await doc.send(
      new BatchWriteCommand({ RequestItems: pending }),
    );
    const unprocessed = output.UnprocessedItems as
      | BatchWriteRequestItems
      | undefined;
    if (!unprocessed || pendingCount(unprocessed) === 0) return;
    pending = unprocessed;
    if (attempt + 1 < BATCH_WRITE_MAX_ATTEMPTS) {
      await sleep(backoffDelayMs(attempt));
    }
  }
  throw new BatchWriteDrainError(
    `BatchWriteItem left ${pendingCount(pending)} item(s) unprocessed after ${BATCH_WRITE_MAX_ATTEMPTS} attempts`,
  );
}
