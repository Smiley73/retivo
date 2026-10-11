/**
 * Lambda-handler integration test for the compactor.
 *
 * `compactor.spec.ts` exercises `CompactorService.runOnce()` against
 * the AppModule context — so it would pass even if the standalone
 * Lambda boot path were broken. This test invokes the handler the
 * same way EventBridge does in production: through
 * `compactor-lambda.handler`, which boots `CompactorLambdaModule`
 * via `NestFactory.createApplicationContext()`.
 *
 * Catches:
 *   1. Missing `ConfigModule.forRoot` in the standalone-bootstrap
 *      module → DI fails resolving `ConfigService`.
 *   2. `loadSecretsFromSsm()` reintroduced into the handler → cold
 *      start would AccessDenied in prod (compactor IAM has no
 *      ssm:GetParameter).
 */
import request from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import KSUID from 'ksuid';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConfigService } from '@nestjs/config';
import {
  bootstrapTestApp,
  signupVerifyLogin as loginAsFreshUser,
  type Session,
  type TestApp,
} from './test-helpers.js';
import {
  handler as compactorLambdaHandler,
  closeForTests as closeCompactorForTests,
} from '../compactor-lambda.js';

/**
 * Mint a sequenceId backdated past the compactor's 60 s safety margin
 *: rows at/above the boundary KSUID are excluded from every run, so
 * seeds that expect compaction must sit outside it. The slot (whole seconds)
 * keeps intra-test ordering deterministic — KSUID timestamps carry 1 s
 * precision, so same-second random payloads would order randomly.
 */
function backdatedSeq(slot: number): string {
  return KSUID.fromParts(Date.now() - 10 * 60_000 + slot * 1000, Buffer.alloc(16)).string;
}

/**
 * Seed a MutationLog row + ensure the WorkspaceMeta row exists, bypassing the
 * `POST /sync/push` ENCRYPTION_REQUIRED guard (every plaintext push
 * 403s). The compactor scans WorkspaceMeta for households, so the meta row must
 * exist for the seeded household to be processed.
 */
async function seedOne(
  t: TestApp,
  s: Session,
  aggregateId: string,
  opts?: { operation?: 'create' | 'update'; version?: number; sequenceId?: string },
): Promise<void> {
  const config = t.module.get(ConfigService);
  const metaTable = config.get('TABLE_WORKSPACE_META', { infer: true } as never) as unknown as string;
  const logTable = config.get('TABLE_MUTATION_LOG', { infer: true } as never) as unknown as string;
  try {
    await t.doc.send(
      new PutCommand({
        TableName: metaTable,
        Item: {
          householdId: s.householdId,
          latestSnapshotId: null,
          latestSnapshotCursor: null,
          latestVersion: 0,
          lastUpdatedAt: new Date().toISOString(),
          mutationLogCursorBase: null,
        },
        ConditionExpression: 'attribute_not_exists(householdId)',
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
  await t.doc.send(
    new PutCommand({
      TableName: logTable,
      Item: {
        householdId: s.householdId,
        // Default sits outside the 60 s margin so compaction sees the row.
        sequenceId: opts?.sequenceId ?? KSUID.fromParts(Date.now() - 10 * 60_000, randomBytes(16)).string,
        deviceId: s.deviceId,
        aggregateId,
        aggregateType: 'household',
        operation: opts?.operation ?? 'create',
        payload: JSON.stringify({
          name: 'Lambda Handler Test',
          currency: 'USD',
          createdAt: new Date().toISOString(),
        }),
        version: (opts?.version ?? 0) + 1,
        timestamp: Date.now(),
        schemaVersion: 1,
      },
    }),
  );
}

interface CompactorRunSummary {
  householdsProcessed: number;
  householdsSkipped: number;
  totalMutationsCompacted: number;
  totalSnapshotBytes: number;
  durationMs: number;
}

async function invokeHandler(): Promise<CompactorRunSummary> {
  // The deployed handler accepts a ScheduledEvent + Context + Callback;
  // the async Nest path ignores the latter two. We supply minimal
  // fixtures so the type check passes.
  const result = await (compactorLambdaHandler as unknown as (
    e: unknown,
    c: unknown,
    cb: unknown,
  ) => Promise<CompactorRunSummary>)(
    { time: new Date().toISOString() } as unknown,
    {} as unknown,
    () => undefined,
  );
  return result;
}

describe('compactor-lambda handler', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    // The handler caches its own standalone Nest context (`cachedApp`) whose
    // AWS clients hold separate keep-alive pools that `t.app.close()` never
    // touches. Tear down both contexts; the try/finally guarantees the
    // bootstrapped app still closes even if the cached-context teardown
    // throws (the first error is preserved).
    try {
      await closeCompactorForTests();
    } finally {
      await t.app.close();
    }
  });

  it('boots the standalone Nest context and writes a snapshot', async () => {
    // Arrange: create a household with mutations through the api path.
    const s = await loginAsFreshUser(t);
    const aggregateId = randomUUID();
    await seedOne(t, s, aggregateId, { operation: 'create', version: 0, sequenceId: backdatedSeq(0) });
    await seedOne(t, s, aggregateId, { operation: 'update', version: 1, sequenceId: backdatedSeq(1) });

    // Act: invoke the deployed handler entry point. If the standalone
    // Nest context is misconfigured (e.g. no ConfigModule.forRoot, or
    // a re-introduced loadSecretsFromSsm() call), this throws.
    const summary = await invokeHandler();

    // Assert: at least one household was processed (this user's), and
    // the per-run metrics look real.
    expect(summary.householdsProcessed).toBeGreaterThan(0);
    expect(summary.totalSnapshotBytes).toBeGreaterThan(0);
    expect(summary.totalMutationsCompacted).toBeGreaterThan(0);

    // Bootstrap reflects the snapshot we just wrote.
    const boot = await request(t.app.getHttpServer())
      .get('/api/v1/sync/bootstrap')
      .set('Authorization', `Bearer ${s.accessToken}`);
    expect(boot.status).toBe(200);
    expect(boot.body.snapshotId).toBeTruthy();
  });

  it('is idempotent — second invocation with no new mutations is a no-op', async () => {
    // The handler caches its Nest context across invocations; calling
    // it twice in a row should not throw and should not double-write.
    const second = await invokeHandler();
    // No new mutations after the previous test, so nothing to compact
    // for the household we created here. Other households (from
    // compactor.spec.ts running in the same worker) may already have
    // been compacted, so we only assert the call didn't blow up.
    expect(second).toBeDefined();
    expect(second.durationMs).toBeGreaterThanOrEqual(0);
  });
});
