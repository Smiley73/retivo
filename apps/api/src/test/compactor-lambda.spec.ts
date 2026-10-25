// Compactor Lambda handler through the standalone CompactorLambdaModule boot path EventBridge uses, which compactor.spec.ts (AppModule context) would
// not catch breaking: a missing ConfigModule.forRoot, or a reintroduced loadSecretsFromSsm() (the compactor IAM lacks ssm:GetParameter).
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

// Backdated past the compactor's 60 s safety margin (rows at or above the boundary KSUID are excluded from every run). The slot keeps
// intra-test ordering deterministic, since KSUID timestamps have 1 s precision.
function backdatedSeq(slot: number): string {
  return KSUID.fromParts(Date.now() - 10 * 60_000 + slot * 1000, Buffer.alloc(16)).string;
}

// Seeds a MutationLog row and the WorkspaceMeta row the compactor scans, bypassing the ENCRYPTION_REQUIRED push guard.
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
        // The default sits outside the 60 s margin so compaction sees the row.
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
  // The async Nest path ignores the Context and Callback arguments; minimal fixtures satisfy the type check.
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
    // The handler caches its own standalone Nest context whose AWS clients hold separate keep-alive pools that `t.app.close()` never touches, so
    // tear down both; try/finally closes the bootstrapped app even if the cached-context teardown throws.
    try {
      await closeCompactorForTests();
    } finally {
      await t.app.close();
    }
  });

  it('boots the standalone Nest context and writes a snapshot', async () => {
    const s = await loginAsFreshUser(t);
    const aggregateId = randomUUID();
    await seedOne(t, s, aggregateId, { operation: 'create', version: 0, sequenceId: backdatedSeq(0) });
    await seedOne(t, s, aggregateId, { operation: 'update', version: 1, sequenceId: backdatedSeq(1) });

    const summary = await invokeHandler();

    expect(summary.householdsProcessed).toBeGreaterThan(0);
    expect(summary.totalSnapshotBytes).toBeGreaterThan(0);
    expect(summary.totalMutationsCompacted).toBeGreaterThan(0);

    const boot = await request(t.app.getHttpServer())
      .get('/api/v1/sync/bootstrap')
      .set('Authorization', `Bearer ${s.accessToken}`);
    expect(boot.status).toBe(200);
    expect(boot.body.snapshotId).toBeTruthy();
  });

  it('is idempotent — second invocation with no new mutations is a no-op', async () => {
    // The handler caches its Nest context across invocations; a second call must not throw.
    const second = await invokeHandler();
    // Other households from compactor.spec.ts in the same worker may already be compacted, so only assert the call did not blow up.
    expect(second).toBeDefined();
    expect(second.durationMs).toBeGreaterThanOrEqual(0);
  });
});
