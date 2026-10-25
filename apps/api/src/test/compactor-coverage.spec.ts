// The compactor's verify-then-delete sweep driven directly with stubbed DynamoDB and S3 clients: delete a covered row, keep an uncovered strand, emit CompactorCoverageViolation.
import {
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import KSUID from 'ksuid';
import { CompactorService } from '../compactor/compactor.service.js';

const MUTATION_LOG_TABLE = 'TABLE_MUTATION_LOG';

function settledSeq(minutesAgo: number): string {
  return KSUID.fromParts(Date.now() - minutesAgo * 60_000, Buffer.alloc(16)).string;
}

interface SnapshotAggregate {
  id: string;
  householdId: string;
  schemaVersion: number;
  version: number;
  updatedAt: string;
  deviceId: string;
  aggregateType: string;
  payload: Record<string, unknown>;
}

interface Harness {
  service: CompactorService;
  deletedSeqs: string[];
  stdoutLines: string[];
  restore: () => void;
}

function buildHarness(opts: {
  cursor: string | null;
  baseline: SnapshotAggregate[];
  recent: Array<{ sequenceId: string; aggregateId: string; version: number; operation: 'create' | 'update' | 'delete' }>;
  sweep: Array<{ sequenceId: string; aggregateId: string; version: number }>;
  stack?: string;
}): Harness {
  const deletedSeqs: string[] = [];
  const doc = {
    send: jest.fn(async (command: unknown) => {
      if (command instanceof GetCommand) {
        return {
          Item: {
            householdId: 'hh-1',
            latestSnapshotId: 'snap-1',
            latestSnapshotCursor: opts.cursor,
            latestVersion: 1,
            lastUpdatedAt: new Date().toISOString(),
            mutationLogCursorBase: opts.cursor,
          },
        };
      }
      if (command instanceof QueryCommand) {
        const kce =
          (command.input as { KeyConditionExpression?: string }).KeyConditionExpression ?? '';
        if (kce.includes('> :s')) {
          return {
            Items: opts.recent.map((r) => ({
              householdId: 'hh-1',
              sequenceId: r.sequenceId,
              deviceId: 'dev-1',
              aggregateId: r.aggregateId,
              aggregateType: 'account',
              operation: r.operation,
              payload: JSON.stringify({ v: r.version }),
              version: r.version,
              timestamp: Date.now(),
              schemaVersion: 1,
            })),
          };
        }
        if (kce.includes('<= :c')) return { Items: opts.sweep };
        return { Items: [] };
      }
      if (command instanceof UpdateCommand) return {};
      if (command instanceof BatchWriteCommand) {
        const reqs =
          (command.input as {
            RequestItems: Record<string, Array<{ DeleteRequest?: { Key: { sequenceId: string } } }>>;
          }).RequestItems[MUTATION_LOG_TABLE] ?? [];
        for (const r of reqs) {
          if (r.DeleteRequest) deletedSeqs.push(r.DeleteRequest.Key.sequenceId);
        }
        return {};
      }
      return {};
    }),
  } as unknown as DynamoDBDocumentClient;

  const s3 = {
    send: jest.fn(async (command: unknown) => {
      if (command instanceof GetObjectCommand) {
        const body = gzipSync(Buffer.from(JSON.stringify({ aggregates: opts.baseline })));
        return { Body: { transformToByteArray: async () => body } };
      }
      if (command instanceof PutObjectCommand) return {};
      return {};
    }),
  } as unknown as S3Client;

  // STACK returns the requested stack (drives the per-stack EMF namespace); every other key echoes its own name, as the table-name reads rely on.
  const stack = opts.stack ?? 'test';
  const config = {
    get: (k: string) => (k === 'STACK' ? stack : k),
  } as unknown as never;
  const service = new CompactorService(doc, s3, config);

  // The EMF emitter writes with `fs.writeSync` (Lambda-freeze-safe), not `process.stdout.write`, so capture fd 1 at that layer and pass other fds through.
  const stdoutLines: string[] = [];
  const realWriteSync = fs.writeSync.bind(fs);
  const stdoutSpy = jest.spyOn(fs, 'writeSync').mockImplementation(((
    fd: number,
    data: unknown,
    ...rest: unknown[]
  ): number => {
    if (fd === 1) {
      const raw = String(data);
      stdoutLines.push(raw);
      return Buffer.byteLength(raw);
    }
    return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
  }) as unknown as typeof fs.writeSync);

  return { service, deletedSeqs, stdoutLines, restore: () => stdoutSpy.mockRestore() };
}

function baseAggregate(id: string, version: number): SnapshotAggregate {
  return {
    id,
    householdId: 'hh-1',
    schemaVersion: 1,
    version,
    updatedAt: new Date().toISOString(),
    deviceId: 'dev-1',
    aggregateType: 'account',
    payload: { v: version },
  };
}

function coverageNamespace(lines: string[]): string | undefined {
  const emf = coverageEmf(lines);
  if (!emf) return undefined;
  const aws = emf._aws as {
    CloudWatchMetrics: Array<{ Namespace: string }>;
  };
  return aws.CloudWatchMetrics[0].Namespace;
}

function coverageEmf(lines: string[]): Record<string, unknown> | undefined {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .find(
      (parsed): parsed is Record<string, unknown> =>
        parsed !== null &&
        typeof parsed === 'object' &&
        '_aws' in parsed &&
        'CompactorCoverageViolation' in parsed,
    );
}

describe('CompactorService — coverage sweep', () => {
  it('deletes a COVERED row and KEEPS an uncovered strand, emitting CompactorCoverageViolation', async () => {
    const cursor = settledSeq(30);
    const seqCovered = settledSeq(20); // recent update of A → covered by snapshot
    const seqStrand = settledSeq(40); // below cursor, aggregate B never snapshotted
    const h = buildHarness({
      cursor,
      baseline: [baseAggregate('A', 1)],
      recent: [{ sequenceId: seqCovered, aggregateId: 'A', version: 2, operation: 'update' }],
      sweep: [
        { sequenceId: seqCovered, aggregateId: 'A', version: 2 },
        { sequenceId: seqStrand, aggregateId: 'B', version: 1 },
      ],
    });

    try {
      const metric = await h.service.compactHousehold('hh-1');
      expect(metric).not.toBeNull();
    } finally {
      h.restore();
    }

    expect(h.deletedSeqs).toContain(seqCovered);
    expect(h.deletedSeqs).not.toContain(seqStrand);

    // The EMF line uses the per-stack namespace Retivo/test/Compactor, the count of uncovered rows kept as its value, and no householdId dimension.
    const emf = coverageEmf(h.stdoutLines);
    expect(emf).toBeTruthy();
    const aws = emf!._aws as {
      CloudWatchMetrics: Array<{ Namespace: string; Dimensions: string[][]; Metrics: Array<{ Name: string }> }>;
    };
    expect(aws.CloudWatchMetrics[0].Namespace).toBe('Retivo/test/Compactor');
    expect(aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
    expect(aws.CloudWatchMetrics[0].Metrics).toEqual(
      expect.arrayContaining([expect.objectContaining({ Name: 'CompactorCoverageViolation' })]),
    );
    expect(emf!.CompactorCoverageViolation).toBe(1);
    expect(JSON.stringify(emf)).not.toContain('hh-1');
  });

  it('KEEPS a stray whose aggregate IS in the snapshot but at a LOWER version than the swept row (counter v13 vs snapshot v10), emitting CompactorCoverageViolation', async () => {
    // The incident shape: the AggregateVersion counter reached v13 but the durable snapshot only covers v10. Key presence in the snapshot map is not
    // coverage; the snapshot version must be >= the row's version. A different aggregate's create drives the run, leaving A at its baseline v10.
    const cursor = settledSeq(30);
    const seqCovered = settledSeq(20); // recent create of C → covered
    const seqStrand = settledSeq(40); // below cursor, A committed at v13, snapshot only holds v10
    const h = buildHarness({
      cursor,
      baseline: [baseAggregate('A', 10)],
      recent: [{ sequenceId: seqCovered, aggregateId: 'C', version: 1, operation: 'create' }],
      sweep: [
        { sequenceId: seqCovered, aggregateId: 'C', version: 1 },
        { sequenceId: seqStrand, aggregateId: 'A', version: 13 },
      ],
    });

    try {
      const metric = await h.service.compactHousehold('hh-1');
      expect(metric).not.toBeNull();
    } finally {
      h.restore();
    }

    // A key-presence-only check would wrongly delete A@13 (the snapshot holds A only at v10); the `snapshotVersion >= row.version` guard keeps it.
    expect(h.deletedSeqs).toContain(seqCovered);
    expect(h.deletedSeqs).not.toContain(seqStrand);

    const emf = coverageEmf(h.stdoutLines);
    expect(emf).toBeTruthy();
    expect(emf!.CompactorCoverageViolation).toBe(1);
  });

  it('a fully-covered (healthy) run deletes every swept row and emits NO CompactorCoverageViolation', async () => {
    const cursor = settledSeq(30);
    const seqA = settledSeq(20);
    const seqB = settledSeq(18);
    const h = buildHarness({
      cursor,
      baseline: [],
      recent: [
        { sequenceId: seqA, aggregateId: 'A', version: 1, operation: 'create' },
        { sequenceId: seqB, aggregateId: 'B', version: 1, operation: 'create' },
      ],
      sweep: [
        { sequenceId: seqA, aggregateId: 'A', version: 1 },
        { sequenceId: seqB, aggregateId: 'B', version: 1 },
      ],
    });

    try {
      const metric = await h.service.compactHousehold('hh-1');
      expect(metric).not.toBeNull();
    } finally {
      h.restore();
    }

    expect(h.deletedSeqs).toEqual(expect.arrayContaining([seqA, seqB]));
    expect(h.deletedSeqs).toHaveLength(2);
    expect(coverageEmf(h.stdoutLines)).toBeUndefined();
  });

  it('emits CompactorCoverageViolation into a per-stack namespace so dev and prod are isolated', async () => {
    // A dev and a prod emission must land in distinct namespaces, so a dev coverage violation can never trip the prod alarm.
    const scenario = () => ({
      cursor: settledSeq(30),
      baseline: [baseAggregate('A', 1)],
      recent: [
        { sequenceId: settledSeq(20), aggregateId: 'A', version: 2, operation: 'update' as const },
      ],
      sweep: [
        { sequenceId: settledSeq(20), aggregateId: 'A', version: 2 },
        { sequenceId: settledSeq(40), aggregateId: 'B', version: 1 }, // uncovered strand
      ],
    });

    const dev = buildHarness({ ...scenario(), stack: 'dev' });
    let devNs: string | undefined;
    try {
      await dev.service.compactHousehold('hh-1');
      devNs = coverageNamespace(dev.stdoutLines);
    } finally {
      dev.restore();
    }

    const prod = buildHarness({ ...scenario(), stack: 'prod' });
    let prodNs: string | undefined;
    try {
      await prod.service.compactHousehold('hh-1');
      prodNs = coverageNamespace(prod.stdoutLines);
    } finally {
      prod.restore();
    }

    expect(devNs).toBe('Retivo/dev/Compactor');
    expect(prodNs).toBe('Retivo/prod/Compactor');
    expect(devNs).not.toBe(prodNs);
  });

  it('is a no-op on an empty range (nothing to compact)', async () => {
    const h = buildHarness({
      cursor: settledSeq(30),
      baseline: [baseAggregate('A', 1)],
      recent: [], // queryAllSince returns nothing → compactHousehold short-circuits
      sweep: [],
    });

    try {
      const metric = await h.service.compactHousehold('hh-1');
      expect(metric).toBeNull();
    } finally {
      h.restore();
    }

    expect(h.deletedSeqs).toHaveLength(0);
    expect(coverageEmf(h.stdoutLines)).toBeUndefined();
  });
});
