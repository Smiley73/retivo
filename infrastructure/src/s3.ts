// Workspace snapshots bucket. Block-public-access, SSE-S3.
//
// Retention is enforced by the daily janitor Lambda
// (`apps/api/src/janitor-lambda.ts`), NOT by an S3 lifecycle rule.
// The previous blanket 90-day expiration silently deleted the only
// surviving snapshot for users inactive past the cutoff, with no
// mutation-log rows left to replay. The lifecycle config now only handles
// abortIncompleteMultipartUpload (cleans up partial writes from
// crashed Lambdas).
//
// @pulumi/aws v7 deprecated the `*V2` resource names in favor of the
// canonical ones (the V2 family was a v6-era transition aid). Use the
// canonical names + `aliases` so any state already created against the
// V2 type migrates cleanly without destroy/recreate.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

interface SnapshotsBucketOpts {
  readonly namePrefix: string;
  /**
   * Enable S3 versioning + a noncurrent-version expiration lifecycle rule on
   * the snapshots bucket. Gated on `retivo:enableBackups`
   * (prod-only). AWS Backup for S3 only protects VERSIONED buckets, so this is
   * a hard prerequisite of the vault selection; versioning also independently
   * closes the api-role-overwrite gap on the live prod bucket. With versioning
   * on, the janitor's DeleteObject only writes a delete marker, so noncurrent
   * versions would accumulate unbounded without the lifecycle rule below. Dev
   * (false) keeps the bucket exactly as before — versioning OFF, multipart-only
   * lifecycle. Janitor code is unchanged either way (it lists/deletes current
   * versions). Default false so non-prod callers are unaffected.
   */
  readonly enableVersioning?: boolean;
}

// Bound noncurrent-version storage when versioning is on. 90 days
// mirrors the snapshot story; a delete marker with no older versions is itself
// cleaned via ExpiredObjectDeleteMarker.
const NONCURRENT_VERSION_EXPIRATION_DAYS = 90;

export interface SnapshotsBucket {
  readonly bucket: aws.s3.Bucket;
  readonly bucketName: aws.s3.Bucket["bucket"];
  readonly accessLogsBucket: aws.s3.Bucket;
}

