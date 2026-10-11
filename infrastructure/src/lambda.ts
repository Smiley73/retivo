// The six Lambda functions (api, compactor, janitor, snapshot-purge, plus the
// probe and signup-cascade):
//   - api: handles every /api/v1/* request behind API Gateway. Wraps
//     the NestJS app from apps/api via @codegenie/serverless-express.
//   - compactor: EventBridge-driven snapshot compaction, cadence stack-
//     dependent (prod `cron(41 * * * ? *)` — hourly, offset off the hour;
//     dev `rate(6 hours)` — no schedule can drift onto another after a
//     redeploy). Reuses the same bundle as the api Lambda but invokes a
//     different handler entry (`compactor-lambda.handler`) that boots
//     only CompactorModule and runs CompactorService.runOnce().
//   - janitor: daily EventBridge-driven snapshot retention sweep, fixed
//     `cron(17 3 * * ? *)` on both stacks (a cron, not a rate, so a
//     redeploy can never shift the invocation time). Same bundle, handler
//     `janitor-lambda.handler`. Deletes snapshots older than
//     SNAPSHOT_MIN_AGE_DAYS while always keeping at least
//     SNAPSHOT_MIN_KEEP per household.
//   - snapshot-purge: synchronous, api-invoked (RequestResponse) during
//     the `DELETE /auth/account` cascade. Same bundle, handler
//     `account-snapshot-purge-lambda.handler`. Deletes every snapshot
//     under `${householdId}/`. Least-privilege role (S3 list+delete
//     only) isolates the bulk delete out of the api role. Invoked only
//     on account deletion (rare) — effectively $0/mo at personal scale.
//   - probe: health-check probe. Standalone (no NestJS) handler
//     `health-check-probe-lambda.handler` that fetches the public
//     CloudFront /health endpoint and emits a HealthCheckStatus EMF
//     metric. Its EventBridge rule (`rate(5 minutes)`) is DISABLED on
//     both stacks — the probe was the largest scheduled consumer of the
//     account's shared Lambda concurrency quota; the Lambda, role, log
//     group, and stack export all stay so re-enabling is one word.
//     Created by the separate createProbeLambda() (after CloudFront so
//     API_ENDPOINT is available).
//   - signup-cascade: stream-triggered (not scheduled) reaper for the
//     owner-approval TTL cascade. Created separately in
//     signup-cascade.ts; see that file's header.
//
// All six: arm64 (Graviton, cheaper at the same memory), Node 24.x
// runtime, per-function least-privilege role from ./iam.ts.
//
// The deployable artifact is produced by `pnpm --filter @retirement/api
// build:lambda` (apps/api/scripts/build-lambda.mjs). It writes a flat
// node_modules layout to `apps/api/build/lambda/` which we point at
// via FileArchive. If the directory is missing we fall back to the
// pre-existing lambda shells so a fresh `pulumi preview` doesn't error
// out on a clean checkout.

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
  /**
   * Owner/approver inbox (`retivo:approverEmail`) → api APPROVER_EMAIL.
   * Omitted from the env when unset so the api keeps its local-dev fallback.
   */
  readonly approverEmail: string | undefined;
  /** When false, the compactor EventBridge schedule is created but disabled. */
  readonly compactorEnabled: boolean;
  /** When false, the janitor EventBridge schedule is created but disabled. */
  readonly janitorEnabled: boolean;
  /**
   * Enforced-MFA master switch (sourced from `retivo:authMfaEnforced`,
   * optional, defaults true). Sets the api Lambda's AUTH_MFA_ENFORCED env var;
   * false disables enforcement without a code change (the rollback kill-switch).
   */
  readonly authMfaEnforced: boolean;
  /** Minimum number of snapshots per household the janitor must keep, regardless of age. */
  readonly snapshotMinKeep: number;
  /** Snapshots older than this are eligible for janitor deletion (subject to the floor). */
  readonly snapshotMinAgeDays: number;
  /**
   * Cost-control knob (sourced from `retivo:logRetentionDays`):
   * CloudWatch Logs retention in days applied to every Lambda log group
   * owned here (api, compactor, snapshot-purge, janitor). Validated against
   * the AWS retention enum in config.ts. Dev example=7, prod=90.
   */
  readonly logRetentionDays: number;
}

export interface Lambdas {
  readonly api: aws.lambda.Function;
  readonly compactor: aws.lambda.Function;
  readonly janitor: aws.lambda.Function;
  readonly snapshotPurge: aws.lambda.Function;
  readonly apiLogGroup: aws.cloudwatch.LogGroup;
}

/**
 * Probe Lambda + its log group, returned by `createProbeLambda()` so the
 * monitoring module can reference the function's native Errors metric and the
 * log group that carries the HealthCheckStatus EMF metric.
 */
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

