// SSM Parameter Store entries for runtime secrets.
//
// Pulumi creates each parameter with a placeholder value on first
// `pulumi up`. The bootstrap script (`infrastructure/scripts/bootstrap-stack.sh`)
// runs `aws ssm put-parameter --overwrite` to replace the placeholders
// with real, randomly-generated secrets. We mark `value` and
// `description` in `ignoreChanges` so subsequent `pulumi up` runs do
// not revert those manual rotations.
//
// SecureString uses the AWS-managed alias/aws/ssm KMS key by default.
// The api Lambda's IAM policy grants kms:Decrypt only via that key.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

interface SsmOpts {
  readonly namePrefix: string;
  readonly stack: string;
  readonly sesFromAddress: string;
}

export interface SsmParameters {
  readonly jwtPrivateKeys: aws.ssm.Parameter;
  readonly jwtPublicKeys: aws.ssm.Parameter;
  readonly refreshSecret: aws.ssm.Parameter;
  readonly edgeSharedSecret: aws.ssm.Parameter;
  readonly sesFromAddress: aws.ssm.Parameter;
  readonly arns: pulumi.Output<string[]>;
}

const PLACEHOLDER =
  "phase-1-placeholder-replace-via-aws-ssm-put-parameter-overwrite";

// Ignore drift on `value` so the bootstrap script's secret rotation
// survives `pulumi up`. Description churn shouldn't fight us either.
const SECRET_IGNORE: pulumi.CustomResourceOptions = {
  ignoreChanges: ["value", "description"],
};

export function createSsmParameters(opts: SsmOpts): SsmParameters {
  const { stack, sesFromAddress } = opts;
  const base = `/retivo/${stack}`;

  // RS256 keypair. Two SSM parameters keyed by
  // the same `kid` set: private (PKCS#8 PEM) signs new access tokens,
  // public (SPKI PEM) verifies and is also surfaced on the api's JWKS
  // endpoint. The bootstrap script generates a real RSA-2048 keypair on
  // first run and overwrites both placeholders. Both parameters are
  // SecureString for uniformity — the public key is technically not
  // secret, but the IAM grant + KMS condition cover both lookups
  // identically.
  const jwtPrivateKeys = new aws.ssm.Parameter(
    `${stack}-ssm-jwt-private-keys`,
    {
      name: `${base}/auth/jwt-private-keys`,
      type: "SecureString",
      description:
        "JSON map of {kid: pkcs8PrivateKeyPem} for JWT RS256 signing. Rotate per the JWT signing-key rotation steps in AGENTS.md.",
      value: JSON.stringify({ "phase-1-placeholder": PLACEHOLDER }),
    },
    SECRET_IGNORE,
  );

  const jwtPublicKeys = new aws.ssm.Parameter(
    `${stack}-ssm-jwt-public-keys`,
    {
      name: `${base}/auth/jwt-public-keys`,
      type: "SecureString",
      description:
        "JSON map of {kid: spkiPublicKeyPem} for JWT RS256 verification + JWKS. Same kid set as jwt-private-keys.",
      value: JSON.stringify({ "phase-1-placeholder": PLACEHOLDER }),
    },
    SECRET_IGNORE,
  );

  const refreshSecret = new aws.ssm.Parameter(
    `${stack}-ssm-refresh-secret`,
    {
      name: `${base}/auth/refresh-secret`,
      type: "SecureString",
      description: "Server-side secret used to derive refresh-token hashes.",
      value: PLACEHOLDER,
    },
    SECRET_IGNORE,
  );

  const edgeSharedSecret = new aws.ssm.Parameter(
    `${stack}-ssm-edge-secret`,
    {
      name: `${base}/edge/shared-secret`,
      type: "SecureString",
      description:
        "Shared secret between CloudFront and API Gateway / Lambda. Used to restrict direct API Gateway access.",
      value: PLACEHOLDER,
    },
    SECRET_IGNORE,
  );

  // Unlike the random secrets above, the SES from-address is just a
  // config value. Pulumi owns it — change `retivo:sesFromAddress`
  // in stack config and the next `pulumi up` updates it. No
  // ignoreChanges, so manual `aws ssm put-parameter` against this one
  // would be reverted (as it should be).
  const sesFromAddressParam = new aws.ssm.Parameter(`${stack}-ssm-ses-from`, {
    name: `${base}/ses/from-address`,
    type: "String",
    description:
      "Verified-in-SES sender for signup verification mail. Managed by Pulumi via the `retivo:sesFromAddress` stack config; the api Lambda reads it at cold start.",
    value: sesFromAddress,
  });

  const arns = pulumi.all([
    jwtPrivateKeys.arn,
    jwtPublicKeys.arn,
    refreshSecret.arn,
    edgeSharedSecret.arn,
    sesFromAddressParam.arn,
  ]);

  return {
    jwtPrivateKeys,
    jwtPublicKeys,
    refreshSecret,
    edgeSharedSecret,
    sesFromAddress: sesFromAddressParam,
    arns,
  };
}
