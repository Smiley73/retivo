/**
 * Owns all S3 snapshot object access for the sync module: listing a
 * household's available snapshots and fetching a specific snapshot's
 * contents. Both `BootstrapService` and `RestoreService` inject this so
 * the S3 read logic lives in exactly one place.
 *
 * Household isolation: every operation keys S3 by the `${householdId}/`
 * prefix derived from the authenticated JWT claim. `list` always passes
 * `Prefix: ${householdId}/` to `ListObjectsV2` (the api role holds a
 * bucket-level `s3:ListBucket` grant, with this code-layer
 * prefix guard as the enforcement boundary). `fetch`/`fetchStrict` build
 * the object key from the same prefix, so a foreign `snapshotId` simply
 * misses (soft null / 404) rather than reading another household.
 */
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3_CLIENT } from '../aws/aws.module.js';
import type { EnvConfig } from '../common/env.config.js';
import type {
  SnapshotAggregate as SyncSnapshotAggregate,
  SnapshotListItem,
} from '@retirement/contracts';

/**
 * One synced aggregate row as frozen into an S3 snapshot. Extends the shared
 * wire contract's `SnapshotAggregate` (single source of truth) and only narrows
 * the opaque `payload` to a concrete object for the S3 parse / restore code
 * here, so a contract field change flows in and is caught at compile time.
 */
export interface SnapshotAggregate extends SyncSnapshotAggregate {
  payload: Record<string, unknown>;
}

/** Decoded body of a snapshot object. `cutoff` is the MutationLog
 *  sequenceId the snapshot was compacted up to (used by RestoreService
 *  to reset the workspace cursor). Older snapshots may lack it. */
export interface SnapshotContent {
  aggregates: SnapshotAggregate[];
  cutoff: string | null;
}

const SUFFIX = '.json.gz';
const MAX_LIST = 50;

