// Post-commit strand guard: a delayed push commit can land a row at or below the compaction cutoff, invisible to pull, so PushService re-appends it with a
// cursor-dominating id (cursor + 1s, original payload). A unit test with a stubbed document client, since the minted id and household cursor must be deterministic.
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import KSUID from 'ksuid';
import { PushService } from '../sync/push.service.js';
import { IdempotencyKeyRepository } from '../dynamo/idempotency-key.repository.js';
import { WorkspaceMetaRepository } from '../dynamo/workspace-meta.repository.js';
import type { PushMutationDto } from '../sync/dto/push.dto.js';
import type { MutationLogRow } from '../dynamo/types.js';

const MUTATION_LOG_TABLE = 'TABLE_MUTATION_LOG';

function encryptedEnvelope(): Record<string, unknown> {
  return {
    encryptionVersion: 1,
    keyId: 'hh-key-1',
    alg: 'AES-256-GCM',
    nonce: 'bm9uY2VfYnl0ZXM',
    ciphertext: 'Y2lwaGVydGV4dF9ieXRlcw',
  };
}

function mutation(): PushMutationDto {
  return {
    id: randomUUID(),
    aggregateId: randomUUID(),
    aggregateType: 'account',
    operation: 'create',
    version: 0,
    schemaVersion: 1,
    payload: encryptedEnvelope(),
    timestamp: Date.now(),
    deviceId: 'dev-1',
  };
}

interface Harness {
  service: PushService;
  putCommands: PutCommand[];
}

function buildHarness(opts: {
  cursor: string | null;
  reappendThrows?: boolean;
}): Harness {
  const putCommands: PutCommand[] = [];
  const doc = {
    send: jest.fn(async (command: unknown) => {
      if (command instanceof TransactWriteCommand) return {}; // apply commits
      if (command instanceof PutCommand) {
        putCommands.push(command);
        if (opts.reappendThrows) throw new Error('transient DynamoDB fault');
        return {};
      }
      if (command instanceof GetCommand) return { Item: undefined };
      return {};
    }),
  } as unknown as DynamoDBDocumentClient;

  const idem = {
    lookup: jest.fn(async () => null),
  } as unknown as IdempotencyKeyRepository;

  const meta = {
    createIfMissing: jest.fn(async () => ({})),
    bumpVersionIfHigher: jest.fn(async () => undefined),
    bumpFreshnessHead: jest.fn(async () => null),
    find: jest.fn(async () =>
      opts.cursor === null ? null : { latestSnapshotCursor: opts.cursor },
    ),
    chargeDailyQuota: jest.fn(async () => ({ ok: true })),
  } as unknown as WorkspaceMetaRepository;

  const config = {
    get: (key: string) => key,
  } as unknown as ConfigService;

  return { service: new PushService(doc, idem, meta, config as never), putCommands };
}

function logPutsOf(putCommands: PutCommand[]): PutCommand[] {
  return putCommands.filter((c) => c.input.TableName === MUTATION_LOG_TABLE);
}

const FRESHNESS = { freshnessCounter: 1, cursorTag: 'a'.repeat(43) };

