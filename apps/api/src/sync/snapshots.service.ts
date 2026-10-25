// S3 snapshot object access for the sync module: list a household's snapshots and fetch one.
// Every key is built from the JWT household prefix, so a foreign snapshotId misses instead of reading another household.
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

/** One synced aggregate row frozen into a snapshot; narrows the contract's opaque `payload` for the parse and restore code. */
export interface SnapshotAggregate extends SyncSnapshotAggregate {
  payload: Record<string, unknown>;
}

/** Decoded body of a snapshot object. `cutoff` is the MutationLog sequenceId it was compacted up to; older snapshots lack it. */
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

  /** The S3 key for a household's snapshot; the one place the format lives, so the erase-history keep-key cannot drift from `write`. */
  keyFor(householdId: string, snapshotId: string): string {
    return `${householdId}/${snapshotId}${SUFFIX}`;
  }

  /** Lists the household's snapshots newest-first, capped at MAX_LIST, timestamped by S3 `LastModified`. */
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

    items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return items.slice(0, MAX_LIST);
  }

  /**
   * Fetches a snapshot, or `null` only when the object does not exist (bootstrap falls back to an empty snapshot).
   * Any other failure is logged and rethrown so a corrupt snapshot cannot masquerade as a missing one.
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
      // A parseable body of the wrong shape would coerce to an empty snapshot, and restore, which fetches before the sweep,
      // would wipe the workspace and reseed nothing. Throw before any sweep instead.
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
      // Only NoSuchKey is soft: other 404-shaped infra faults such as NoSuchBucket would otherwise hide behind an empty bootstrap.
      const name = (err as { name?: string })?.name;
      if (name === 'NoSuchKey') {
        return null;
      }
      this.logger.error(
        `Failed to read snapshot ${householdId}/${snapshotId}${SUFFIX}: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      throw err;
    }
  }

  /** Fetches a snapshot, throwing 404 SNAPSHOT_NOT_FOUND when absent, so restore never silently restores an empty workspace. */
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
   * Writes a fresh snapshot at the current timestamp and returns its `snapshotId`. Key and gzipped body match the
   * compactor's format exactly, and `cutoff` carries over, so the janitor and listing read it identically.
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