@Injectable()
export class SnapshotsService {
  private readonly logger = new Logger(SnapshotsService.name);
  private readonly snapshotsBucket: string;

  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.snapshotsBucket = config.get('SNAPSHOTS_BUCKET', { infer: true });
  }

  /**
   * The S3 object key for a household's snapshot — the SINGLE source of the
   * `${householdId}/${snapshotId}${SUFFIX}` format. `fetch`/`write` build their
   * keys through this, and `RestoreService` builds its erase-history keep-key
   * through it too, so a future format change stays in one place: it can never
   * silently make the keep-key stop matching the live snapshot (which would
   * purge the very object `WorkspaceMeta` points at). The suffix is not
   * user-controlled, so the key is safe by construction.
   */
  keyFor(householdId: string, snapshotId: string): string {
    return `${householdId}/${snapshotId}${SUFFIX}`;
  }

  /**
   * List the household's available snapshots, newest-first, capped at
   * {@link MAX_LIST}. The display timestamp is the S3 object's
   * `LastModified` (always a valid Date), never the `:`/`.`-mangled key
   * name. `snapshotId` is the key basename without the `.json.gz`
   * suffix.
   */
  async list(householdId: string): Promise<SnapshotListItem[]> {
    const prefix = `${householdId}/`;
    const items: SnapshotListItem[] = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.snapshotsBucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of r.Contents ?? []) {
        if (!obj.Key || !obj.Key.endsWith(SUFFIX)) continue;
        const snapshotId = obj.Key.slice(prefix.length, -SUFFIX.length);
        if (!snapshotId) continue;
        items.push({
          snapshotId,
          timestamp: (obj.LastModified ?? new Date(0)).toISOString(),
        });
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);

    // Newest-first by S3 LastModified, then cap.
    items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return items.slice(0, MAX_LIST);
  }

  /**
   * Fetch a snapshot's contents. Returns `null` ONLY when the object
   * genuinely does not exist (soft — used by bootstrap, which falls back
   * to an empty snapshot for households the compactor has not run for
   * yet; `fetchStrict` maps the same `null` to 404 SNAPSHOT_NOT_FOUND).
   *
   * Any OTHER failure (S3 5xx, unreadable body, gunzip failure, JSON
   * parse) is logged and rethrown so the global exception filter surfaces
   * a real 5xx/503 instead of a misleading 404 — a swallowed corrupt
   * snapshot would otherwise masquerade as a missing one on both the
   * restore and bootstrap paths.
   *
   * Shape validation: a snapshot can be valid gzip + valid JSON yet
   * malformed in SHAPE (e.g. `{}` with no `aggregates`, or `aggregates`
   * not an array). Returning such a body would silently coerce to an
   * EMPTY snapshot — and because `RestoreService` fetches BEFORE it
   * sweeps the household, an empty-coerced malformed snapshot would wipe
   * the workspace and reseed nothing (silent data loss reported as
   * success). So after JSON.parse we require `aggregates` to be an array
   * and `cutoff` to be `string | null | undefined`; a malformed shape is
   * logged and thrown (same rethrow path as gunzip/parse failures →
   * non-404 5xx via the global filter, BEFORE any sweep). A
   * legitimately-empty workspace (`aggregates: []` + `cutoff: null`) is
   * NOT malformed and passes unchanged — the compactor always writes an
   * `aggregates` array even when empty.
   */
  async fetch(
    householdId: string,
    snapshotId: string | null,
  ): Promise<SnapshotContent | null> {
    if (!snapshotId) return null;
    try {
      const r = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.snapshotsBucket,
          Key: this.keyFor(householdId, snapshotId),
        }),
      );
      const bytes = await streamToBuffer(r.Body);
      const json = gunzipSync(bytes).toString('utf8');
      const parsed = JSON.parse(json) as {
        aggregates?: SnapshotAggregate[];
        cutoff?: string | null;
      };
      // Validate the decoded SHAPE before returning. A malformed-but-
      // parseable body (missing/non-array `aggregates`, or a `cutoff`
      // that is neither a string nor null/undefined) must NOT coerce to
      // an empty snapshot — that would let `RestoreService` sweep the
      // household and reseed nothing. Throw so it surfaces as a non-404
      // 5xx, BEFORE the destructive sweep (see the method doc).
      if (
        !Array.isArray(parsed.aggregates) ||
        !(
          parsed.cutoff === undefined ||
          parsed.cutoff === null ||
          typeof parsed.cutoff === 'string'
        )
      ) {
        throw new Error('Malformed snapshot shape');
      }
      return {
        aggregates: parsed.aggregates,
        cutoff: parsed.cutoff ?? null,
      };
    } catch (err) {
      // A genuine "this object key does not exist" is the only soft case
      // → null. On the `GetObjectCommand` path the AWS SDK v3 surfaces
      // that as the dedicated `NoSuchKey` error. We deliberately do NOT
      // treat a bare HTTP 404 in `$metadata` as the soft case: other
      // 404-shaped infra failures (e.g. `NoSuchBucket` — a misconfigured
      // / deleted bucket) also carry httpStatusCode 404, and swallowing
      // those to null would hide a real infra fault behind an empty
      // bootstrap / a misleading SNAPSHOT_NOT_FOUND. Only the
      // object-miss name is soft; everything else falls through to the
      // log+rethrow path below.
      const name = (err as { name?: string })?.name;
      if (name === 'NoSuchKey') {
        return null;
      }
      // S3 5xx, NoSuchBucket / other infra 404s, unreadable body,
      // gunzip, or JSON parse failure → real error. Log + rethrow so the
      // exception filter returns 5xx/503 rather than a misleading
      // SNAPSHOT_NOT_FOUND.
      this.logger.error(
        `Failed to read snapshot ${householdId}/${snapshotId}${SUFFIX}: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      throw err;
    }
  }

  /**
   * Fetch a snapshot's contents, throwing `404 SNAPSHOT_NOT_FOUND` when
   * the object is absent. Used by the restore flow, where a missing /
   * cross-household `snapshotId` must surface as a hard error rather
   * than silently restoring an empty workspace.
   */
  async fetchStrict(
    householdId: string,
    snapshotId: string,
  ): Promise<SnapshotContent> {
    const content = await this.fetch(householdId, snapshotId);
    if (!content) {
      throw new NotFoundException({
        code: 'SNAPSHOT_NOT_FOUND',
        message: 'No snapshot exists for the requested snapshotId.',
      });
    }
    return content;
  }

  /**
   * Write a fresh snapshot object for the household and return its
   * `snapshotId` (the key basename without the `.json.gz` suffix). Used
   * by `RestoreService` to mint a NEW snapshot at the current timestamp
   * from a restored snapshot's contents — never repointing
   * `WorkspaceMeta` at the (possibly old, janitor-deletable) chosen key.
   *
   * The key + gzipped JSON body match the compactor's format EXACTLY so
   * the janitor's `parseTimestampFromKey`, the `GET /sync/snapshots`
   * listing, and a future bootstrap/compaction read it identically:
   *   - key:  `${householdId}/${isoNow.replace(/[:.]/g, '-')}.json.gz`
   *   - body: `{ householdId, generatedAt, cutoff, aggregates }` gzipped,
   *           `ContentType: application/json`, `ContentEncoding: gzip`.
   *
   * `cutoff` is carried over from the restored content so the restored
   * snapshot's compaction watermark is preserved (the compactor stays a
   * no-op post-restore; see RestoreService).
   */
  async write(
    householdId: string,
    content: SnapshotContent,
  ): Promise<string> {
    const snapshotId = new Date().toISOString().replace(/[:.]/g, '-');
    const body = JSON.stringify({
      householdId,
      generatedAt: new Date().toISOString(),
      cutoff: content.cutoff,
      aggregates: content.aggregates,
    });
    const gzipped = gzipSync(Buffer.from(body, 'utf8'));
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.snapshotsBucket,
        Key: this.keyFor(householdId, snapshotId),
        Body: gzipped,
        ContentType: 'application/json',
        ContentEncoding: 'gzip',
      }),
    );
    return snapshotId;
  }
}

async function streamToBuffer(stream: unknown): Promise<Buffer> {
  if (
    !stream ||
    typeof (stream as { transformToByteArray?: unknown })
      .transformToByteArray !== 'function'
  ) {
    throw new Error('Unexpected S3 body shape');
  }
  const arr = await (
    stream as { transformToByteArray: () => Promise<Uint8Array> }
  ).transformToByteArray();
  return Buffer.from(arr);
}
