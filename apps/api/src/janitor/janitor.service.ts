/**
 * Daily snapshot janitor. Replaces the 90-day blanket S3 lifecycle
 * rule that used to live on the snapshots bucket.
 *
 * Per household:
 *   1. Always keep the N most recent snapshots (`SNAPSHOT_MIN_KEEP`,
 *      default 10), regardless of age. Inactive users with sparse
 *      history don't lose data.
 *   2. Of the remainder, delete anything older than
 *      `SNAPSHOT_MIN_AGE_DAYS` (default 90) days.
 *
 * The age check parses the ISO-with-dashes timestamp embedded in the
 * key (the compactor writes `<householdId>/<isoTimestamp>.json.gz` —
 * see CompactorService). LastModified is a fallback for any legacy
 * objects whose key shape we can't parse, so a malformed key is
 * always *kept*, never silently deleted.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object as S3Object,
} from '@aws-sdk/client-s3';
import { S3_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';

export interface JanitorRunSummary {
  householdsProcessed: number;
  totalKept: number;
  totalDeleted: number;
  unparseableKeys: number;
  durationMs: number;
}

const DELETE_BATCH_SIZE = 1000; // S3 DeleteObjects hard cap.

@Injectable()
export class JanitorService {
  private readonly logger = new Logger(JanitorService.name);
  private readonly snapshotsBucket: string;
  private readonly minKeep: number;
  private readonly minAgeDays: number;

  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.snapshotsBucket = config.get('SNAPSHOTS_BUCKET', { infer: true });
    // SNAPSHOT_MIN_KEEP / SNAPSHOT_MIN_AGE_DAYS are janitor-specific
    // knobs not in the global EnvConfig schema. Read them straight
    // from process.env so the same code path works whether the
    // service is bootstrapped via AppModule (typed config, no extra
    // keys loaded) or via JanitorLambdaModule (custom loader).
    this.minKeep = parseIntOrDefault(process.env.SNAPSHOT_MIN_KEEP, 10);
    this.minAgeDays = parseIntOrDefault(process.env.SNAPSHOT_MIN_AGE_DAYS, 90);
  }

  async runOnce(now = Date.now()): Promise<JanitorRunSummary> {
    const start = Date.now();
    const cutoffMs = now - this.minAgeDays * 24 * 60 * 60 * 1000;

    const grouped = await this.listAndGroupByHousehold();
    const summary: JanitorRunSummary = {
      householdsProcessed: 0,
      totalKept: 0,
      totalDeleted: 0,
      unparseableKeys: 0,
      durationMs: 0,
    };

    for (const [householdId, objects] of grouped) {
      // Sort newest-first by key (ISO timestamp embedded in the key
      // sorts lexicographically). Falls back to LastModified for any
      // object whose key has a non-conformant suffix.
      objects.sort((a, b) => compareNewestFirst(a, b));

      const toDelete: string[] = [];
      let kept = 0;
      for (let i = 0; i < objects.length; i++) {
        const obj = objects[i];
        if (i < this.minKeep) {
          kept += 1;
          continue;
        }
        const fromKey = parseTimestampFromKey(obj.Key);
        if (fromKey === null) summary.unparseableKeys += 1;
        const lastModifiedMs = fromKey ?? obj.LastModified?.getTime() ?? null;
        if (lastModifiedMs === null) {
          // Neither key parsed nor LastModified available — keep it.
          kept += 1;
          continue;
        }
        if (lastModifiedMs < cutoffMs && obj.Key) {
          toDelete.push(obj.Key);
        } else {
          kept += 1;
        }
      }

      if (toDelete.length > 0) {
        await this.deleteObjects(toDelete);
      }

      this.logger.log({
        'metric.kind': 'janitor_household',
        householdId,
        snapshotsKept: kept,
        snapshotsDeleted: toDelete.length,
        msg: 'Janitor household',
      });

      summary.householdsProcessed += 1;
      summary.totalKept += kept;
      summary.totalDeleted += toDelete.length;
    }

    summary.durationMs = Date.now() - start;
    this.logger.log({
      'metric.kind': 'janitor_run',
      ...summary,
      minKeep: this.minKeep,
      minAgeDays: this.minAgeDays,
      msg: 'Janitor run',
    });
    return summary;
  }

  private async listAndGroupByHousehold(): Promise<Map<string, S3Object[]>> {
    const out = new Map<string, S3Object[]>();
    let continuationToken: string | undefined;
    do {
      const r = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.snapshotsBucket,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of r.Contents ?? []) {
        if (!obj.Key) continue;
        const slash = obj.Key.indexOf('/');
        // Skip non-prefixed objects (e.g. accidental top-level files);
        // we only manage `<householdId>/...` snapshots.
        if (slash <= 0) continue;
        const householdId = obj.Key.slice(0, slash);
        const list = out.get(householdId) ?? [];
        list.push(obj);
        out.set(householdId, list);
      }
      continuationToken = r.NextContinuationToken;
    } while (continuationToken);
    return out;
  }

  private async deleteObjects(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
      const slice = keys.slice(i, i + DELETE_BATCH_SIZE);
      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.snapshotsBucket,
          Delete: {
            Objects: slice.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
    }
  }
}

function parseIntOrDefault(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

function compareNewestFirst(a: S3Object, b: S3Object): number {
  // Sort by key descending — works because the compactor writes keys
  // shaped `<household>/<sortable-iso-timestamp>.json.gz`.
  const ak = a.Key ?? '';
  const bk = b.Key ?? '';
  if (ak !== bk) return ak < bk ? 1 : -1;
  return 0;
}

function parseTimestampFromKey(key: string | undefined): number | null {
  if (!key) return null;
  const slash = key.indexOf('/');
  if (slash < 0) return null;
  const filename = key.slice(slash + 1);
  if (!filename.endsWith('.json.gz')) return null;
  const stem = filename.slice(0, -'.json.gz'.length);
  // Compactor mints keys via:
  //   new Date().toISOString().replace(/[:.]/g, '-')
  // → YYYY-MM-DDTHH-MM-SS-sssZ. Reverse the replacement carefully so
  // a malformed key returns null instead of NaN.
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stem);
  if (!m) return null;
  const [, date, h, mi, s, ms] = m;
  const t = Date.parse(`${date}T${h}:${mi}:${s}.${ms}Z`);
  return Number.isNaN(t) ? null : t;
}
