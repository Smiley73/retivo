// Stream-triggered Lambda that deletes the user, credential and email-reservation rows when a SignupApproval TTL fires.
// Its role is narrower than the api role: cascade deletes on four tables plus the approval stream.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";
import { Tables } from "./dynamo";
import { resolveLambdaArtifact } from "./lambda-artifact";

interface SignupCascadeOpts {
  readonly namePrefix: string;
  readonly stack: string;
  readonly tables: Tables;
  /** CloudWatch Logs retention in days for the log group. */
  readonly logRetentionDays: number;
  /** Permissions-boundary ARN for the cascade role, as in iam.ts. */
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
        // TransactWriteItems has no IAM action; the transaction is authorized by DeleteItem and
        // ConditionCheckItem. No GSI access.
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

  // `LATEST` so a fresh deploy does not replay historical TTL deletes; the next signup with the
  // same email recycles misses.
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