export function createSnapshotsBucket(opts: SnapshotsBucketOpts): SnapshotsBucket {
  const { namePrefix, enableVersioning = false } = opts;

  const bucket = new aws.s3.Bucket(
    `${namePrefix}-snapshots`,
    {
      bucketPrefix: `${namePrefix}-snapshots-`,
      forceDestroy: false,
    },
    { aliases: [{ type: "aws:s3/bucketV2:BucketV2" }] },
  );

  // Dedicated S3 server-access-log bucket.
  // Object-level reads/writes against the snapshots bucket would
  // otherwise be invisible outside CloudTrail data events; this gives
  // a low-cost ($0/mo at personal scale) audit trail of every GetObject
  // / DeleteObject against household snapshot keys.
  // AWS caps `bucketPrefix` at 37 chars (it appends a random suffix and the
  // generated name must stay <= 63). `retivo-dev-snapshots-access-logs-`
  // is exactly 37, but the one-char-longer `prod` namePrefix overflows to 38
  // and is rejected. Cap at 37 so any stack name fits; this is a no-op for the
  // existing dev bucket (already 37) and only trims prod's trailing dash.
  const accessLogsBucket = new aws.s3.Bucket(`${namePrefix}-snapshots-access-logs`, {
    bucketPrefix: `${namePrefix}-snapshots-access-logs-`.slice(0, 37),
    forceDestroy: false,
  });

  new aws.s3.BucketPublicAccessBlock(`${namePrefix}-snapshots-access-logs-pab`, {
    bucket: accessLogsBucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  new aws.s3.BucketServerSideEncryptionConfiguration(
    `${namePrefix}-snapshots-access-logs-sse`,
    {
      bucket: accessLogsBucket.id,
      rules: [
        {
          applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" },
          bucketKeyEnabled: true,
        },
      ],
    },
  );

  new aws.s3.BucketOwnershipControls(`${namePrefix}-snapshots-access-logs-ownership`, {
    bucket: accessLogsBucket.id,
    rule: { objectOwnership: "BucketOwnerEnforced" },
  });

  // Expire access logs after 30 days.
  // Server-access logs at single-household scale are a few KB/week so
  // storage cost is effectively zero either way; the lifecycle just
  // bounds the bucket against accidental unbounded growth.
  new aws.s3.BucketLifecycleConfiguration(
    `${namePrefix}-snapshots-access-logs-lifecycle`,
    {
      bucket: accessLogsBucket.id,
      rules: [
        {
          id: "expire-access-logs-after-30d",
          status: "Enabled",
          filter: {},
          expiration: { days: 30 },
          abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
        },
      ],
    },
  );

  // ACLs are disabled on a BucketOwnerEnforced bucket, so the legacy
  // S3 log-delivery group can't write to it. Grant the modern logging
  // service principal write access via bucket policy, scoped to
  // requests originating from the snapshots bucket in this account.
  const callerIdentity = aws.getCallerIdentityOutput({});
  new aws.s3.BucketPolicy(`${namePrefix}-snapshots-access-logs-policy`, {
    bucket: accessLogsBucket.id,
    policy: pulumi
      .all([accessLogsBucket.arn, bucket.arn, callerIdentity.accountId])
      .apply(([logArn, srcArn, accountId]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "S3ServerAccessLogsPolicy",
              Effect: "Allow",
              Principal: { Service: "logging.s3.amazonaws.com" },
              Action: "s3:PutObject",
              Resource: `${logArn}/access/*`,
              Condition: {
                ArnLike: { "aws:SourceArn": srcArn },
                StringEquals: { "aws:SourceAccount": accountId },
              },
            },
          ],
        }),
      ),
  });

  new aws.s3.BucketLogging(`${namePrefix}-snapshots-access-logging`, {
    bucket: bucket.id,
    targetBucket: accessLogsBucket.id,
    targetPrefix: "access/",
  });

  new aws.s3.BucketPublicAccessBlock(`${namePrefix}-snapshots-pab`, {
    bucket: bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  new aws.s3.BucketServerSideEncryptionConfiguration(
    `${namePrefix}-snapshots-sse`,
    {
      bucket: bucket.id,
      rules: [
        {
          applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" },
          bucketKeyEnabled: true,
        },
      ],
    },
    {
      aliases: [
        {
          type: "aws:s3/bucketServerSideEncryptionConfigurationV2:BucketServerSideEncryptionConfigurationV2",
        },
      ],
    },
  );

  // Object versioning. OFF by default: snapshots are immutable by convention
  // (one S3 object per `<householdId>/<snapshotId>.json.gz`) and retention is
  // enforced by the daily janitor Lambda. When `enableVersioning` is set (prod,
  // gated on `retivo:enableBackups`) it is turned ON because AWS Backup for
  // S3 only protects versioned buckets — and versioning also
  // closes the api-role-overwrite gap on the live prod bucket. Note: S3
  // versioning cannot be turned back OFF (only Suspended), so a rollback
  // (enableBackups=false) leaves existing noncurrent versions until a deliberate
  // operator cleanup (docs/deploy.md → "Backups (`enableBackups`)").
  if (enableVersioning) {
    new aws.s3.BucketVersioning(`${namePrefix}-snapshots-versioning`, {
      bucket: bucket.id,
      versioningConfiguration: { status: "Enabled" },
    });
  }

  // Lifecycle. Always includes the multipart-upload cleanup rule (the
  // `expire-snapshots-after-90d` rule was removed in favor of the janitor:
  // blanket lifecycle expiration deleted the last snapshot for inactive users
  // with no MutationLog rows left to replay). When versioning is on, a second
  // rule bounds noncurrent-version storage: with versioning enabled the
  // janitor's DeleteObject only writes a DELETE MARKER, so prior versions would
  // accumulate unbounded. NoncurrentVersionExpiration ages them out and
  // ExpiredObjectDeleteMarker removes a delete marker once no older version
  // remains behind it. The janitor code is unchanged.
  const lifecycleRules: aws.types.input.s3.BucketLifecycleConfigurationRule[] = [
    {
      id: "abort-incomplete-multipart-uploads",
      status: "Enabled",
      filter: {},
      // Cleans up incomplete uploads if a Lambda dies mid-write.
      abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
    },
  ];
  if (enableVersioning) {
    lifecycleRules.push({
      id: "expire-noncurrent-snapshot-versions",
      status: "Enabled",
      filter: {},
      noncurrentVersionExpiration: {
        noncurrentDays: NONCURRENT_VERSION_EXPIRATION_DAYS,
      },
      expiration: { expiredObjectDeleteMarker: true },
    });
  }

  new aws.s3.BucketLifecycleConfiguration(
    `${namePrefix}-snapshots-lifecycle`,
    {
      bucket: bucket.id,
      rules: lifecycleRules,
    },
    {
      aliases: [
        {
          type: "aws:s3/bucketLifecycleConfigurationV2:BucketLifecycleConfigurationV2",
        },
      ],
    },
  );

  // Default ownership controls — bucket owner enforced; ACLs disabled.
  new aws.s3.BucketOwnershipControls(`${namePrefix}-snapshots-ownership`, {
    bucket: bucket.id,
    rule: { objectOwnership: "BucketOwnerEnforced" },
  });

  return { bucket, bucketName: bucket.bucket, accessLogsBucket };
}
