// Janitor Lambda handler through the standalone JanitorLambdaModule boot path EventBridge uses, catching the regressions that bit the compactor Lambda:
// a missing ConfigModule.forRoot, a stray loadSecretsFromSsm() and env-var typos that only matter in Lambda.
import {
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { bootstrapTestApp, type TestApp } from './test-helpers.js';
import { S3_CLIENT } from '../aws/aws.module.js';
import {
  handler as janitorLambdaHandler,
  closeForTests as closeJanitorForTests,
} from '../janitor-lambda.js';

interface JanitorRunSummary {
  householdsProcessed: number;
  totalKept: number;
  totalDeleted: number;
  unparseableKeys: number;
  durationMs: number;
}

async function invokeHandler(): Promise<JanitorRunSummary> {
  return (janitorLambdaHandler as unknown as (
    e: unknown,
    c: unknown,
    cb: unknown,
  ) => Promise<JanitorRunSummary>)(
    { time: new Date().toISOString() },
    {},
    () => undefined,
  );
}

describe('janitor-lambda handler', () => {
  let t: TestApp;
  let s3: S3Client;
  let bucket: string;

  beforeAll(async () => {
    process.env.SNAPSHOT_MIN_KEEP = '10';
    process.env.SNAPSHOT_MIN_AGE_DAYS = '90';
    t = await bootstrapTestApp();
    s3 = t.module.get<S3Client>(S3_CLIENT);
    bucket = t.module
      .get(ConfigService)
      .get('SNAPSHOTS_BUCKET', { infer: true } as never) as unknown as string;
  });

  afterAll(async () => {
    // The handler caches its own standalone Nest context whose AWS clients hold separate keep-alive pools that `t.app.close()` never touches, so
    // tear down both; try/finally closes the bootstrapped app even if the cached-context teardown throws.
    try {
      await closeJanitorForTests();
    } finally {
      await t.app.close();
    }
  });

  it('boots the standalone Nest context and returns a run summary', async () => {
    // One seeded snapshot exercises the listing and grouping paths though nothing is delete-eligible.
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: 'household-handler-smoke/2026-05-06T11-00-00-000Z.json.gz',
        Body: Buffer.from('{}'),
      }),
    );

    const summary = await invokeHandler();

    expect(summary).toBeDefined();
    expect(summary.householdsProcessed).toBeGreaterThanOrEqual(1);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);

    // 1 < minKeep=10, so the seeded object survives.
    const r = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: 'household-handler-smoke/',
      }),
    );
    expect((r.Contents ?? []).length).toBe(1);
  });
});
