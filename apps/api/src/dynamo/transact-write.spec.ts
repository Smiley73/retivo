/**
 * Unit tests for the shared `runTransactWrite` primitive.
 *
 * Focused unit test (not an emulator integration test): the local DynamoDB
 * emulator cannot deterministically produce a `TransactionConflict`
 * cancellation, so we stub the document client's `send` to throw crafted
 * `TransactionCanceledException`s (mirroring
 * `apps/api/src/test/push-transient-cancel.spec.ts`) and assert the per-reason
 * decode + bounded transient retry contract:
 *
 *   (a) a `ConditionalCheckFailed` reason invokes the `onConditionFailed`
 *       callback (and does NOT retry);
 *   (b) a persistent transient reason retries up to the bound, then throws
 *       `TransientTransactionError`;
 *   (c) a transient reason that clears on a later attempt resolves normally;
 *   (d) any non-`TransactionCanceledException` error rethrows untouched, no retry.
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type {
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  runTransactWrite,
  TransientTransactionError,
} from './transact-write.js';

type TransactItems = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>;

const ITEMS: TransactItems = [
  { Put: { TableName: 'T', Item: { pk: 'a' } } },
];

function transactCancel(codes: string[]): TransactionCanceledException {
  return new TransactionCanceledException({
    message: 'Transaction cancelled, please refer to CancellationReasons',
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

function docThatThrows(err: unknown): {
  doc: DynamoDBDocumentClient;
  send: jest.Mock;
} {
  const send = jest.fn(async () => {
    throw err;
  });
  return { doc: { send } as unknown as DynamoDBDocumentClient, send };
}

describe('runTransactWrite', () => {
  it('invokes onConditionFailed on a ConditionalCheckFailed reason and does not retry', async () => {
    const { doc, send } = docThatThrows(
      transactCancel(['ConditionalCheckFailed', 'None']),
    );
    const sentinel = new Error('app-level conflict');
    const reasonsSeen: unknown[] = [];
    const onConditionFailed = jest.fn((reasons: { Code?: string }[]): never => {
      reasonsSeen.push(reasons);
      throw sentinel;
    });

    await expect(runTransactWrite(doc, ITEMS, onConditionFailed)).rejects.toBe(
      sentinel,
    );
    // The callback fired exactly once with the decoded reasons array…
    expect(onConditionFailed).toHaveBeenCalledTimes(1);
    expect(reasonsSeen[0]).toEqual([
      { Code: 'ConditionalCheckFailed' },
      { Code: 'None' },
    ]);
    // …and a condition failure is terminal — no retry.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries a persistent transient reason up to the bound, then throws TransientTransactionError', async () => {
    const { doc, send } = docThatThrows(transactCancel(['TransactionConflict']));
    const onConditionFailed = jest.fn((): never => {
      throw new Error('should not be called');
    });

    await expect(
      runTransactWrite(doc, ITEMS, onConditionFailed),
    ).rejects.toBeInstanceOf(TransientTransactionError);
    // Bounded at 3 attempts (MAX_TRANSACTION_ATTEMPTS).
    expect(send).toHaveBeenCalledTimes(3);
    expect(onConditionFailed).not.toHaveBeenCalled();
  });

  it('resolves when a transient reason clears on a later attempt', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(transactCancel(['ThrottlingError']))
      .mockResolvedValueOnce({});
    const doc = { send } as unknown as DynamoDBDocumentClient;
    const onConditionFailed = jest.fn((): never => {
      throw new Error('should not be called');
    });

    await expect(
      runTransactWrite(doc, ITEMS, onConditionFailed),
    ).resolves.toBeUndefined();
    // One transient failure + one success.
    expect(send).toHaveBeenCalledTimes(2);
    expect(onConditionFailed).not.toHaveBeenCalled();
  });

  it('rethrows a non-TransactionCanceledException error untouched, with no retry', async () => {
    const boom = new Error('network down');
    const { doc, send } = docThatThrows(boom);
    const onConditionFailed = jest.fn((): never => {
      throw new Error('should not be called');
    });

    await expect(runTransactWrite(doc, ITEMS, onConditionFailed)).rejects.toBe(
      boom,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(onConditionFailed).not.toHaveBeenCalled();
  });
});
