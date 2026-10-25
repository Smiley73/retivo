// AccountSnapshotPurgeService, which the account-deletion ordering test stubs: the Lambda path (a mocked LambdaClient drives success, SDK rejection, non-2xx and FunctionError, every non-success being a
// SnapshotPurgeError so deletion aborts before the irreversible sweeps) and the in-process fallback (real Moto S3 deletes only `${householdId}/` keys; a stubbed partial-delete Errors[] response throws).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import {
  AccountSnapshotPurgeService,
} from '../auth/account-snapshot-purge.service.js';
import { S3_CLIENT } from '../aws/aws.module.js';
import { bootstrapTestApp, type TestApp } from './test-helpers.js';
import type { EnvConfig } from '../common/env.config.js';

const PURGE_FN = 'retirement-test-snapshot-purge';

function makeConfig(overrides: Partial<EnvConfig>): ConfigService<EnvConfig, true> {
  const values: Partial<EnvConfig> = {
    SNAPSHOTS_BUCKET: 'snapshots-bucket',
    ...overrides,
  };
  return {
    get: (key: keyof EnvConfig) => values[key],
  } as unknown as ConfigService<EnvConfig, true>;
}

describe('AccountSnapshotPurgeService — Lambda invocation path', () => {
  function makeService(lambdaSend: jest.Mock): AccountSnapshotPurgeService {
    const lambda = { send: lambdaSend } as unknown as LambdaClient;
    const s3 = { send: jest.fn() } as unknown as S3Client;
    return new AccountSnapshotPurgeService(
      lambda,
      s3,
      makeConfig({ SNAPSHOT_PURGE_FUNCTION_NAME: PURGE_FN }),
    );
  }

  it('resolves when the Lambda returns a 2xx with no FunctionError', async () => {
    const householdId = randomUUID();
    const lambdaSend = jest.fn().mockResolvedValue({ StatusCode: 200 });
    const service = makeService(lambdaSend);

    await expect(service.purge(householdId)).resolves.toBeUndefined();

    const sent = lambdaSend.mock.calls[0][0];
    // The payload carries only the household id: no PII, no keepKeys.
    expect(JSON.parse(Buffer.from(sent.input.Payload).toString())).toEqual({
      householdId,
    });
  });

  it('includes keepKeys in the payload when the erase-history keep-key mode is used', async () => {
    const householdId = randomUUID();
    const keepKeys = [`${householdId}/2026-07-01T00-00-00-000Z.json.gz`];
    const lambdaSend = jest.fn().mockResolvedValue({ StatusCode: 200 });
    const service = makeService(lambdaSend);

    await expect(service.purge(householdId, { keepKeys })).resolves.toBeUndefined();

    const sent = lambdaSend.mock.calls[0][0];
    expect(JSON.parse(Buffer.from(sent.input.Payload).toString())).toEqual({
      householdId,
      keepKeys,
    });
  });

  it('throws SnapshotPurgeError when the SDK send rejects', async () => {
    const lambdaSend = jest.fn().mockRejectedValue(new Error('network down'));
    const service = makeService(lambdaSend);

    await expect(service.purge(randomUUID())).rejects.toMatchObject({ name: 'SnapshotPurgeError' });
  });

  it('throws SnapshotPurgeError on a non-2xx StatusCode', async () => {
    const lambdaSend = jest.fn().mockResolvedValue({ StatusCode: 500 });
    const service = makeService(lambdaSend);

    await expect(service.purge(randomUUID())).rejects.toMatchObject({ name: 'SnapshotPurgeError' });
  });

  it('throws SnapshotPurgeError when the payload reports a FunctionError', async () => {
    const lambdaSend = jest
      .fn()
      .mockResolvedValue({ StatusCode: 200, FunctionError: 'Unhandled' });
    const service = makeService(lambdaSend);

    await expect(service.purge(randomUUID())).rejects.toMatchObject({ name: 'SnapshotPurgeError' });
  });
});

describe('AccountSnapshotPurgeService — in-process fallback (emulator S3)', () => {
  let t: TestApp;
  let s3: S3Client;
  let bucket: string;

  beforeAll(async () => {
    t = await bootstrapTestApp();
    s3 = t.module.get<S3Client>(S3_CLIENT);
    bucket = t.module
      .get(ConfigService)
      .get('SNAPSHOTS_BUCKET', { infer: true } as never) as unknown as string;
  });

  afterAll(async () => {
    await t.app.close();
  });

  function makeService(): AccountSnapshotPurgeService {
    // No function name selects the in-process path; the Lambda client is never used.
    return new AccountSnapshotPurgeService(
      { send: jest.fn() } as unknown as LambdaClient,
      s3,
      makeConfig({ SNAPSHOTS_BUCKET: bucket }),
    );
  }

  async function seed(householdId: string, key: string): Promise<void> {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${householdId}/${key}`,
        Body: Buffer.from('seed'),
      }),
    );
  }

  async function countUnder(householdId: string): Promise<number> {
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: `${householdId}/` }),
    );
    return list.KeyCount ?? 0;
  }

  it('deletes only the target household prefix, leaving other households intact', async () => {
    const target = randomUUID();
    const other = randomUUID();
    await seed(target, 'a.json.gz');
    await seed(target, 'b.json.gz');
    await seed(other, 'a.json.gz');

    await makeService().purge(target);

    expect(await countUnder(target)).toBe(0);
    expect(await countUnder(other)).toBe(1);
  });

  it('keep-key mode: deletes every object EXCEPT the preserved key', async () => {
    const target = randomUUID();
    await seed(target, 'live.json.gz');
    await seed(target, 'old-a.json.gz');
    await seed(target, 'old-b.json.gz');

    await makeService().purge(target, {
      keepKeys: [`${target}/live.json.gz`],
    });

    expect(await countUnder(target)).toBe(1);
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: `${target}/` }),
    );
    expect((list.Contents ?? []).map((o) => o.Key)).toEqual([`${target}/live.json.gz`]);
  });

  it('throws SnapshotPurgeError when DeleteObjects reports a partial-delete error', async () => {
    const householdId = randomUUID();
    // The list returns one key but the delete reports an Errors[] entry (the HTTP-200-with-Errors partial-failure shape).
    const stubS3 = {
      send: jest.fn().mockImplementation((cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'ListObjectsV2Command') {
          return Promise.resolve({
            Contents: [{ Key: `${householdId}/a.json.gz` }],
            IsTruncated: false,
          });
        }
        return Promise.resolve({
          Errors: [{ Key: `${householdId}/a.json.gz`, Code: 'AccessDenied' }],
        });
      }),
    } as unknown as S3Client;
    const service = new AccountSnapshotPurgeService(
      { send: jest.fn() } as unknown as LambdaClient,
      stubS3,
      makeConfig({ SNAPSHOTS_BUCKET: bucket }),
    );

    await expect(service.purge(householdId)).rejects.toMatchObject({ name: 'SnapshotPurgeError' });
  });
});
