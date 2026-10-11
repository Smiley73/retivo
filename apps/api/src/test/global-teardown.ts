/**
 * Jest `globalTeardown` — drops this run's namespaced DynamoDB tables
 * and S3 buckets once, after the whole suite finishes.
 *
 * Runs in the jest-main process, which already ran `jest.config.cjs`
 * (the single env-bootstrap point): the repo-root `.env`, the emulator
 * endpoint/credential defaults, and `JEST_RUN_ID` are all in
 * `process.env` here — no own dotenv, no reliance on `jest.setup.ts`
 * (which only runs inside workers).
 *
 * Every worker created `retirement-test-${JEST_RUN_ID}-${JEST_WORKER_ID}-*`
 * resources, so teardown prefix-matches `retirement-test-${JEST_RUN_ID}-`
 * (trailing hyphen anchored so a run id that is a numeric prefix of a
 * concurrent run's id cannot cross-delete) across *all* worker ids —
 * not the static 15-key `TABLE_ENV_KEYS`. A concurrently-running
 * second jest process owns a different `JEST_RUN_ID` and is untouched;
 * the shared container itself is never touched.
 *
 * A hard-killed run leaks its set (this hook never fires) — that is a
 * permanently accepted constraint: `-inMemory` DynamoDB Local
 * means any `pnpm emu:down`/restart wipes everything, and the next run
 * reusing that jest-main pid drops the matching prefix.
 */
import {
  DynamoDBClient,
  ListTablesCommand,
  DeleteTableCommand,
} from '@aws-sdk/client-dynamodb';
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';
/**
 * Fail loud: jest.config.cjs must have stamped `JEST_RUN_ID` in the
 * jest-main process before the worker pool forked. A missing id means
 * the runner is misconfigured — worker namespacing would silently
 * degrade and this hook could not identify this run's resources (would
 * leak every table). The single shared guard for both this module and
 * `jest.setup.ts` (DRY) — message stays context-neutral so it reads
 * correctly from either call site.
 *
 * Exported so the negative path (unset → throw) is unit-testable
 * without booting a whole jest run.
 *
 * @returns the resolved `JEST_RUN_ID`
 * @throws if `process.env.JEST_RUN_ID` is unset/empty
 */
export function assertRunId(): string {
  const runId = process.env.JEST_RUN_ID;
  if (!runId) {
    throw new Error(
      'JEST_RUN_ID is not set — jest.config.cjs must run (and stamp it) in ' +
        'the jest-main process before workers fork. Run the API suite via ' +
        '`pnpm --filter @retirement/api test`.',
    );
  }
  return runId;
}

export default async function globalTeardown(): Promise<void> {
  const runId = assertRunId();
  const prefix = `retirement-test-${runId}-`;

  const region = process.env.AWS_REGION ?? 'us-east-1';
  const credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  };

  await dropTables(prefix, region, credentials);
  await dropBuckets(prefix, region, credentials);
}

interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
}

async function dropTables(
  prefix: string,
  region: string,
  credentials: Creds,
): Promise<void> {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  // jest.config.cjs unconditionally defaults DYNAMODB_ENDPOINT in this
  // same jest-main process — a missing value means the runner is
  // misconfigured, not a legitimate skip. Refuse to silently no-op
  // (would orphan this run's tables).
  if (!endpoint) {
    throw new Error(
      'DYNAMODB_ENDPOINT is not set in globalTeardown — jest.config.cjs ' +
        'must have provided it. Refusing to silently skip table cleanup.',
    );
  }
  const ddb = new DynamoDBClient({ region, endpoint, credentials });

  let start: string | undefined;
  const owned: string[] = [];
  do {
    const res = await ddb.send(
      new ListTablesCommand({ ExclusiveStartTableName: start }),
    );
    for (const name of res.TableNames ?? []) {
      if (name.startsWith(prefix)) owned.push(name);
    }
    start = res.LastEvaluatedTableName;
  } while (start);

  for (const name of owned) {
    await ddb.send(new DeleteTableCommand({ TableName: name }));
  }
}

async function dropBuckets(
  prefix: string,
  region: string,
  credentials: Creds,
): Promise<void> {
  const endpoint = process.env.S3_ENDPOINT;
  // jest.config.cjs unconditionally defaults S3_ENDPOINT in this same
  // jest-main process — a missing value means the runner is
  // misconfigured, not a legitimate skip. Refuse to silently no-op
  // (would orphan this run's snapshot buckets).
  if (!endpoint) {
    throw new Error(
      'S3_ENDPOINT is not set in globalTeardown — jest.config.cjs must ' +
        'have provided it. Refusing to silently skip bucket cleanup.',
    );
  }
  const s3 = new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials,
  });

  const res = await s3.send(new ListBucketsCommand({}));
  const owned = (res.Buckets ?? [])
    .map((b) => b.Name)
    .filter((n): n is string => !!n && n.startsWith(prefix));

  for (const bucket of owned) {
    await emptyBucket(s3, bucket);
    // Moto rejects DeleteBucket on a non-empty bucket — only after the
    // paginated empty above is the delete safe.
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  }
}

async function emptyBucket(s3: S3Client, bucket: string): Promise<void> {
  let token: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    const objects = (list.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => !!k);
    if (objects.length > 0) {
      // DeleteObjects caps at 1000 keys per call; one ListObjectsV2 page
      // is already ≤ 1000, so a per-page delete stays within the cap.
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects.map((Key) => ({ Key })) },
        }),
      );
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
}
