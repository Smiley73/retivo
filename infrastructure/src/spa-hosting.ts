// Private S3 bucket that hosts the built React SPA. Reachable only
// via the CloudFront distribution through Origin Access Control (OAC),
// so the bucket itself stays fully private (BucketOwnerEnforced, public
// access blocked).
//
// The bucket is uploaded to by `infrastructure/scripts/bootstrap-stack.sh`
// after pass 1 of `pulumi up` creates the bucket — Pulumi owns the
// resource shape; the script owns the asset contents.
//
// @pulumi/aws v7 deprecated the `*V2` resource names; we use the
// canonical types + `aliases` for state migration. See the matching
// pattern in `s3.ts` for the snapshots bucket.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

interface SpaHostingOpts {
  readonly namePrefix: string;
}

export interface SpaHosting {
  readonly bucket: aws.s3.Bucket;
  readonly bucketName: pulumi.Output<string>;
  readonly bucketRegionalDomainName: pulumi.Output<string>;
  readonly originAccessControl: aws.cloudfront.OriginAccessControl;
}

export function createSpaHosting(opts: SpaHostingOpts): SpaHosting {
  const { namePrefix } = opts;

  const bucket = new aws.s3.Bucket(
    `${namePrefix}-spa`,
    {
      bucket: undefined, // let Pulumi pick a globally-unique name
      // The bucket holds only the built SPA bundle (rebuildable from source),
      // but it is deletion-protected unconditionally — on every stack,
      // including dev — because `pulumi destroy` is the one path that could
      // otherwise wipe it silently, including after an operator empties it
      // first. `forceDestroy: false` is the second layer, for the case
      // protection has been deliberately lifted. Lifting protection is
      // `pulumi state unprotect <this bucket's URN>`, or deleting the
      // `protect: true` line below and running `pulumi up` first — either
      // way a deliberate act, which is the point.
      forceDestroy: false,
      tags: { purpose: "spa-static-hosting" },
    },
    {
      // `protect: true` blocks REPLACEMENT as well as deletion. Safe here:
      // the bucket takes an auto-generated name (`bucket: undefined` above),
      // so no property change that would force a replace is in flight.
      protect: true,
      // Load-bearing for the v6→v7 `@pulumi/aws` type migration — dropping
      // this alias would destroy and recreate the live bucket.
      aliases: [{ type: "aws:s3/bucketV2:BucketV2" }],
    },
  );

  // Block every form of public access. Reads come exclusively through
  // CloudFront's OAC.
  new aws.s3.BucketPublicAccessBlock(`${namePrefix}-spa-public-block`, {
    bucket: bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  // Owner enforcement disables ACLs entirely — the only authorization
  // surface is the bucket policy attached below.
  new aws.s3.BucketOwnershipControls(`${namePrefix}-spa-ownership`, {
    bucket: bucket.id,
    rule: { objectOwnership: "BucketOwnerEnforced" },
  });

  new aws.s3.BucketServerSideEncryptionConfiguration(
    `${namePrefix}-spa-sse`,
    {
      bucket: bucket.id,
      rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
    },
    {
      aliases: [
        {
          type: "aws:s3/bucketServerSideEncryptionConfigurationV2:BucketServerSideEncryptionConfigurationV2",
        },
      ],
    },
  );

  // OAC — Origin Access Control — the modern (signed-V4) replacement
  // for OAI. Required for CloudFront to read from a private bucket.
  const originAccessControl = new aws.cloudfront.OriginAccessControl(
    `${namePrefix}-spa-oac`,
    {
      name: `${namePrefix}-spa-oac`,
      description: "OAC for SPA static-hosting bucket",
      originAccessControlOriginType: "s3",
      signingBehavior: "always",
      signingProtocol: "sigv4",
    },
  );

  return {
    bucket,
    bucketName: bucket.bucket,
    bucketRegionalDomainName: bucket.bucketRegionalDomainName,
    originAccessControl,
  };
}

/**
 * Bucket policy that grants the CloudFront distribution `s3:GetObject`
 * via the OAC. Created separately from the bucket so we can wait for
 * the distribution ARN — closing the OAC trust loop.
 */
export function attachSpaBucketPolicy(opts: {
  namePrefix: string;
  bucket: aws.s3.Bucket;
  distributionArn: pulumi.Output<string>;
}): void {
  const { namePrefix, bucket, distributionArn } = opts;
  new aws.s3.BucketPolicy(`${namePrefix}-spa-bucket-policy`, {
    bucket: bucket.id,
    policy: pulumi
      .all([bucket.arn, distributionArn])
      .apply(([bucketArn, distArn]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AllowCloudFrontReadViaOAC",
              Effect: "Allow",
              Principal: { Service: "cloudfront.amazonaws.com" },
              Action: "s3:GetObject",
              Resource: `${bucketArn}/*`,
              Condition: {
                StringEquals: { "AWS:SourceArn": distArn },
              },
            },
          ],
        }),
      ),
  });
}
