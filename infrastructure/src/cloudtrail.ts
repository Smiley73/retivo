// Account-level CloudTrail trail.
//
// One multi-region trail captures management events from every stack in
// the account (`retivo-dev-*`, `retivo-prod-*`, IAM, STS, SSM,
// Lambda, DynamoDB control plane). The first such trail per region is
// free for management events; data events are not enabled — they are the
// priced tier, and the management events captured here already cover the
// control-plane activity an investigation starts from (see the trail
// resource below for the full reasoning and the revisit condition). Log
// delivery to S3 costs a few cents per month even on a noisy stack.
//
// The trail bucket is object-lock-enabled at creation (cannot be
// retrofitted) with a 90-day GOVERNANCE retention default. GOVERNANCE
// allows an account admin with the `s3:BypassGovernanceRetention`
// permission to lift a lock if necessary; COMPLIANCE (irreversible) is
// the right pick for commercial deployments and is a one-line change
// when that profile lands. `enableLogFileValidation: true` adds an
// SHA-256 digest chain so tampering is detectable even if the lock is
// somehow defeated.
//
// Nothing here stops an account admin: whoever deploys holds their own
// credentials, and a stolen admin credential can still break-glass
// GOVERNANCE the same way the backup vault accepts as residual risk.
// The protection is the GOVERNANCE lock plus the digest chain.

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
    // MUST be set at creation. Cannot be added retroactively to an
    // existing bucket; if this trail bucket is ever destroyed and
    // recreated, the new one inherits this same setting.
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

  // 90-day default object retention. GOVERNANCE permits an account
  // admin override; commercial deployments should switch to COMPLIANCE
  // here (which requires opening an AWS Support ticket to lift). 90d
  // matches the commercial-profile log-retention floor and exceeds the
  // 30d CloudWatch retention on the api/compactor logs so a
  // post-incident audit trail outlives the operational logs.
  new aws.s3.BucketObjectLockConfiguration(`${namePrefix}-cloudtrail-lock`, {
    bucket: bucket.id,
    rule: {
      defaultRetention: {
        mode: "GOVERNANCE",
        days: 90,
      },
    },
  });

  // CloudTrail writes objects on behalf of the service principal. The
  // SourceArn condition pins the policy to this specific trail, so a
  // hijacked CloudTrail in some other account cannot dump logs into
  // this bucket and force us to pay the storage.
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

  // Multi-region capture so events from every stack in this account
  // land in a single audit trail regardless of which region future
  // resources are deployed to. Data events are intentionally omitted —
  // they're the priced tier (~$0.10 per 100k events), and the
  // management-event trail here already covers control-plane activity
  // (bucket policy / IAM / resource changes); object-level S3/DynamoDB
  // access logging is deferred until there's a concrete forensic need for
  // it. CloudTrail Insights is also off (priced separately; anomaly
  // detection isn't warranted without that need either).
  // Who revisits: the operator. Reopen trigger: a forensic investigation
  // needs object-level access history, or a commercial launch approaches
  // (see docs/deploy.md → "Audit trail (`manageCloudTrail`)").
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
    // CreateTrail validates the bucket policy server-side, so the trail must
    // wait for the policy PUT — depending on the bucket alone loses the race
    // and 400s with InsufficientS3BucketPolicyException on a fresh account.
    { dependsOn: [bucket, bucketPolicy] },
  );

  return { trail, bucket };
}
