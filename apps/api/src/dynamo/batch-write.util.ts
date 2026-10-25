// Draining BatchWriteItem helper for the household sweeps: resubmits UnprocessedItems with bounded backoff, since the SDK does not
// and a throttled sweep would silently drop rows.
import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

type BatchWriteRequestItems = NonNullable<
  BatchWriteCommandInput['RequestItems']
>;

// Total attempts (initial send + resubmits) before giving up.
const BATCH_WRITE_MAX_ATTEMPTS = 8;
const BATCH_WRITE_BASE_DELAY_MS = 50;
const BATCH_WRITE_MAX_DELAY_MS = 1000;

class BatchWriteDrainError extends Error {
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
  // Full jitter spreads concurrent resubmits so they do not re-collide on a throttled shard.
  return Math.random() * capped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends a `BatchWriteItem` (at most 25 requests; callers chunk) and drains `UnprocessedItems`. @throws
 * {BatchWriteDrainError} if items remain unprocessed after `BATCH_WRITE_MAX_ATTEMPTS`, so the sweep fails rather than
 * leave rows behind.
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
