// Stream-triggered Lambda that reaps the user-row sub-graph when an
// approval token's TTL fires.
//
// Trigger: DynamoDB stream on the SignupApproval table (NEW_AND_OLD_IMAGES).
// Action: for each REMOVE event whose old-image flags `userId` against a
// still-pending or declined User row, delete user + credential + email-
// reservation in a TransactWrite. Idempotent — replays on retries are
// safe because the conditional deletes treat "row already gone" as a no-op.
//
// IAM is intentionally narrower than the api role: cascade-only deletes
// on the four tables it touches, plus DescribeStream + GetRecords on the
// SignupApproval stream. No SES, no S3, no GSI access.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";
import { Tables } from "./dynamo";
import { resolveLambdaArtifact } from "./lambda-artifact";

interface SignupCascadeOpts {
  readonly namePrefix: string;
  readonly stack: string;
  readonly tables: Tables;
  /**
   * Cost-control knob (sourced from `retivo:logRetentionDays`):
   * CloudWatch Logs retention in days for the signup-cascade log group.
   * Dev example=7, prod=90.
   */
  readonly logRetentionDays: number;
  /**
   * Optional permissions-boundary ARN for the cascade role — same
   * contract as iam.ts.
   */
  readonly permissionsBoundaryArn?: string;
}

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LAMBDA_BUILD_DIR = path.join(
  REPO_ROOT,
  "apps",
  "api",
  "build",
  "lambda",
);
const SHELLS_DIR = path.resolve(__dirname, "..", "lambda-shells");

/**
 * Returns the deployable artifact for the signup-cascade Lambda. Delegates to
 * the shared `resolveLambdaArtifact()` (lambda-artifact.ts) — the SAME
 * full-coverage fail-closed invariant as lambda.ts's `lambdaCode()`: because
 * every Lambda ships from this one shared build directory, the artifact is used
 * only when ALL six deployed handler files are present (not just
 * `signup-cascade-lambda.js`). During `pulumi preview` only, it falls back to
 * the placeholder shell so a fresh checkout that hasn't run `build:lambda` can still
 * preview; on a real `pulumi up` with the artifact incomplete it throws instead
 * of silently deploying the non-functional 501/no-op shell.
 */
function cascadeCode(): pulumi.asset.Archive {
  return resolveLambdaArtifact(
    LAMBDA_BUILD_DIR,
    "signup-cascade",
    () =>
      new pulumi.asset.AssetArchive({
        "index.mjs": new pulumi.asset.FileAsset(
          path.join(SHELLS_DIR, "signup-cascade", "index.mjs"),
        ),
      }),
  );
}

const lambdaAssumeRolePolicy = aws.iam.getPolicyDocumentOutput({
  statements: [
    {
      effect: "Allow",
      principals: [{ type: "Service", identifiers: ["lambda.amazonaws.com"] }],
      actions: ["sts:AssumeRole"],
    },
  ],
});

export function createSignupCascade(opts: SignupCascadeOpts): aws.lambda.Function {
  const { namePrefix, stack, tables, logRetentionDays, permissionsBoundaryArn } =
    opts;

  const role = new aws.iam.Role(`${namePrefix}-signup-cascade-role`, {
    name: `${namePrefix}-signup-cascade-role`,
    assumeRolePolicy: lambdaAssumeRolePolicy.json,
    permissionsBoundary: permissionsBoundaryArn,
    description:
      "Stream-triggered cascade for expired SignupApproval rows. Deletes the user + credential + email-reservation associated with a TTL'd approval. Disjoint from the api role.",
  });

  new aws.iam.RolePolicyAttachment(`${namePrefix}-signup-cascade-logs`, {
    role: role.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  });

  const cascadePolicy = aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        sid: "ReadAndCleanUser",
        effect: "Allow",
        // GetItem to load the user, DeleteItem on the cascade tables, and
        // ConditionCheckItem for the atomic cleanup transaction. The cascade's
        // `TransactWriteItems` needs NO dedicated IAM action: AWS has no
        // `dynamodb:TransactWriteItems` action — the transaction is authorized
        // by the per-item `DeleteItem`/`ConditionCheckItem` operations already
        // granted here. The former inert string was removed with no change to
        // effective permissions. Scoped to the four tables this Lambda is
        // allowed to touch — no GSI access (the cascade reads by primary key
        // only).
        actions: [
          "dynamodb:GetItem",
          "dynamodb:DeleteItem",
          "dynamodb:ConditionCheckItem",
        ],
        resources: [
          tables.user.arn,
          tables.credential.arn,
          tables.emailReservation.arn,
          tables.signupApproval.arn,
        ],
      },
      {
        sid: "RecordAuditEvent",
        effect: "Allow",
        actions: ["dynamodb:PutItem"],
        resources: [tables.authEvent.arn],
      },
      {
        sid: "ReadSignupApprovalStream",
        effect: "Allow",
        actions: [
          "dynamodb:DescribeStream",
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:ListStreams",
        ],
        resources: [pulumi.interpolate`${tables.signupApproval.arn}/stream/*`],
      },
    ],
  });

  new aws.iam.RolePolicy(`${namePrefix}-signup-cascade-policy`, {
    role: role.id,
    policy: cascadePolicy.json,
  });

  const fn = new aws.lambda.Function(`${namePrefix}-signup-cascade`, {
    name: `${namePrefix}-signup-cascade`,
    runtime: aws.lambda.Runtime.NodeJS24dX,
    architectures: ["arm64"],
    role: role.arn,
    handler: "signup-cascade-lambda.handler",
    code: cascadeCode(),
    memorySize: 256,
    timeout: 30,
    environment: {
      variables: {
        NODE_ENV: "production",
        STACK: stack,
        TABLE_USER: tables.user.name,
        TABLE_CREDENTIAL: tables.credential.name,
        TABLE_EMAIL_RESERVATION: tables.emailReservation.name,
        TABLE_SIGNUP_APPROVAL: tables.signupApproval.name,
        TABLE_AUTH_EVENT: tables.authEvent.name,
      },
    },
    loggingConfig: {
      logFormat: "JSON",
      applicationLogLevel: "INFO",
    },
  });

  new aws.cloudwatch.LogGroup(`${namePrefix}-signup-cascade-logs`, {
    name: pulumi.interpolate`/aws/lambda/${fn.name}`,
    retentionInDays: logRetentionDays,
  });

  // Stream → Lambda binding. `LATEST` so a fresh deploy doesn't replay
  // historical TTL deletes; the only reason we'd ever want TRIM_HORIZON
  // is to backfill missed events, and the lazy-recycle path on the next
  // signup with the same email still covers any cleanup we miss.
  new aws.lambda.EventSourceMapping(`${namePrefix}-signup-cascade-stream`, {
    eventSourceArn: tables.signupApproval.streamArn,
    functionName: fn.name,
    startingPosition: "LATEST",
    batchSize: 25,
    maximumRetryAttempts: 3,
    bisectBatchOnFunctionError: true,
  });

  return fn;
}
