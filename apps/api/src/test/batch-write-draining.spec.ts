// batchWriteDraining, the household-sweep helper that drains BatchWriteItem UnprocessedItems: DynamoDB can return HTTP 200 with leftover items the SDK does not resubmit, so a throttled sweep must
// resubmit them (delete is idempotent) rather than leave rows behind. The document client is stubbed; fake timers collapse the backoff sleeps.
import {
  BatchWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { batchWriteDraining } from '../dynamo/batch-write.util.js';

type BatchWriteRequestItems = Parameters<typeof batchWriteDraining>[1];

const TABLE = 'MutationLog';

function deleteRequest(id: string) {
  return { DeleteRequest: { Key: { householdId: 'hh-1', sequenceId: id } } };
}

describe('batchWriteDraining', () => {
  it('resubmits exactly the unprocessed items until the map drains', async () => {
    const initial: BatchWriteRequestItems = {
      [TABLE]: [deleteRequest('a'), deleteRequest('b')],
    };
    const leftover: BatchWriteRequestItems = { [TABLE]: [deleteRequest('b')] };
    const send = jest
      .fn()
      .mockResolvedValueOnce({ UnprocessedItems: leftover })
      .mockResolvedValueOnce({ UnprocessedItems: {} });
    const doc = { send } as unknown as DynamoDBDocumentClient;

    await expect(batchWriteDraining(doc, initial)).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(2);
    // The second send carries only the returned unprocessed subset, not the full original batch.
    const secondCommand = send.mock.calls[1][0] as BatchWriteCommand;
    expect(secondCommand).toBeInstanceOf(BatchWriteCommand);
    expect(secondCommand.input.RequestItems).toEqual(leftover);
  });

  it('throws BatchWriteDrainError when unprocessed items never drain', async () => {
    jest.useFakeTimers();
    try {
      const items: BatchWriteRequestItems = { [TABLE]: [deleteRequest('a')] };
      const send = jest.fn().mockResolvedValue({ UnprocessedItems: items });
      const doc = { send } as unknown as DynamoDBDocumentClient;

      const promise = batchWriteDraining(doc, items);
      // Attaching the rejection handler before draining timers keeps a throw inside the loop from being unhandled.
      const assertion = expect(promise).rejects.toMatchObject({
        name: 'BatchWriteDrainError',
      });
      await jest.runAllTimersAsync();
      await assertion;

      expect(send).toHaveBeenCalledTimes(8);
    } finally {
      jest.useRealTimers();
    }
  });
});
