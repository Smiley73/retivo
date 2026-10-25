// Snapshot janitor retention against the local emulator: the SNAPSHOT_MIN_KEEP (10) newest snapshots per household are kept regardless of age, of the rest only
// objects older than SNAPSHOT_MIN_AGE_DAYS (90) are deleted, and a household under the floor loses nothing.
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { bootstrapTestApp, type TestApp } from './test-helpers.js';
import { S3_CLIENT } from '../aws/aws.module.js';
import { JanitorService } from '../janitor/janitor.service.js';

function snapshotKey(household: string, atMs: number): string {
  // Mirrors the compactor's key shape so the janitor's age parser sees the production format.
  const iso = new Date(atMs).toISOString().replace(/[:.]/g, '-');
  return `${household}/${iso}.json.gz`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse('2026-05-06T12:00:00.000Z');
const RECENT_MS = NOW_MS - 5 * DAY_MS;
const OLD_MS = NOW_MS - 120 * DAY_MS;

async function seedKeys(
  s3: S3Client,
  bucket: string,
  household: string,
  ts: number[],
): Promise<string[]> {
  const keys: string[] = [];
  for (const t of ts) {
    const key = snapshotKey(household, t);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Buffer.from('{}'),
      }),
    );
    keys.push(key);
  }
  return keys;
}

async function listKeysForHousehold(
  s3: S3Client,
  bucket: string,
  household: string,
): Promise<string[]> {
  const out: string[] = [];
  let continuationToken: string | undefined;
  do {
    const r = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${household}/`,
        ContinuationToken: continuationToken,
      }),
    );
    for (const o of r.Contents ?? []) {
      if (o.Key) out.push(o.Key);
    }
    continuationToken = r.NextContinuationToken;
  } while (continuationToken);
  return out;
}

async function purgeBucket(s3: S3Client, bucket: string): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const r = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    );
    const keys = (r.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => Boolean(k));
    if (keys.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
    continuationToken = r.NextContinuationToken;
  } while (continuationToken);
}

describe('snapshot janitor', () => {
  let t: TestApp;
  let s3: S3Client;
  let bucket: string;
  let janitor: JanitorService;

  beforeAll(async () => {
    process.env.SNAPSHOT_MIN_KEEP = '10';
    process.env.SNAPSHOT_MIN_AGE_DAYS = '90';
    t = await bootstrapTestApp();
    s3 = t.module.get<S3Client>(S3_CLIENT);
    bucket = t.module
      .get(ConfigService)
      .get('SNAPSHOTS_BUCKET', { infer: true } as never) as unknown as string;
    janitor = t.module.get(JanitorService);
  });

  afterAll(async () => {
    await purgeBucket(s3, bucket);
    await t.app.close();
  });

  beforeEach(async () => {
    await purgeBucket(s3, bucket);
  });

  it('keeps every snapshot when nothing is past the age cutoff', async () => {
    const household = 'household-recent-only';
    const timestamps = Array.from({ length: 15 }, (_, i) =>
      RECENT_MS - i * 60_000,
    );
    await seedKeys(s3, bucket, household, timestamps);

    const summary = await janitor.runOnce(NOW_MS);

    expect(summary.totalDeleted).toBe(0);
    expect(summary.totalKept).toBeGreaterThanOrEqual(15);
    const remaining = await listKeysForHousehold(s3, bucket, household);
    expect(remaining).toHaveLength(15);
  });

  it('keeps the 10 most-recent snapshots even when every object is ancient', async () => {
    const household = 'household-all-old';
    const timestamps = Array.from({ length: 15 }, (_, i) =>
      OLD_MS - i * 3600_000,
    );
    await seedKeys(s3, bucket, household, timestamps);

    const summary = await janitor.runOnce(NOW_MS);

    expect(summary.totalDeleted).toBeGreaterThanOrEqual(5);
    const remaining = await listKeysForHousehold(s3, bucket, household);
    expect(remaining).toHaveLength(10);
    const expected = timestamps
      .slice(0, 10)
      .map((t) => snapshotKey(household, t))
      .sort();
    expect(remaining.sort()).toEqual(expected);
  });

  it('keeps every snapshot for a household below the floor (5 ancient < 10 minKeep)', async () => {
    const household = 'household-tiny-and-old';
    const timestamps = Array.from({ length: 5 }, (_, i) =>
      OLD_MS - i * 3600_000,
    );
    await seedKeys(s3, bucket, household, timestamps);

    await janitor.runOnce(NOW_MS);

    const remaining = await listKeysForHousehold(s3, bucket, household);
    expect(remaining).toHaveLength(5);
  });

  it('mixes recent + ancient correctly: keep all recent + always-keep the floor', async () => {
    const household = 'household-mixed';
    // 12 recent (<90d) and 8 ancient (>90d) with floor 10: the newest 10 and positions 10-11 are kept, positions 12-19 are deleted.
    const recent = Array.from({ length: 12 }, (_, i) =>
      RECENT_MS - i * 60_000,
    );
    const ancient = Array.from({ length: 8 }, (_, i) => OLD_MS - i * 60_000);
    await seedKeys(s3, bucket, household, [...recent, ...ancient]);

    const summary = await janitor.runOnce(NOW_MS);

    expect(summary.totalDeleted).toBeGreaterThanOrEqual(8);
    const remaining = await listKeysForHousehold(s3, bucket, household);
    expect(remaining).toHaveLength(12);
    for (const key of remaining) {
      expect(recent.map((t) => snapshotKey(household, t))).toContain(key);
    }
  });

  it('runs without error against an empty bucket', async () => {
    const summary = await janitor.runOnce(NOW_MS);
    expect(summary.householdsProcessed).toBe(0);
    expect(summary.totalDeleted).toBe(0);
    expect(summary.totalKept).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps objects with malformed keys instead of silently deleting them', async () => {
    const household = 'household-malformed';
    const ancient = Array.from({ length: 12 }, (_, i) => OLD_MS - i * 60_000);
    await seedKeys(s3, bucket, household, ancient);
    // A leading `0` sorts the undecodable key after every 2025-/2026- key in descending order, past the minKeep floor where the age check runs.
    const malformedKey = `${household}/0broken-timestamp.json.gz`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: malformedKey,
        Body: Buffer.from('{}'),
      }),
    );

    const summary = await janitor.runOnce(NOW_MS);

    expect(summary.unparseableKeys).toBeGreaterThanOrEqual(1);
    const remaining = await listKeysForHousehold(s3, bucket, household);
    expect(remaining).toContain(malformedKey);
  });
});
