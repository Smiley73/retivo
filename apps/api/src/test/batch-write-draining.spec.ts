/**
 * Unit tests for `batchWriteDraining` — the shared household-sweep helper
 * that drains DynamoDB `BatchWriteItem` `UnprocessedItems`.
 *
 * DynamoDB can return HTTP 200 with a non-empty `UnprocessedItems` map
 * (throttling / capacity) that the SDK does NOT auto-resubmit. The four
 * sweep repos route their batch-delete through this helper so a throttled
 * sweep resubmits the leftover items (delete is idempotent) instead of
 * silently leaving household rows behind. Focused unit test: the document
 * client is stubbed so the send sequence is deterministic; fake timers
 * collapse the backoff sleeps so the persistent-throttle case stays fast.
 */
import {
  BatchWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  BATCH_WRITE_MAX_ATTEMPTS,
  BatchWriteDrainError,
  batchWriteDraining,
  type BatchWriteRequestItems,
} from '../dynamo/batch-write.util.js';

const TABLE = 'MutationLog';

function deleteRequest(id: string) {
  return { DeleteRequest: { Key: { householdId: 'hh-1', sequenceId: id } } };
}

describe('batchWriteDraining', () => {
  it('resubmits exactly the unprocessed items until the map drains', async () => {
    const initial: BatchWriteRequestItems = {
      [TABLE]: [deleteRequest('a'), deleteRequest('b')],
    };
    // First send leaves `b` unprocessed; the resubmit clears it.
    const leftover: BatchWriteRequestItems = { [TABLE]: [deleteRequest('b')] };
    const send = jest
      .fn()
      .mockResolvedValueOnce({ UnprocessedItems: leftover })
      .mockResolvedValueOnce({ UnprocessedItems: {} });
    const doc = { send } as unknown as DynamoDBDocumentClient;

    await expect(batchWriteDraining(doc, initial)).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(2);
    // The second send carries ONLY the returned unprocessed subset — not the
    // full original batch.
    const secondCommand = send.mock.calls[1][0] as BatchWriteCommand;
    expect(secondCommand).toBeInstanceOf(BatchWriteCommand);
    expect(secondCommand.input.RequestItems).toEqual(leftover);
  });

  it('throws BatchWriteDrainError when unprocessed items never drain', async () => {
    jest.useFakeTimers();
    try {
      const items: BatchWriteRequestItems = { [TABLE]: [deleteRequest('a')] };
      // Every send reports the same item unprocessed — a persistent throttle.
      const send = jest.fn().mockResolvedValue({ UnprocessedItems: items });
      const doc = { send } as unknown as DynamoDBDocumentClient;

      const promise = batchWriteDraining(doc, items);
      // Surface the rejection to the pending-rejection tracker before draining
      // timers, so a throw inside the loop is captured rather than unhandled.
      const assertion = expect(promise).rejects.toBeInstanceOf(
        BatchWriteDrainError,
      );
      await jest.runAllTimersAsync();
      await assertion;

      expect(send).toHaveBeenCalledTimes(BATCH_WRITE_MAX_ATTEMPTS);
    } finally {
      jest.useRealTimers();
    }
  });
});
