// Private S3 bucket for the built SPA, read only through CloudFront Origin Access Control; bootstrap-stack.sh uploads the assets.
// The `BucketV2` alias is load-bearing for the v6 to v7 migration; dropping it recreates the live bucket (same as s3.ts).

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
      // `protect: true` and `forceDestroy: false` on every stack, dev included: `pulumi destroy`
      // could otherwise wipe the bucket silently. Lifting protection is a deliberate `pulumi state
      // unprotect`.
      forceDestroy: false,
      tags: { purpose: "spa-static-hosting" },
    },
    {
      // `protect` also blocks replacement, which is safe here as the name is auto-generated.
      protect: true,
      // Dropping this alias would destroy and recreate the live bucket.
      aliases: [{ type: "aws:s3/bucketV2:BucketV2" }],
    },
  );

  new aws.s3.BucketPublicAccessBlock(`${namePrefix}-spa-public-block`, {
    bucket: bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  // ACLs are disabled; the bucket policy below is the only authorization surface.
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

/** Bucket policy granting the distribution `s3:GetObject` via OAC; created after it because it needs the distribution ARN. */
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
