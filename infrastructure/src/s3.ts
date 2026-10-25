// Workspace snapshots bucket (block-public-access, SSE-S3) and its access-log bucket.
// Retention is the daily janitor Lambda's job: a blanket lifecycle expiration deleted the only snapshot of inactive users.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

interface SnapshotsBucketOpts {
  readonly namePrefix: string;
  /** Versioning plus a noncurrent-version lifecycle rule; prod-only (`enableBackups`), as AWS Backup for S3 needs a versioned bucket. */
  readonly enableVersioning?: boolean;
}

// Bounds noncurrent-version storage when versioning is on.
const NONCURRENT_VERSION_EXPIRATION_DAYS = 90;

export interface SnapshotsBucket {
  readonly bucket: aws.s3.Bucket;
  readonly bucketName: aws.s3.Bucket["bucket"];
  readonly accessLogsBucket: aws.s3.Bucket;
}

export function createSnapshotsBucket(opts: SnapshotsBucketOpts): SnapshotsBucket {
  const { namePrefix, enableVersioning = false } = opts;

  // The V2 aliases carry state created against the v6 `*V2` resource types; dropping one recreates
  // the resource.
  const bucket = new aws.s3.Bucket(
    `${namePrefix}-snapshots`,
    {
      bucketPrefix: `${namePrefix}-snapshots-`,
      forceDestroy: false,
    },
    { aliases: [{ type: "aws:s3/bucketV2:BucketV2" }] },
  );

  // Server-access logs for object-level audit of the snapshots bucket. AWS caps `bucketPrefix` at
  // 37 characters, which the longer `prod` prefix would exceed.
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

  // ACLs are disabled, so the logging service principal gets write access by policy instead of the
  // legacy log-delivery group.
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

  // Off by default; prod turns it on because AWS Backup for S3 needs a versioned bucket. Versioning
  // cannot be turned off again (only suspended), so a rollback leaves noncurrent versions until an
  // operator cleanup (docs/deploy.md "Backups (`enableBackups`)").
  if (enableVersioning) {
    new aws.s3.BucketVersioning(`${namePrefix}-snapshots-versioning`, {
      bucket: bucket.id,
      versioningConfiguration: { status: "Enabled" },
    });
  }

  // With versioning on, the janitor's DeleteObject only writes a delete marker, so a second rule
  // ages out noncurrent versions and expired delete markers.
  const lifecycleRules: aws.types.input.s3.BucketLifecycleConfigurationRule[] = [
    {
      id: "abort-incomplete-multipart-uploads",
      status: "Enabled",
      filter: {},
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

  new aws.s3.BucketOwnershipControls(`${namePrefix}-snapshots-ownership`, {
    bucket: bucket.id,
    rule: { objectOwnership: "BucketOwnerEnforced" },
  });

  return { bucket, bucketName: bucket.bucket, accessLogsBucket };
}
