// The api, compactor, janitor, snapshot-purge and probe Lambdas (signup-cascade.ts owns the sixth), each with its role from iam.ts.
// All run arm64 (Graviton), which is cheaper at the same memory.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";
import { Tables } from "./dynamo";
import { Roles, createProbeRole } from "./iam";
import { resolveLambdaArtifact } from "./lambda-artifact";

interface LambdaOpts {
  readonly namePrefix: string;
  readonly stack: string;
  readonly tables: Tables;
  readonly snapshotsBucketName: pulumi.Output<string>;
  readonly roles: Roles;
  readonly webOrigin: string;
  /** Owner inbox for sign-up approvals; omitted from the env when unset. */
  readonly approverEmail: string | undefined;
  /** When false, the compactor EventBridge schedule is created but disabled. */
  readonly compactorEnabled: boolean;
  /** When false, the janitor EventBridge schedule is created but disabled. */
  readonly janitorEnabled: boolean;
  /** Enforced-MFA kill-switch (AUTH_MFA_ENFORCED); false disables enforcement without a code change. */
  readonly authMfaEnforced: boolean;
  /** Minimum number of snapshots per household the janitor must keep, regardless of age. */
  readonly snapshotMinKeep: number;
  /** Snapshots older than this are eligible for janitor deletion (subject to the floor). */
  readonly snapshotMinAgeDays: number;
  /** CloudWatch Logs retention in days for every log group created here. */
  readonly logRetentionDays: number;
}

export interface Lambdas {
  readonly api: aws.lambda.Function;
  readonly compactor: aws.lambda.Function;
  readonly janitor: aws.lambda.Function;
  readonly snapshotPurge: aws.lambda.Function;
  readonly apiLogGroup: aws.cloudwatch.LogGroup;
}

