// SSM parameters for runtime secrets, created with a placeholder and `value`/`description` in `ignoreChanges`,
// so a rotation by `aws ssm put-parameter` survives `pulumi up` (AGENTS.md "JWT signing-key rotation").

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

const SECRET_IGNORE: pulumi.CustomResourceOptions = {
  ignoreChanges: ["value", "description"],
};

export function createSsmParameters(opts: SsmOpts): SsmParameters {
  const { stack, sesFromAddress } = opts;
  const base = `/retivo/${stack}`;

  // Both JWT keys are SecureString, though the public one is not secret, so one IAM grant and one
  // KMS condition cover both.
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

  // A plain config value owned by Pulumi: no ignoreChanges, so a manual put-parameter is reverted.
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
