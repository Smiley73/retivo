// Account-level multi-region CloudTrail trail and its object-locked log bucket (docs/deploy.md "Audit trail (`manageCloudTrail`)").
// Management events only: the first such trail per region is free, and data events and Insights are the priced tiers.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

interface CloudTrailOpts {
  readonly namePrefix: string;
}

export interface CloudTrail {
  readonly trail: aws.cloudtrail.Trail;
  readonly bucket: aws.s3.Bucket;
}

export function createCloudTrail(opts: CloudTrailOpts): CloudTrail {
  const { namePrefix } = opts;

  const callerIdentity = aws.getCallerIdentityOutput({});
  const trailName = `${namePrefix}-trail`;

  const bucket = new aws.s3.Bucket(`${namePrefix}-cloudtrail`, {
    bucketPrefix: `${namePrefix}-cloudtrail-`,
    // Object lock cannot be added after creation.
    objectLockEnabled: true,
    forceDestroy: false,
  });

  new aws.s3.BucketPublicAccessBlock(`${namePrefix}-cloudtrail-pab`, {
    bucket: bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  new aws.s3.BucketServerSideEncryptionConfiguration(
    `${namePrefix}-cloudtrail-sse`,
    {
      bucket: bucket.id,
      rules: [
        {
          applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" },
          bucketKeyEnabled: true,
        },
      ],
    },
  );

  new aws.s3.BucketOwnershipControls(`${namePrefix}-cloudtrail-ownership`, {
    bucket: bucket.id,
    rule: { objectOwnership: "BucketOwnerEnforced" },
  });

  // GOVERNANCE, not COMPLIANCE: an account admin can still break-glass it, the same residual risk
  // the backup vault accepts. The digest chain (`enableLogFileValidation`) keeps tampering
  // detectable if the lock is defeated.
  new aws.s3.BucketObjectLockConfiguration(`${namePrefix}-cloudtrail-lock`, {
    bucket: bucket.id,
    rule: {
      defaultRetention: {
        mode: "GOVERNANCE",
        days: 90,
      },
    },
  });

  // The SourceArn condition pins the policy to this trail, so a trail in another account cannot
  // write here.
  const bucketPolicy = new aws.s3.BucketPolicy(`${namePrefix}-cloudtrail-policy`, {
    bucket: bucket.id,
    policy: pulumi
      .all([bucket.arn, callerIdentity.accountId])
      .apply(([bucketArn, accountId]) => {
        const trailArn = `arn:aws:cloudtrail:${aws.config.region}:${accountId}:trail/${trailName}`;
        return JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AWSCloudTrailAclCheck",
              Effect: "Allow",
              Principal: { Service: "cloudtrail.amazonaws.com" },
              Action: "s3:GetBucketAcl",
              Resource: bucketArn,
              Condition: {
                StringEquals: { "aws:SourceArn": trailArn },
              },
            },
            {
              Sid: "AWSCloudTrailWrite",
              Effect: "Allow",
              Principal: { Service: "cloudtrail.amazonaws.com" },
              Action: "s3:PutObject",
              Resource: `${bucketArn}/AWSLogs/${accountId}/*`,
              Condition: {
                StringEquals: {
                  "s3:x-amz-acl": "bucket-owner-full-control",
                  "aws:SourceArn": trailArn,
                },
              },
            },
          ],
        });
      }),
  });

  // Data events and Insights are omitted because they are priced; revisit when a forensic need for
  // object-level access history appears or a commercial launch nears.
  const trail = new aws.cloudtrail.Trail(
    `${namePrefix}-trail`,
    {
      name: trailName,
      s3BucketName: bucket.bucket,
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: true,
      enableLogging: true,
      enableLogFileValidation: true,
    },
    // CreateTrail validates the bucket policy server-side, so depending on the bucket alone races
    // and 400s on a fresh account.
    { dependsOn: [bucket, bucketPolicy] },
  );

  return { trail, bucket };
}