/** The probe Lambda and its log group, returned separately so monitoring can reference them. */
export interface ProbeLambdaOutputs {
  readonly lambda: aws.lambda.Function;
  readonly logGroup: aws.cloudwatch.LogGroup;
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

function lambdaCode(folder: "api" | "compactor" | "janitor"): pulumi.asset.Archive {
  return resolveLambdaArtifact(
    LAMBDA_BUILD_DIR,
    folder,
    () =>
      new pulumi.asset.AssetArchive({
        "index.mjs": new pulumi.asset.FileAsset(
          path.join(SHELLS_DIR, folder, "index.mjs"),
        ),
      }),
  );
}

export function createLambdas(opts: LambdaOpts): Lambdas {
  const {
    namePrefix,
    stack,
    tables,
    snapshotsBucketName,
    roles,
    webOrigin,
    approverEmail,
    compactorEnabled,
    janitorEnabled,
    authMfaEnforced,
    snapshotMinKeep,
    snapshotMinAgeDays,
    logRetentionDays,
  } = opts;

  // BUILD_ID is the deploy fingerprint behind the SPA's "new version" banner. A bare `pulumi up`
  // stamps `dev`, which the detector treats as "never mismatch"; deploy through deploy-stack.sh.
  const buildId = process.env.BUILD_ID ?? "dev";

  // No deployed stack echoes a raw verification, approval, reset or change-email token; explicit
  // 'false' so env.config.ts has nothing to refuse.
  const exposeVerificationToken = "false";

  const apiEnv: pulumi.Input<{ [key: string]: pulumi.Input<string> }> = {
    NODE_ENV: "production",
    STACK: stack,
    BUILD_ID: buildId,
    WEB_ORIGIN: webOrigin,
    ...(approverEmail ? { APPROVER_EMAIL: approverEmail } : {}),
    EXPOSE_VERIFICATION_TOKEN: exposeVerificationToken,
    // Stack-scoped iss/aud claims keep dev and prod tokens mutually invalid.
    AUTH_JWT_ISSUER: `retivo-api/${stack}`,
    AUTH_JWT_AUDIENCE: `retivo-web/${stack}`,
    TABLE_WORKSPACE_META: tables.workspaceMeta.name,
    TABLE_MUTATION_LOG: tables.mutationLog.name,
    TABLE_AGGREGATE_VERSION: tables.aggregateVersion.name,
    TABLE_IDEMPOTENCY_KEY: tables.idempotencyKey.name,
    TABLE_DEVICE_REGISTRY: tables.deviceRegistry.name,
    TABLE_USER: tables.user.name,
    TABLE_EMAIL_RESERVATION: tables.emailReservation.name,
    TABLE_EMAIL_VERIFICATION: tables.emailVerification.name,
    TABLE_PASSWORD_RESET: tables.passwordReset.name,
    TABLE_CREDENTIAL: tables.credential.name,
    TABLE_PASSKEY: tables.passkey.name,
    TABLE_REFRESH_TOKEN: tables.refreshToken.name,
    TABLE_REVOKED_TOKEN: tables.revokedToken.name,
    TABLE_FAILED_LOGIN_ATTEMPT: tables.failedLoginAttempt.name,
    TABLE_AUTH_EVENT: tables.authEvent.name,
    TABLE_SIGNUP_APPROVAL: tables.signupApproval.name,
    TABLE_HOUSEHOLD_KEY_ENVELOPE: tables.householdKeyEnvelope.name,
    TABLE_USER_MFA: tables.userMfa.name,
    TABLE_MFA_EMAIL_OTP: tables.mfaEmailOtp.name,
    TABLE_TRUSTED_DEVICE: tables.trustedDevice.name,
    TABLE_PASSKEY_CHALLENGE: tables.passkeyChallenge.name,
    // Email OTP gives universal day-one coverage, so default-on is lockout-safe; the kill-switch is
    // permanent.
    AUTH_MFA_ENFORCED: authMfaEnforced ? "true" : "false",
    SNAPSHOTS_BUCKET: snapshotsBucketName,
    // The account-delete cascade invokes this function synchronously; the name is also the IAM
    // invoke ARN in iam.ts.
    SNAPSHOT_PURGE_FUNCTION_NAME: `${namePrefix}-snapshot-purge`,
  };

  const api = new aws.lambda.Function(`${namePrefix}-api`, {
    name: `${namePrefix}-api`,
    runtime: aws.lambda.Runtime.NodeJS24dX,
    architectures: ["arm64"],
    role: roles.api.arn,
    handler: "lambda.handler",
    code: lambdaCode("api"),
    memorySize: 512,
    timeout: 30,
    environment: { variables: apiEnv },
    loggingConfig: {
      logFormat: "JSON",
      applicationLogLevel: "INFO",
    },
  });

  const apiLogGroup = new aws.cloudwatch.LogGroup(`${namePrefix}-api-logs`, {
    name: pulumi.interpolate`/aws/lambda/${api.name}`,
    retentionInDays: logRetentionDays,
  });

  // The auth table envs are unset so an accidentally imported auth provider fails closed.
  const compactorEnv: pulumi.Input<{ [key: string]: pulumi.Input<string> }> = {
    NODE_ENV: "production",
    STACK: stack,
    TABLE_WORKSPACE_META: tables.workspaceMeta.name,
    TABLE_MUTATION_LOG: tables.mutationLog.name,
    TABLE_AGGREGATE_VERSION: tables.aggregateVersion.name,
    SNAPSHOTS_BUCKET: snapshotsBucketName,
  };

  const compactor = new aws.lambda.Function(`${namePrefix}-compactor`, {
    name: `${namePrefix}-compactor`,
    runtime: aws.lambda.Runtime.NodeJS24dX,
    architectures: ["arm64"],
    role: roles.compactor.arn,
    handler: "compactor-lambda.handler",
    code: lambdaCode("compactor"),
    memorySize: 1024,
    timeout: 300,
    environment: { variables: compactorEnv },
    loggingConfig: {
      logFormat: "JSON",
      applicationLogLevel: "INFO",
    },
  });

  new aws.cloudwatch.LogGroup(`${namePrefix}-compactor-logs`, {
    name: pulumi.interpolate`/aws/lambda/${compactor.name}`,
    retentionInDays: logRetentionDays,
  });

  // The name must stay `${namePrefix}-snapshot-purge`: the api role's lambda:InvokeFunction ARN in
  // iam.ts is derived from it.
  const snapshotPurge = new aws.lambda.Function(`${namePrefix}-snapshot-purge`, {
    name: `${namePrefix}-snapshot-purge`,
    runtime: aws.lambda.Runtime.NodeJS24dX,
    architectures: ["arm64"],
    role: roles.snapshotPurge.arn,
    handler: "account-snapshot-purge-lambda.handler",
    code: lambdaCode("api"),
    memorySize: 512,
    timeout: 60,
    environment: {
      variables: {
        NODE_ENV: "production",
        STACK: stack,
        SNAPSHOTS_BUCKET: snapshotsBucketName,
      },
    },
    loggingConfig: {
      logFormat: "JSON",
      applicationLogLevel: "INFO",
    },
  });

  new aws.cloudwatch.LogGroup(`${namePrefix}-snapshot-purge-logs`, {
    name: pulumi.interpolate`/aws/lambda/${snapshotPurge.name}`,
    retentionInDays: logRetentionDays,
  });

  // Prod uses a fixed cron minute and dev a 6-hour rate (less of the shared concurrency quota). A
  // redeploy recreates the rule, so a rate could drift onto another job's minute.
  const schedule = new aws.cloudwatch.EventRule(
    `${namePrefix}-compactor-schedule`,
    {
      name: `${namePrefix}-compactor-schedule`,
      scheduleExpression:
        stack === "prod" ? "cron(41 * * * ? *)" : "rate(6 hours)",
      state: compactorEnabled ? "ENABLED" : "DISABLED",
    },
  );

  new aws.cloudwatch.EventTarget(`${namePrefix}-compactor-target`, {
    rule: schedule.name,
    arn: compactor.arn,
  });

  new aws.lambda.Permission(`${namePrefix}-compactor-event-perm`, {
    action: "lambda:InvokeFunction",
    function: compactor.name,
    principal: "events.amazonaws.com",
    sourceArn: schedule.arn,
  });

  // No DynamoDB tables: the janitor role has no DynamoDB action.
  const janitorEnv: pulumi.Input<{ [key: string]: pulumi.Input<string> }> = {
    NODE_ENV: "production",
    STACK: stack,
    SNAPSHOTS_BUCKET: snapshotsBucketName,
    SNAPSHOT_MIN_KEEP: String(snapshotMinKeep),
    SNAPSHOT_MIN_AGE_DAYS: String(snapshotMinAgeDays),
  };

  const janitor = new aws.lambda.Function(`${namePrefix}-janitor`, {
    name: `${namePrefix}-janitor`,
    runtime: aws.lambda.Runtime.NodeJS24dX,
    architectures: ["arm64"],
    role: roles.janitor.arn,
    handler: "janitor-lambda.handler",
    code: lambdaCode("janitor"),
    memorySize: 512,
    timeout: 300,
    environment: { variables: janitorEnv },
    loggingConfig: {
      logFormat: "JSON",
      applicationLogLevel: "INFO",
    },
  });

  new aws.cloudwatch.LogGroup(`${namePrefix}-janitor-logs`, {
    name: pulumi.interpolate`/aws/lambda/${janitor.name}`,
    retentionInDays: logRetentionDays,
  });

  // Fixed 03:17 UTC cron on both stacks, not a rate, so a redeploy cannot move it onto another
  // job's minute.
  const janitorSchedule = new aws.cloudwatch.EventRule(
    `${namePrefix}-janitor-schedule`,
    {
      name: `${namePrefix}-janitor-schedule`,
      scheduleExpression: "cron(17 3 * * ? *)",
      state: janitorEnabled ? "ENABLED" : "DISABLED",
    },
  );

  new aws.cloudwatch.EventTarget(`${namePrefix}-janitor-target`, {
    rule: janitorSchedule.name,
    arn: janitor.arn,
  });

  new aws.lambda.Permission(`${namePrefix}-janitor-event-perm`, {
    action: "lambda:InvokeFunction",
    function: janitor.name,
    principal: "events.amazonaws.com",
    sourceArn: janitorSchedule.arn,
  });

  return { api, compactor, janitor, snapshotPurge, apiLogGroup };
}

/**
 * Creates the probe Lambda, its schedule, log group and role. Separate from `createLambdas()` because
 * its `API_ENDPOINT` is the CloudFront domain, which exists only after the edge is built.
 *
 * @param probeApiEndpoint `https://<dist>.cloudfront.net`; it must hit CloudFront, which injects the
 *   X-Origin-Verify header the edge-auth middleware requires
 */
export function createProbeLambda(opts: {
  readonly namePrefix: string;
  readonly stack: string;
  readonly probeApiEndpoint: pulumi.Output<string>;
  readonly logRetentionDays: number;
  /** Permissions boundary for the probe role. */
  readonly permissionsBoundaryArn?: string;
}): ProbeLambdaOutputs {
  const {
    namePrefix,
    stack,
    probeApiEndpoint,
    logRetentionDays,
    permissionsBoundaryArn,
  } = opts;

  const probeRole = createProbeRole(namePrefix, permissionsBoundaryArn);

  const probe = new aws.lambda.Function(`${namePrefix}-probe`, {
    name: `${namePrefix}-probe`,
    runtime: aws.lambda.Runtime.NodeJS24dX,
    architectures: ["arm64"],
    role: probeRole.arn,
    handler: "health-check-probe-lambda.handler",
    code: lambdaCode("api"),
    memorySize: 128,
    timeout: 30,
    environment: {
      variables: {
        NODE_ENV: "production",
        STACK: stack,
        API_ENDPOINT: probeApiEndpoint,
      },
    },
    loggingConfig: {
      logFormat: "JSON",
      applicationLogLevel: "INFO",
    },
  });

  const probeLogGroup = new aws.cloudwatch.LogGroup(`${namePrefix}-probe-logs`, {
    name: pulumi.interpolate`/aws/lambda/${probe.name}`,
    retentionInDays: logRetentionDays,
  });

  // DISABLED on both stacks: it was the largest consumer of the shared Lambda concurrency quota.
  // Everything else stays, so re-enabling is one word.
  const probeSchedule = new aws.cloudwatch.EventRule(
    `${namePrefix}-probe-schedule`,
    {
      name: `${namePrefix}-probe-schedule`,
      scheduleExpression: "rate(5 minutes)",
      state: "DISABLED",
    },
  );

  new aws.cloudwatch.EventTarget(`${namePrefix}-probe-target`, {
    rule: probeSchedule.name,
    arn: probe.arn,
  });

  new aws.lambda.Permission(`${namePrefix}-probe-event-perm`, {
    action: "lambda:InvokeFunction",
    function: probe.name,
    principal: "events.amazonaws.com",
    sourceArn: probeSchedule.arn,
  });

  return { lambda: probe, logGroup: probeLogGroup };
}
