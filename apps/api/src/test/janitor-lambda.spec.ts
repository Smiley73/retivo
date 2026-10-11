/**
 * Lambda-handler integration test for the snapshot janitor.
 *
 * `janitor.spec.ts` exercises `JanitorService.runOnce()` against the
 * AppModule context. This test invokes the deployed handler entry
 * point — `janitor-lambda.handler` — which boots
 * `JanitorLambdaModule` via `NestFactory.createApplicationContext`,
 * the same path EventBridge takes in production.
 *
 * Catches the same class of regressions that bit the compactor
 * Lambda: missing ConfigModule.forRoot in the standalone
 * wrapper, accidental loadSecretsFromSsm(), env-var typos that only
 * matter in the Lambda env.
 */
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
    // The handler caches its own standalone Nest context (`cachedApp`) whose
    // AWS clients hold separate keep-alive pools that `t.app.close()` never
    // touches. Tear down both contexts; the try/finally guarantees the
    // bootstrapped app still closes even if the cached-context teardown
    // throws (the first error is preserved).
    try {
      await closeJanitorForTests();
    } finally {
      await t.app.close();
    }
  });

  it('boots the standalone Nest context and returns a run summary', async () => {
    // Seed one snapshot so the bucket isn't empty — exercises the
    // listing + grouping paths even though nothing here is delete-eligible.
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

    // Smoke-check the seeded object survived (1 < minKeep=10).
    const r = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: 'household-handler-smoke/',
      }),
    );
    expect((r.Contents ?? []).length).toBe(1);
  });
});