/**
 * Returns the deployable artifact for the api/compactor/janitor Lambdas.
 * Delegates to the shared `resolveLambdaArtifact()` (lambda-artifact.ts) so the
 * fail-closed invariant is enforced identically for every handler: the bundled
 * apps/api build is used only when ALL six deployed handler files are present
 * (not just `lambda.js`); during `pulumi preview` only, it falls back to the
 * placeholder shell so a fresh checkout that hasn't run `build:lambda` can still
 * preview; on a real `pulumi up` with the artifact incomplete it throws instead
 * of silently deploying a non-functional shell.
 */
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

  // Environment variables: table names + bucket name + web origin +
  // STACK so the cold-start SSM bootstrap can build the parameter path.
  // The api Lambda discovers everything it needs through these — we
  // never hard-code resource names in handler code. AUTH_JWT_SIGNING_KEYS
  // and SES_FROM_ADDRESS are *not* passed via env: the cold-start
  // bootstrap fetches them from SSM Parameter Store via the api role's
  // narrow GetParameter policy.
  // BUILD_ID is the deploy fingerprint the SPA + API both publish so
  // the client can detect a new version (X-Build-Id response header
  // → "new version available" banner). bootstrap-stack.sh derives one
  // and passes it through `process.env.BUILD_ID` to both the SPA build
  // (`VITE_BUILD_ID`) and `pulumi up`. If unset (someone ran `pulumi
  // up` directly), fall back to `dev` — the SPA detector treats `dev`
  // as "never mismatch", so the banner just stays quiet. A real cloud
  // deploy must go through bootstrap-stack.sh / deploy-stack.sh so
  // BUILD_ID carries a git fingerprint — never a bare `pulumi up`.
  const buildId = process.env.BUILD_ID ?? "dev";

  // The "Dev shortcut: verify now"
  // / "Dev shortcut: approve" links are LOCAL-DEVELOPMENT ONLY: no
  // deployed stack — dev included — echoes a raw verification, approval,
  // reset, or change-email token in an API response. Explicit 'false' on
  // every stack so the env validation guard in env.config.ts has nothing
  // to refuse, and the boundary is visible in this file rather than
  // relying on a per-stack env-default accident.
  const exposeVerificationToken = "false";

  const apiEnv: pulumi.Input<{ [key: string]: pulumi.Input<string> }> = {
    NODE_ENV: "production",
    STACK: stack,
    BUILD_ID: buildId,
    WEB_ORIGIN: webOrigin,
    ...(approverEmail ? { APPROVER_EMAIL: approverEmail } : {}),
    EXPOSE_VERIFICATION_TOKEN: exposeVerificationToken,
    // Per-stack JWT token-domain claims. Every RS256 token the api signs — access, MFA challenge, data-export
    // authorization — embeds and strictly verifies these `iss`/`aud` claims, so
    // key material can never be replayed across a token-confusion boundary
    // between stacks/services. Stack-scoped values (`retivo-api/<stack>` /
    // `retivo-web/<stack>`) keep dev and prod tokens mutually invalid; the
    // env.config.ts defaults cover local `pnpm dev` only.
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
    // Enforced second-factor (MFA) tables.
    TABLE_USER_MFA: tables.userMfa.name,
    TABLE_MFA_EMAIL_OTP: tables.mfaEmailOtp.name,
    TABLE_TRUSTED_DEVICE: tables.trustedDevice.name,
    // Shared, single-use WebAuthn challenge storage.
    TABLE_PASSKEY_CHALLENGE: tables.passkeyChallenge.name,
    // AUTH_MFA_ENFORCED comes from the `retivo:authMfaEnforced` stack
    // config key (optional, defaults true — see config.ts): a password login
    // on a new/untrusted device returns an MFA challenge instead of a session.
    // Email OTP guarantees universal day-one coverage so default-ON is
    // lockout-safe. Set `retivo:authMfaEnforced: "false"` in
    // `Pulumi.<stack>.yaml` to roll enforcement back without a code change (the
    // permanent operational kill-switch — tables stay intact), not a temporary
    // launch flag. The code default in env.config.ts stays 'false' so local
    // `pnpm dev` (no env var) is password-only; the deployed-stack value comes
    // from this config key.
    AUTH_MFA_ENFORCED: authMfaEnforced ? "true" : "false",
    SNAPSHOTS_BUCKET: snapshotsBucketName,
    // The DELETE /auth/account cascade invokes this Lambda synchronously
    // to purge the household's S3 snapshots (the api role no longer holds
    // bucket-wide delete). Static name pattern — also the IAM invoke ARN
    // in iam.ts and the function name below.
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
    // 30s is the API Gateway sync limit; matching here keeps timing
    // predictable end-to-end. The Lambda hard limit is 15min if we ever
    // need an async path.
    timeout: 30,
    environment: { variables: apiEnv },
    loggingConfig: {
      logFormat: "JSON",
      applicationLogLevel: "INFO",
    },
  });

  // Stack-configured retention (retivo:logRetentionDays).
  // Dev example=7, prod=90 (NIST SP 800-53 AU-11
  // financial-data recommendation). Applied uniformly to every log group.
  const apiLogGroup = new aws.cloudwatch.LogGroup(`${namePrefix}-api-logs`, {
    name: pulumi.interpolate`/aws/lambda/${api.name}`,
    retentionInDays: logRetentionDays,
  });

  // Compactor only touches sync tables + the snapshots bucket. The auth
  // table envs are unset here so even if the artifact accidentally
  // imported an auth provider it would fail-closed during validation.
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
    // Compactor is replay-bound; 5 min is enough headroom for huge histories.
    timeout: 300,
    environment: { variables: compactorEnv },
    loggingConfig: {
      logFormat: "JSON",
      applicationLogLevel: "INFO",
    },
  });

  // Same stack-configured retention as the api log group.
  new aws.cloudwatch.LogGroup(`${namePrefix}-compactor-logs`, {
    name: pulumi.interpolate`/aws/lambda/${compactor.name}`,
    retentionInDays: logRetentionDays,
  });

  // Account-deletion snapshot-purge Lambda. Same bundle as the api
  // (build-lambda.mjs copies all of dist/, so
  // account-snapshot-purge-lambda.js ships automatically); the handler
  // entry differs. Name MUST stay `${namePrefix}-snapshot-purge` — the
  // api role's lambda:InvokeFunction ARN in iam.ts is derived from this
  // exact pattern. Only the bucket name in env; the role grants S3
  // list+delete on the snapshots bucket only.
  const snapshotPurge = new aws.lambda.Function(`${namePrefix}-snapshot-purge`, {
    name: `${namePrefix}-snapshot-purge`,
    runtime: aws.lambda.Runtime.NodeJS24dX,
    architectures: ["arm64"],
    role: roles.snapshotPurge.arn,
    handler: "account-snapshot-purge-lambda.handler",
    code: lambdaCode("api"),
    memorySize: 512,
    // Dominated by S3 ListObjectsV2 paging at single-household scale;
    // 60s is ample and keeps the synchronous api invoke well inside its
    // own 25s request timeout for any realistic snapshot count.
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

  // Cadence differs by stack (account-wide Lambda concurrency headroom):
  // prod anchors to a fixed cron minute (`cron(41 * * * ? *)`, still
  // hourly) rather than `rate(1 hour)` so a redeploy — which recreates
  // this rule — can never drift the invocation minute onto another
  // scheduled job's; dev, which does not need prod's compaction latency,
  // runs every 6 hours (`rate(6 hours)`) to cut its share of the shared
  // quota. index.ts enables the schedule on both stacks; the
  // `compactorEnabled` option remains so it can be switched off.
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

  // Janitor only needs the bucket name + the two retention knobs. No
  // DynamoDB tables are referenced here — its IAM role doesn't grant
  // any DynamoDB action, so even if the bundle accidentally imported
  // the dynamo module the AWS SDK would reject the call.
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
    // Janitor work is dominated by S3 ListObjectsV2 paging; 5 min is
    // overkill at single-household scale but cheap insurance for
    // future fan-out.
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

  // Daily EventBridge schedule, fixed at 03:17 UTC on both stacks. Snapshot
  // retention doesn't need to be synchronous with compaction — once a day
  // is plenty for a 90-day age cutoff. A fixed cron (not `rate(1 day)`) so
  // a redeploy — which recreates this rule — can never drift the
  // invocation time onto another scheduled job's. The flag lets prod come
  // up with the schedule disabled the first time around (mirror of
  // compactorEnabled).
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
 * Creates the health-check probe Lambda + its EventBridge schedule, log
 * group, and least-privilege role. Built SEPARATELY from
 * `createLambdas()` because the probe needs the CloudFront distribution
 * domain as its `API_ENDPOINT`, which only exists after `createEdge()`
 * — so `infrastructure/index.ts` calls this after the edge is constructed.
 *
 * @param namePrefix stack-scoped resource-name prefix
 * @param stack the Pulumi stack name (for the HealthCheck EMF namespace)
 * @param probeApiEndpoint `https://<dist>.cloudfront.net` — CloudFront always
 *   injects the X-Origin-Verify header the edge-auth middleware requires, so
 *   the probe must hit the distribution domain, not the raw API GW host
 * @param logRetentionDays stack-configured CloudWatch Logs retention
 */
export function createProbeLambda(opts: {
  readonly namePrefix: string;
  readonly stack: string;
  readonly probeApiEndpoint: pulumi.Output<string>;
  readonly logRetentionDays: number;
  /** Optional permissions boundary for the probe role (see iam.ts). */
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
    // A single bounded HTTPS fetch + EMF emit; 30s is ample even on a cold
    // start, and stays well inside the EventBridge invocation budget.
    timeout: 30,
    environment: {
      variables: {
        NODE_ENV: "production",
        STACK: stack,
        // The CloudFront distribution domain. The handler appends
        // `/api/v1/health`.
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

  // DISABLED on both stacks: the probe was the largest scheduled consumer
  // of the account's shared Lambda concurrency quota (288 invocations/day
  // per stack) and its alarm + dashboard widget are gone. The rule, the
  // Lambda, its role, its log group, and the `probeLambda` stack export all
  // stay so re-enabling is a one-word change back to "ENABLED".
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
