// The standalone snapshot-purge Lambda handler: the guard, the paging list-and-delete loop and the partial-delete failure path. The handler builds its own S3Client at module scope,
// so @aws-sdk/client-s3's S3Client is stubbed (real command classes kept) and `send` driven per test.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Context } from 'aws-lambda';

const send = jest.fn();
const s3ClientCtor = jest.fn().mockImplementation(() => ({ send }));

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest
      .fn()
      .mockImplementation((...args: unknown[]) => s3ClientCtor(...args)),
  };
});

import { handler } from '../account-snapshot-purge-lambda.js';

const CONTEXT = {} as Context;

function listResult(keys: string[]) {
  return {
    Contents: keys.map((Key) => ({ Key })),
    IsTruncated: false,
  };
}

describe('snapshot-purge Lambda — validateHouseholdId guard', () => {
  beforeEach(() => {
    send.mockReset();
    process.env.SNAPSHOTS_BUCKET = 'snapshots-bucket';
  });

  it.each([
    ['an empty string', ''],
    ['a non-string', 123 as unknown as string],
    ['a value containing "/"', 'abc/def'],
  ])('rejects %s', async (_label, value) => {
    await expect(
      handler({ householdId: value } as { householdId: string }, CONTEXT),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('snapshot-purge Lambda — S3 client config', () => {
  beforeEach(() => {
    send.mockReset();
    process.env.SNAPSHOTS_BUCKET = 'snapshots-bucket';
  });

  it('constructs the S3 client with explicit request + connection timeouts', async () => {
    const householdId = randomUUID();
    send.mockResolvedValueOnce(listResult([]));

    await handler({ householdId }, CONTEXT);

    // The handler caches one S3Client built lazily on the first purge; whichever test builds it first, the constructor must carry bounded timeouts (no SDK defaults), as every outbound call is time-bounded.
    expect(s3ClientCtor).toHaveBeenCalled();
    const config = s3ClientCtor.mock.calls[0][0] as {
      requestHandler?: { requestTimeout?: number; connectionTimeout?: number };
    };
    expect(config.requestHandler?.requestTimeout).toBeGreaterThan(0);
    expect(config.requestHandler?.connectionTimeout).toBeGreaterThan(0);
  });
});

describe('snapshot-purge Lambda — delete loop', () => {
  beforeEach(() => {
    send.mockReset();
    process.env.SNAPSHOTS_BUCKET = 'snapshots-bucket';
  });

  it('lists + deletes only under the household prefix and returns the count', async () => {
    const householdId = randomUUID();
    send
      .mockResolvedValueOnce(
        listResult([`${householdId}/a.json.gz`, `${householdId}/b.json.gz`]),
      )
      .mockResolvedValueOnce({}); // DeleteObjects success — no Errors[].

    const result = await handler({ householdId }, CONTEXT);

    expect(result).toEqual({ deleted: 2 });
    const listInput = send.mock.calls[0][0].input;
    expect(listInput.Prefix).toBe(`${householdId}/`);
    const deleteInput = send.mock.calls[1][0].input;
    expect(deleteInput.Delete.Objects).toEqual([
      { Key: `${householdId}/a.json.gz` },
      { Key: `${householdId}/b.json.gz` },
    ]);
  });

  it('keep-key mode: excludes keepKeys from the delete and counts only the deleted objects', async () => {
    const householdId = randomUUID();
    send
      .mockResolvedValueOnce(
        listResult([
          `${householdId}/live.json.gz`,
          `${householdId}/old-a.json.gz`,
          `${householdId}/old-b.json.gz`,
        ]),
      )
      .mockResolvedValueOnce({}); // DeleteObjects success — no Errors[].

    const result = await handler(
      { householdId, keepKeys: [`${householdId}/live.json.gz`] },
      CONTEXT,
    );

    expect(result).toEqual({ deleted: 2 });
    const deleteInput = send.mock.calls[1][0].input;
    expect(deleteInput.Delete.Objects).toEqual([
      { Key: `${householdId}/old-a.json.gz` },
      { Key: `${householdId}/old-b.json.gz` },
    ]);
  });

  it('keep-key mode: issues no delete when every listed object is preserved', async () => {
    const householdId = randomUUID();
    send.mockResolvedValueOnce(listResult([`${householdId}/live.json.gz`]));

    const result = await handler(
      { householdId, keepKeys: [`${householdId}/live.json.gz`] },
      CONTEXT,
    );

    expect(result).toEqual({ deleted: 0 });
    expect(send).toHaveBeenCalledTimes(1); // list only, no delete
  });

  it('normalizeKeepKeys: a non-array keepKeys degrades to keep-nothing (deletes all, scoped to the prefix)', async () => {
    const householdId = randomUUID();
    send
      .mockResolvedValueOnce(
        listResult([`${householdId}/a.json.gz`, `${householdId}/b.json.gz`]),
      )
      .mockResolvedValueOnce({}); // DeleteObjects success — no Errors[].

    const result = await handler(
      { householdId, keepKeys: 'not-an-array' as unknown as string[] },
      CONTEXT,
    );

    // A malformed keep-list can only fail to match, never widen the delete, so every listed object under the prefix is purged.
    expect(result).toEqual({ deleted: 2 });
    expect(send.mock.calls[0][0].input.Prefix).toBe(`${householdId}/`);
    const deleteObjects = send.mock.calls[1][0].input.Delete.Objects as Array<{
      Key: string;
    }>;
    expect(deleteObjects).toEqual([
      { Key: `${householdId}/a.json.gz` },
      { Key: `${householdId}/b.json.gz` },
    ]);
    for (const o of deleteObjects) {
      expect(o.Key.startsWith(`${householdId}/`)).toBe(true);
    }
  });

  it('normalizeKeepKeys: a non-string keepKeys entry is dropped → keep-nothing (deletes all under the prefix)', async () => {
    const householdId = randomUUID();
    send
      .mockResolvedValueOnce(
        listResult([`${householdId}/a.json.gz`, `${householdId}/b.json.gz`]),
      )
      .mockResolvedValueOnce({}); // DeleteObjects success — no Errors[].

    const result = await handler(
      { householdId, keepKeys: [123 as unknown as string] },
      CONTEXT,
    );

    expect(result).toEqual({ deleted: 2 });
    const deleteObjects = send.mock.calls[1][0].input.Delete.Objects as Array<{
      Key: string;
    }>;
    expect(deleteObjects).toEqual([
      { Key: `${householdId}/a.json.gz` },
      { Key: `${householdId}/b.json.gz` },
    ]);
    for (const o of deleteObjects) {
      expect(o.Key.startsWith(`${householdId}/`)).toBe(true);
    }
  });

  it('returns { deleted: 0 } and issues no delete when the prefix is empty', async () => {
    const householdId = randomUUID();
    send.mockResolvedValueOnce(listResult([]));

    const result = await handler({ householdId }, CONTEXT);

    expect(result).toEqual({ deleted: 0 });
    expect(send).toHaveBeenCalledTimes(1); // list only, no delete
  });

  it('throws when DeleteObjects reports a partial-delete error', async () => {
    const householdId = randomUUID();
    send
      .mockResolvedValueOnce(listResult([`${householdId}/a.json.gz`]))
      .mockResolvedValueOnce({
        Errors: [{ Key: `${householdId}/a.json.gz`, Code: 'AccessDenied' }],
      });

    await expect(handler({ householdId }, CONTEXT)).rejects.toThrow();
  });
});
