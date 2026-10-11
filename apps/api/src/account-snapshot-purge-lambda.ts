/**
 * Synchronous snapshot-purge Lambda for account deletion.
 *
 * Invoked (RequestResponse) by DeleteAccountService during the
 * `DELETE /auth/account` cascade. Deletes every S3 object under the
 * `${householdId}/` prefix in the snapshots bucket, then returns the
 * deleted-object count. Isolating this in its own least-privilege role
 * (ListBucket + DeleteObject on the snapshots bucket only — mirrors the
 * janitor role) lets the api role drop bucket-wide delete entirely.
 *
 * Standalone — no Nest bootstrap. The purge is a thin S3 loop; the extra
 * modules aren't worth the cold-start cost. The payload carries ONLY the
 * household id (+ an optional keep-key list) — no email, token, password,
 * or other PII — and the handler never logs object keys.
 *
 * Optional keep-key mode: the
 * erase-history workspace clear passes `keepKeys` so the just-minted live
 * empty snapshot is EXCLUDED from the delete (otherwise the purge would
 * delete the object `WorkspaceMeta` was just repointed at). Absent/empty →
 * delete every `${householdId}/` object (account-deletion / encrypted-reset
 * behaviour, unchanged). IAM is unchanged — the keep-key is a delete-list
 * filter only.
 *
 * See docs/architecture.md, "Background Lambdas".
 */
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
   * S3 object keys to PRESERVE (delete-list filter). Used by the
   * workspace/clear erase-history path to keep
   * the just-minted live empty snapshot while purging all prior history.
   * Absent/empty → delete every `${householdId}/` object (unchanged).
   */
  keepKeys?: string[];
}

export interface SnapshotPurgeResult {
  deleted: number;
}

const DELETE_BATCH_SIZE = 1000; // S3 DeleteObjects hard cap.

// Explicit per-call S3 timeouts (repo non-negotiable: every outbound
// call is bounded). Sized well under the api
// LambdaClient's 25s synchronous-invoke budget and the 60s Lambda
// timeout, leaving headroom for the paged list+delete loop while
// keeping a single hung list/delete from stalling the whole purge.
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

/**
 * A household id is a UUID minted server-side. Reject anything that
 * isn't a non-empty string free of `/` so a malformed payload can never
 * widen the delete beyond a single household prefix.
 */
function validateHouseholdId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('/')) {
    throw new Error('Invalid payload: householdId must be a non-empty string without "/"');
  }
  return value;
}

/**
 * Normalize the optional keep-key list to an array of strings. A malformed
 * payload silently degrades to "keep nothing" (delete everything) — the
 * keep-key is a delete-list FILTER, so a bogus entry can only fail to match
 * and never widens the delete beyond the household prefix.
 */
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
      // Keep-key mode: never delete a preserved object (the live empty
      // snapshot the workspace clear just repointed to).
      .filter((k) => !keep.has(k));
    for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
      const slice = keys.slice(i, i + DELETE_BATCH_SIZE);
      const out = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: slice.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      // DeleteObjects returns HTTP 200 with a per-object Errors[] on
      // partial failure — treating that as success would leave orphaned
      // snapshots while account deletion proceeds. Fail loud instead.
      // Throwing here makes the Lambda set FunctionError so the caller
      // (DeleteAccountService) aborts before any DynamoDB / auth sweep.
      // Never include object keys in the error (no PII / no key leakage).
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
  // Count only — never log the household id or any object key.
  console.log(
    JSON.stringify({
      'metric.kind': 'account_snapshot_purge',
      deleted,
      msg: 'Account snapshot purge complete',
    }),
  );
  return { deleted };
};