describe('PushService — post-commit strand re-append', () => {
  it('re-appends a cursor-dominating MutationLog row when the minted sequenceId sits at/below the cursor', async () => {
    // A cursor an hour in the future dominates any current-second KSUID.random(), so the committed row is a strand.
    const cursor = KSUID.fromParts(Date.now() + 60 * 60_000, Buffer.alloc(16)).string;
    const { service, putCommands } = buildHarness({ cursor });
    const m = mutation();

    const res = await service.push({
      householdId: 'hh-1',
      deviceId: 'dev-1',
      mutations: [m],
      freshnessHead: FRESHNESS,
    });

    expect(res.applied).toHaveLength(1);
    expect(res.applied[0].sequenceId! <= cursor).toBe(true);

    const logPuts = logPutsOf(putCommands);
    expect(logPuts).toHaveLength(1);
    const row = logPuts[0].input.Item as MutationLogRow;
    expect(row.sequenceId > cursor).toBe(true);
    expect(row.aggregateId).toBe(m.aggregateId);
    expect(row.version).toBe(res.applied[0].newVersion);
    expect(row.payload).toBe(JSON.stringify(m.payload));
  });

  it('re-appends STRICTLY above a SAME-SECOND cursor whose payload is HIGHER than the strand row (locks the +1s successor jump)', async () => {
    // A fresh KSUID.random() is unsafe: a same-second cursor with a higher payload sorts above it, so only the +1s timestamp jump dominates. Date.now is pinned so the
    // strand shares the cursor's second, and the cursor's 0xFF payload exceeds the strand's; a `KSUID_STRAND_SUCCESSOR_MS = 0` regression would sort below it.
    const fixedNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      const cursor = KSUID.fromParts(fixedNow, Buffer.alloc(16, 0xff)).string;
      const { service, putCommands } = buildHarness({ cursor });
      const m = mutation();

      const res = await service.push({
        householdId: 'hh-1',
        deviceId: 'dev-1',
        mutations: [m],
        freshnessHead: FRESHNESS,
      });

      expect(res.applied).toHaveLength(1);
      const strandSeq = res.applied[0].sequenceId!;
      expect(strandSeq <= cursor).toBe(true);
      expect(KSUID.parse(strandSeq).timestamp).toBe(KSUID.parse(cursor).timestamp);
      expect(KSUID.parse(cursor).payload.compare(KSUID.parse(strandSeq).payload)).toBeGreaterThan(0);

      const logPuts = logPutsOf(putCommands);
      expect(logPuts).toHaveLength(1);
      const row = logPuts[0].input.Item as MutationLogRow;
      expect(row.sequenceId > cursor).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does NOT re-append when the minted sequenceId already sits above the cursor', async () => {
    const cursor = KSUID.fromParts(Date.now() - 60 * 60_000, Buffer.alloc(16)).string;
    const { service, putCommands } = buildHarness({ cursor });

    const res = await service.push({
      householdId: 'hh-1',
      deviceId: 'dev-1',
      mutations: [mutation()],
      freshnessHead: FRESHNESS,
    });

    expect(res.applied).toHaveLength(1);
    expect(logPutsOf(putCommands)).toHaveLength(0);
  });

  it('does NOT re-append when the household has no compaction cursor yet', async () => {
    const { service, putCommands } = buildHarness({ cursor: null });

    const res = await service.push({
      householdId: 'hh-1',
      deviceId: 'dev-1',
      mutations: [mutation()],
      freshnessHead: FRESHNESS,
    });

    expect(res.applied).toHaveLength(1);
    expect(logPutsOf(putCommands)).toHaveLength(0);
  });

  it('a thrown post-commit re-append never fails the already-committed push', async () => {
    const cursor = KSUID.fromParts(Date.now() + 60 * 60_000, Buffer.alloc(16)).string;
    const { service, putCommands } = buildHarness({ cursor, reappendThrows: true });

    const res = await service.push({
      householdId: 'hh-1',
      deviceId: 'dev-1',
      mutations: [mutation()],
      freshnessHead: FRESHNESS,
    });

    expect(res.applied).toHaveLength(1);
    expect(res.applied[0].status).toBe('applied');
    expect(logPutsOf(putCommands)).toHaveLength(1);
  });

  it('re-appends DISTINCT cursor-dominating ids for multiple stranded rows in one batch', async () => {
    const cursor = KSUID.fromParts(Date.now() + 60 * 60_000, Buffer.alloc(16)).string;
    const { service, putCommands } = buildHarness({ cursor });

    const res = await service.push({
      householdId: 'hh-1',
      deviceId: 'dev-1',
      mutations: [mutation(), mutation()],
      freshnessHead: FRESHNESS,
    });

    expect(res.applied).toHaveLength(2);
    const logPuts = logPutsOf(putCommands);
    expect(logPuts).toHaveLength(2);
    const seqs = logPuts.map((c) => (c.input.Item as MutationLogRow).sequenceId);
    // Each re-append reuses its own row's payload, so a second stranded row cannot overwrite the first with a colliding zero-payload id.
    expect(new Set(seqs).size).toBe(2);
    for (const seq of seqs) expect(seq > cursor).toBe(true);
  });
});
