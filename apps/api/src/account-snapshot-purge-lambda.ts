// Synchronous snapshot-purge Lambda for account deletion: deletes every S3 object under `${householdId}/` except optional
// `keepKeys`, in its own least-privilege role. See docs/architecture.md, "Background Lambdas".
import 'reflect-metadata';
import type { Context } from 'aws-lambda';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

export interface SnapshotPurgePayload {
  householdId: string;
  /**
   * S3 keys to preserve (a delete-list filter), so the erase-history clear keeps the just-minted live empty snapshot
   * that `WorkspaceMeta` points at; absent or empty deletes every object.
   */
  keepKeys?: string[];
}

export interface SnapshotPurgeResult {
  deleted: number;
}

const DELETE_BATCH_SIZE = 1000; // S3 DeleteObjects hard cap.

// Every outbound call is bounded; sized under the api LambdaClient 25 s invoke budget and the 60 s Lambda timeout, so
// one hung list or delete cannot stall the purge.
const S3_REQUEST_TIMEOUT_MS = 15_000;
const S3_CONNECTION_TIMEOUT_MS = 3_000;

let cachedS3: S3Client | undefined;
let cachedBucket: string | undefined;

function getBucket(): string {
  if (cachedBucket) return cachedBucket;
  const bucket = process.env.SNAPSHOTS_BUCKET;
  if (!bucket) {
    throw new Error('Missing required env var: SNAPSHOTS_BUCKET');
  }
  cachedBucket = bucket;
  return cachedBucket;
}

function getS3(): S3Client {
  if (cachedS3) return cachedS3;
  cachedS3 = new S3Client({
    region: process.env.AWS_REGION ?? 'us-east-1',
    requestHandler: {
      requestTimeout: S3_REQUEST_TIMEOUT_MS,
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
    },
  });
  return cachedS3;
}

// A household id is a server-minted UUID; reject anything empty or containing `/` so a malformed payload cannot widen
// the delete beyond one household prefix.
function validateHouseholdId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('/')) {
    throw new Error('Invalid payload: householdId must be a non-empty string without "/"');
  }
  return value;
}

// A malformed keep list degrades to keeping nothing: it is a filter, so a bogus entry can only fail to match, never
// widen the delete beyond the prefix.
function normalizeKeepKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((k): k is string => typeof k === 'string');
}

async function purgeHouseholdSnapshots(
  householdId: string,
  keepKeys: string[],
): Promise<number> {
  const s3 = getS3();
  const bucket = getBucket();
  const prefix = `${householdId}/`;
  const keep = new Set(keepKeys);
  let continuationToken: string | undefined;
  let deleted = 0;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const keys = (list.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => typeof k === 'string')
      // Never delete a preserved object.
      .filter((k) => !keep.has(k));
    for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
      const slice = keys.slice(i, i + DELETE_BATCH_SIZE);
      const out = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: slice.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      // DeleteObjects returns 200 with per-object Errors on partial failure; treating that as success would orphan
      // snapshots while account deletion proceeds. Throw so the Lambda sets FunctionError and the caller aborts
      // before any sweep. No object keys in the error.
      if (out.Errors && out.Errors.length > 0) {
        throw new Error(
          `Snapshot purge failed to delete ${out.Errors.length} object(s)`,
        );
      }
      deleted += slice.length;
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
  return deleted;
}

export const handler = async (
  event: SnapshotPurgePayload,
  _context: Context,
): Promise<SnapshotPurgeResult> => {
  const householdId = validateHouseholdId(event?.householdId);
  const keepKeys = normalizeKeepKeys(event?.keepKeys);
  const deleted = await purgeHouseholdSnapshots(householdId, keepKeys);
  // Count only: never log the household id or an object key.
  console.log(
    JSON.stringify({
      'metric.kind': 'account_snapshot_purge',
      deleted,
      msg: 'Account snapshot purge complete',
    }),
  );
  return { deleted };
};
