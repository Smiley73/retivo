/**
 * Post-commit strand guard. A KSUID `sequenceId` is minted
 * (`applyOne`, `KSUID.random()`) BEFORE the push transaction commits, so a
 * pathological commit delay can land a durable `MutationLog` row AT OR BELOW an
 * already-taken compaction cutoff (`WorkspaceMeta.latestSnapshotCursor`). Pull
 * returns only rows strictly ABOVE the cursor, so the strand is invisible to
 * every device. PushService re-appends each such row with a CURSOR-DOMINATING
 * sequenceId (`KSUID.fromParts(cursorTs + 1s, originalPayload)`) so pull + the
 * next snapshot see it. A fresh `KSUID.random()` would NOT guarantee this — its
 * current-second timestamp can sort below a same-second/future cursor.
 *
 * Focused unit test (not an emulator integration test): the minted sequenceId
 * and the household cursor must be controlled deterministically, which the
 * local DynamoDB emulator cannot do through the public push path. We stub the
 * document client + repositories and assert the re-append behavior directly.
 */
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
  /** Every PutCommand the stub doc client received (re-append writes). */
  putCommands: PutCommand[];
}

/**
 * Build a PushService whose apply transaction always commits, whose household
 * cursor is fixed, and whose re-append Put optionally throws.
 */
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

// Valid 43-char base64url cursorTag.
const FRESHNESS = { freshnessCounter: 1, cursorTag: 'a'.repeat(43) };

describe('PushService — post-commit strand re-append', () => {
  it('re-appends a cursor-dominating MutationLog row when the minted sequenceId sits at/below the cursor', async () => {
    // A cursor an hour in the FUTURE dominates any current-second
    // KSUID.random(), so the just-committed row is a strand → re-append.
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
    // The originally minted (below-cursor) sequenceId is the strand.
    expect(res.applied[0].sequenceId! <= cursor).toBe(true);

    const logPuts = logPutsOf(putCommands);
    expect(logPuts).toHaveLength(1);
    const row = logPuts[0].input.Item as MutationLogRow;
    // The re-appended sequenceId sorts STRICTLY above the cursor even though
    // the cursor is in the future (a fresh KSUID.random() would not guarantee
    // this).
    expect(row.sequenceId > cursor).toBe(true);
    // Same aggregate + committed version + payload as the original commit.
    expect(row.aggregateId).toBe(m.aggregateId);
    expect(row.version).toBe(res.applied[0].newVersion);
    expect(row.payload).toBe(JSON.stringify(m.payload));
  });

  it('re-appends STRICTLY above a SAME-SECOND cursor whose payload is HIGHER than the strand row (locks the +1s successor jump)', async () => {
    // The core rationale: a fresh KSUID.random() is unsafe
    // because a same-second (or future) cursor with a HIGHER payload sorts
    // above a naively-random re-append — only the +1s TIMESTAMP jump dominates
    // regardless of payload. Pin Date.now so the minted strand sequenceId
    // shares the cursor's second deterministically (no second-boundary flake),
    // and give the cursor a MAXIMAL (0xFF) payload so it is strictly greater
    // than the strand row's own random payload. A `KSUID_STRAND_SUCCESSOR_MS =
    // 0` regression (same-second, reuse the row's own lower payload) would sort
    // BELOW this cursor and fail the final assertion.
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
      // Precondition: the strand sits at/below the cursor, at the SAME second,
      // with the cursor's payload strictly HIGHER than the strand's own — the
      // exact case where a random re-append could sort below the cursor.
      expect(strandSeq <= cursor).toBe(true);
      expect(KSUID.parse(strandSeq).timestamp).toBe(KSUID.parse(cursor).timestamp);
      expect(KSUID.parse(cursor).payload.compare(KSUID.parse(strandSeq).payload)).toBeGreaterThan(0);

      const logPuts = logPutsOf(putCommands);
      expect(logPuts).toHaveLength(1);
      const row = logPuts[0].input.Item as MutationLogRow;
      // Only the +1s successor timestamp carries the re-append above the cursor
      // here — the cursor's payload is higher, so payload alone cannot.
      expect(row.sequenceId > cursor).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does NOT re-append when the minted sequenceId already sits above the cursor', async () => {
    // A cursor an hour in the PAST is below any current KSUID.random(), so the
    // committed row is already pull-visible — no strand, no re-append.
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
    // Nothing has been compacted → no cutoff can strand a row.
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

    // Push still resolves with the applied result despite the re-append throw.
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0].status).toBe('applied');
    // The re-append WAS attempted (and threw) — best-effort, swallowed.
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
    // Distinct dominating ids (each reuses its own row's KSUID payload), all
    // strictly above the cursor — so a second stranded row can't overwrite the
    // first with a colliding zero-payload id.
    expect(new Set(seqs).size).toBe(2);
    for (const seq of seqs) expect(seq > cursor).toBe(true);
  });
});
