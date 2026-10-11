// Least-privilege IAM roles (the role scopes are also listed in AGENTS.md →
// "Project-specific security"):
//   - api-lambda-role: per-table actions on every named table; s3
//     GetObject on snapshot objects (read) + PutObject on snapshot
//     objects (RestoreService mints a fresh restored snapshot at a
//     current timestamp so the janitor's newest-N retention never
//     deletes the live WorkspaceMeta pointer) +
//     GetBucketLocation on the bucket (the /health/dependencies liveness
//     probe) + bucket-wide ListBucket (the GET /sync/snapshots
//     self-service restore listing — SnapshotsService.list enforces the
//     per-household `${householdId}/` prefix at the code layer, so the
//     bucket-level grant cannot enumerate cross-household; IAM cannot scope
//     ListBucket to a per-caller prefix) — bucket-wide DeleteObject stays
//     withheld (PutObject is object-scoped only; the account-deletion
//     bulk purge stays in the dedicated snapshot-purge Lambda);
//     lambda:InvokeFunction on the
//     snapshot-purge Lambda only; ssm:GetParameter on auth/edge/SES
//     paths; ses:SendEmail. BatchWriteItem on MutationLog,
//     IdempotencyKey, AggregateVersion, DeviceRegistry is allowed only
//     for the shared household-data sweep (HouseholdSweepService)
//     used by `DELETE /auth/account`,
//     `POST /auth/encrypted-workspace-reset`, and
//     `POST /sync/restore` (RestoreService) — no
//     other endpoint may use it. GetItem/PutItem/Query/UpdateItem/DeleteItem
//     on HouseholdKeyEnvelope (zero-knowledge key slots) —
//     api role ONLY; the compactor must not see wrapped key material.
//     Point-ops (Get/Put/Update/Delete) on UserMfa + MfaEmailOtp, and the
//     same point-ops PLUS Query on TrustedDevice (enforced MFA) —
//     api role ONLY (compactor/janitor get none of the MFA
//     tables), mirroring the HouseholdKeyEnvelope isolation boundary; no
//     Scan and no BatchWriteItem on any MFA table (there is no
//     `TransactWriteItems` IAM action to withhold; a transaction would
//     ride the per-item actions above). NO dynamodb:* blanket.
//   - compactor-lambda-role: Query + BatchWriteItem on MutationLog;
//     GetItem + UpdateItem on WorkspaceMeta; GetObject + PutObject on
//     snapshots. NO access to any auth table.
//   - janitor-lambda-role: ListBucket + DeleteObject on snapshots only.
//     No DynamoDB / SSM / SES. The janitor only enforces snapshot
//     retention — it never reads or writes the sync tables.
//   - snapshot-purge-lambda-role: ListBucket + DeleteObject on snapshots
//     only (mirrors janitor). Used by the dedicated account-deletion
//     snapshot-purge Lambda — the only path that bulk-deletes a
//     household's S3 snapshots, isolated out of the api role.
//   - probe-lambda-role: basic Lambda execution + logs only. The
//     health-check probe makes an outbound HTTPS fetch to the public
//     CloudFront /health endpoint and emits an EMF metric to stdout — it
//     touches no DynamoDB, S3, SSM, or SES.
//   - backup-role: AWS Backup SERVICE role (assumed by backup.amazonaws.com)
//     for the immutable vault. Backup-only managed policies; no
//     backup:Delete*/Disable* so it cannot weaken the GOVERNANCE Vault Lock.
//   - backup-restore-role: SEPARATE restore-only role, assumed only
//     during a restore drill/incident. Restore-only managed policies; also no
//     backup:Delete*/Disable*. Both roles are created UNCONDITIONALLY on every
//     stack (createRoles runs from index.ts regardless of enableBackups) but
//     are inert/unused on a stack without a Backup Plan (enableBackups=false) —
//     only the vault/plan/selection/RegionSettings/alarms are prod-gated. No
//     EXISTING role gains AWS Backup delete/bypass.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { Tables } from "./dynamo";

interface IamOpts {
  readonly namePrefix: string;
  readonly tables: Tables;
  readonly snapshotsBucketArn: pulumi.Output<string>;
  readonly ssmParameterArns: pulumi.Output<string[]>;
  /**
   * Optional permissions-boundary ARN stamped on every role here. For accounts
   * whose policy requires every created role to carry a boundary; unset by
   * default.
   */
  readonly permissionsBoundaryArn?: string;
}

export interface Roles {
  readonly api: aws.iam.Role;
  readonly compactor: aws.iam.Role;
  readonly janitor: aws.iam.Role;
  readonly snapshotPurge: aws.iam.Role;
  /** AWS Backup service role — backup-only managed policies. */
  readonly backup: aws.iam.Role;
  /** AWS Backup restore role — restore-only, assumed during a drill/incident. */
  readonly backupRestore: aws.iam.Role;
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

// AWS Backup service principal assume-role doc. The shared
// lambdaAssumeRolePolicy above hardcodes lambda.amazonaws.com and cannot be
// reused for the backup + restore roles.
const backupAssumeRolePolicy = aws.iam.getPolicyDocumentOutput({
  statements: [
    {
      effect: "Allow",
      principals: [{ type: "Service", identifiers: ["backup.amazonaws.com"] }],
      actions: ["sts:AssumeRole"],
    },
  ],
});

export function createRoles(opts: IamOpts): Roles {
  const {
    namePrefix,
    tables,
    snapshotsBucketArn,
    ssmParameterArns,
    permissionsBoundaryArn,
  } = opts;

  // Used to build the AWS-managed SSM KMS alias ARN for the api role's
  // `kms:Decrypt` statement. Fetching the caller
  // identity is a control-plane STS call resolved once at preview/up time.
  const callerIdentity = aws.getCallerIdentityOutput({});

  // ---------------------------------------------------------------- api role
  const apiRole = new aws.iam.Role(`${namePrefix}-api-role`, {
    name: `${namePrefix}-api-role`,
    assumeRolePolicy: lambdaAssumeRolePolicy.json,
    permissionsBoundary: permissionsBoundaryArn,
    description:
      "Runtime role for the api Lambda. Per-table actions; BatchWriteItem on MutationLog/IdempotencyKey/AggregateVersion/DeviceRegistry is scoped to the shared household-data sweep (HouseholdSweepService) used by DELETE /auth/account, POST /auth/encrypted-workspace-reset, and POST /sync/restore (RestoreService).",
  });

  // CloudWatch Logs.
  new aws.iam.RolePolicyAttachment(`${namePrefix}-api-logs`, {
    role: apiRole.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  });

  // Per-table actions for tables the api Lambda may write to.
  // Explicit enumeration — no `*` resources, no `dynamodb:*`.
  const apiTableArns: pulumi.Output<string>[] = [
    tables.workspaceMeta.arn,
    tables.mutationLog.arn, // intentionally no BatchWriteItem here
    tables.aggregateVersion.arn,
    tables.idempotencyKey.arn,
    tables.deviceRegistry.arn,
    tables.user.arn,
    tables.emailReservation.arn,
    tables.emailVerification.arn,
    tables.passwordReset.arn, // CRUD; no Scan grant — the reset deletes by currentResetToken
    tables.credential.arn,
    tables.passkey.arn,
    tables.refreshToken.arn,
    tables.revokedToken.arn,
    tables.failedLoginAttempt.arn,
    tables.authEvent.arn,
    tables.signupApproval.arn,
  ];

  // The User table's GSI also needs its ARN listed (DynamoDB requires this
  // separately from the base table for Query-on-GSI).
  const apiGsiArns: pulumi.Output<string>[] = [
    pulumi.interpolate`${tables.user.arn}/index/EmailIndex`,
    // RevokedToken's `UserIndex`: a Query-on-GSI read reaching a user's own
    // revoked/denylisted-token rows for the account export. It adds no new
    // action name to the api policy.
    pulumi.interpolate`${tables.revokedToken.arn}/index/UserIndex`,
  ];

  const apiPolicyDocument = aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        sid: "DynamoTableActions",
        effect: "Allow",
        // No `dynamodb:TransactWriteItems` / `TransactGetItems` action is
        // granted or needed: AWS's service-authorization catalog has no
        // such action — a DynamoDB transaction is authorized by the real
        // per-item operations below (Put/Update/Delete/ConditionCheck), which
        // this statement already grants. The former inert strings were removed
        // with no change to effective permissions.
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:ConditionCheckItem",
          // Read-only metadata: the /health endpoint runs DescribeTable
          // against the User table to verify reachability. Cheap, scoped
          // to the same resources as the data-plane actions.
          "dynamodb:DescribeTable",
        ],
        resources: pulumi.all([...apiTableArns, ...apiGsiArns]).apply((arns) => arns),
      },
      {
        // Scan is intentionally narrowed so a
        // compromised dependency cannot enumerate the credential, refresh,
        // revoked, or passkey tables. The four tables below are the only
        // legitimate Scan callers:
        //   - User: UsersRepository.hasAnyUser (setup-status redirect).
        //   - IdempotencyKey: shared household-data sweep (account deletion +
        //     encrypted-workspace reset), via HouseholdSweepService — no GSI
        //     on householdId.
        //   - EmailVerification, SignupApproval: account-deletion auth-state
        //     sweep only (DeleteAccountService.sweepAuthState; the
        //     encrypted-workspace reset never touches these — it only calls
        //     HouseholdSweepService.revokeAllSessions + .sweepHouseholdData).
        sid: "ScanLimitedTables",
        effect: "Allow",
        actions: ["dynamodb:Scan"],
        resources: [
          tables.user.arn,
          tables.emailVerification.arn,
          tables.idempotencyKey.arn,
          tables.signupApproval.arn,
        ],
      },
      {
        // Scoped to the shared household-data sweep (HouseholdSweepService)
        // — the audited sync-row sweep that serves
        // `DELETE /auth/account`, `POST /auth/encrypted-workspace-reset`,
        // and `POST /sync/restore` (RestoreService — the self-service
        // snapshot restore, the third authorised consumer). DeviceRegistry
        // is included because `sweepHouseholdData` calls
        // `DeviceRegistryRepository.deleteAllForHousehold` (a BatchWriteItem)
        // from these flows. See AGENTS.md → "Project-specific security" (IAM scoping).
        // Adding BatchWriteItem on any other table or invoking it from any
        // other code path needs an explicit scope-change proposal.
        sid: "HouseholdSweepBatchWrites",
        effect: "Allow",
        actions: ["dynamodb:BatchWriteItem"],
        resources: [
          tables.mutationLog.arn,
          tables.idempotencyKey.arn,
          tables.aggregateVersion.arn,
          tables.deviceRegistry.arn,
        ],
      },
      {
        // Zero-knowledge key envelopes. Granted to the api
        // role ONLY — the compactor role must never touch this table so
        // wrapped key material stays outside the snapshot-compaction
        // privilege boundary. Narrow action set (no BatchWriteItem, no Scan).
        // The controller applies the slot write + the envelope-set meta
        // bump as ONE atomic single-table `TransactWriteItems`; that
        // transaction adds NO IAM action — it is authorized by the per-item
        // `PutItem`/`UpdateItem`/`DeleteItem` actions below (there is no
        // `dynamodb:TransactWriteItems` action to grant). It also does point
        // reads/writes + a Query by householdId; the deleteAllForHousehold
        // sweep deliberately Query-then-individual-DeleteItem loops
        // (NOT BatchWriteItem) so it stays inside this grant — no widening.
        // `dynamodb:ConditionCheckItem`:
        // the credential-only change-password commit for a server-confirmed
        // no-slot household asserts, as a ConditionCheck INSIDE that same
        // transaction, that no `password`-type row exists at the canonical
        // slot id on this table — never as a preceding read (the household
        // could otherwise acquire a slot between the check and the write).
        // Strictly weaker than the GetItem/PutItem this statement already
        // grants on the same table; it authorizes no new read or write.
        sid: "HouseholdKeyEnvelopeActions",
        effect: "Allow",
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:ConditionCheckItem",
        ],
        resources: [tables.householdKeyEnvelope.arn],
      },
      {
        // Enforced second-factor (MFA) — UserMfa (TOTP enrollment state) and
        // MfaEmailOtp (live code hash). Granted to the api role
        // ONLY (compactor/janitor never see MFA secrets) — the same
        // isolation boundary as HouseholdKeyEnvelope. Narrow
        // POINT-OPS only: GetItem/PutItem/UpdateItem/DeleteItem. NO Query, NO
        // Scan, NO BatchWriteItem — every access on these two tables is keyed
        // by userId, and the account-deletion cascade deletes by userId (a
        // keyed delete). NOT added to apiTableArns above precisely to keep
        // Query (and BatchWriteItem/Scan) off these secret tables. There is no
        // `TransactWriteItems` IAM action to withhold: a transaction, if
        // one were ever added, would be authorized by the per-item actions
        // above — so the real boundary here is this narrow point-ops set plus
        // api-role-only access, NOT the absence of a nonexistent grant.
        // See AGENTS.md → "Project-specific security" (IAM scoping).
        sid: "MfaSecretPointOps",
        effect: "Allow",
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
        ],
        resources: [tables.userMfa.arn, tables.mfaEmailOtp.arn],
      },
      {
        // Enforced second-factor (MFA) — TrustedDevice (per-device MFA-skip
        // trust, PK userId + SK deviceId). Granted to the api role ONLY. Same
        // point-ops as MfaSecretPointOps PLUS dynamodb:Query — listByUser and
        // the account-deletion cascade Query by the userId PK to enumerate /
        // delete every SK row under a user (the "manage trusted devices"
        // listing + the cascade). NO Scan, NO BatchWriteItem (and no
        // `TransactWriteItems` IAM action exists to grant or withhold).
        // See AGENTS.md → "Project-specific security" (IAM scoping).
        sid: "TrustedDevicePointOpsAndQuery",
        effect: "Allow",
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
        ],
        resources: [tables.trustedDevice.arn],
      },
      {
        // Shared, single-use WebAuthn challenge storage PLUS the shared
        // request-throttle counter (same table, distinct `key` namespace, no
        // new billable resource). Granted to the api role
        // ONLY — same isolation boundary as HouseholdKeyEnvelope/
        // MfaSecretPointOps (compactor/janitor get none of it).
        // The passkey-challenge repository issues `PutItem` (issue/
        // overwrite) and `DeleteItem` with `ReturnValues: ALL_OLD` (the
        // atomic single-use consume — one item-level op, not a
        // read-then-delete pair). `UpdateItem` was added for the throttle
        // counter's atomic `ADD`/window-reset increment (see
        // `ThrottleCounterRepository`) — a deliberate widening of the
        // challenge-store-only grant, not implicitly reused from another code
        // path (AGENTS.md). Still NO `GetItem` (neither repository has a
        // separate read path), NO `Query`, NO `Scan`, NO `BatchWriteItem` —
        // every access on both namespaces is a keyed point-op on `key`. See
        // AGENTS.md → "Project-specific security" (IAM scoping).
        sid: "PasskeyChallengeAndThrottleCounter",
        effect: "Allow",
        actions: ["dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem"],
        resources: [tables.passkeyChallenge.arn],
      },
      {
        sid: "S3SnapshotsRead",
        effect: "Allow",
        // GetObject reads snapshot bytes (sync bootstrap + pull + the
        // self-service restore fetch), scoped to objects under the
        // bucket. ListBucket backs `GET /sync/snapshots`
        // (SnapshotsService.list) — the self-service restore listing. The
        // snapshot-bucket list grant is deliberately BUCKET-LEVEL
        // (resource = the bucket ARN); it CANNOT be narrowed to a
        // household prefix via an `s3:prefix` Condition because the
        // prefix is dynamic per caller (the authenticated householdId),
        // so household isolation is enforced at the code layer instead —
        // SnapshotsService.list always passes `Prefix: ${householdId}/`
        // to ListObjectsV2. Bucket-wide DeleteObject stays withheld: the
        // account-deletion bulk purge runs in the dedicated
        // snapshot-purge Lambda (see snapshot-purge role below + the
        // InvokeSnapshotPurge statement).
        actions: ["s3:GetObject", "s3:ListBucket"],
        resources: [
          snapshotsBucketArn,
          pulumi.interpolate`${snapshotsBucketArn}/*`,
        ],
      },
      {
        sid: "S3SnapshotsWrite",
        effect: "Allow",
        // PutObject lets RestoreService (POST /sync/restore) MINT a fresh
        // restored snapshot at the current timestamp so the daily
        // janitor's newest-N retention always protects the live
        // WorkspaceMeta pointer (pointing at an old chosen key
        // let the janitor delete the object the workspace pointed at).
        // Scoped to the bucket-OBJECTS ARN (`/*`) only, NOT the bucket
        // ARN — it grants object writes, never bucket-level operations.
        // This does NOT add s3:DeleteObject: the account-deletion bulk
        // purge stays delegated to the dedicated snapshot-purge Lambda.
        actions: ["s3:PutObject"],
        resources: [pulumi.interpolate`${snapshotsBucketArn}/*`],
      },
      {
        sid: "S3SnapshotsLocation",
        effect: "Allow",
        // Bucket-level metadata read for the /health/dependencies
        // liveness probe (GetBucketLocation — proves bucket reachable +
        // credentials valid). Strictly narrower than ListBucket: it
        // cannot enumerate or read objects, so it does not reintroduce
        // ListBucket or DeleteObject. Resource is the bucket ARN itself
        // (no `/*`), as GetBucketLocation acts on the bucket.
        actions: ["s3:GetBucketLocation"],
        resources: [snapshotsBucketArn],
      },
      {
        // The api role invokes ONLY the account-deletion snapshot-purge
        // Lambda, synchronously (RequestResponse). Scoped to that single
        // function ARN — derived from the stack name pattern to avoid a
        // role↔lambda dependency cycle (the Lambda is created after the
        // roles). See AGENTS.md → "Project-specific security" (IAM scoping).
        sid: "InvokeSnapshotPurge",
        effect: "Allow",
        actions: ["lambda:InvokeFunction"],
        resources: [
          pulumi.interpolate`arn:aws:lambda:${aws.config.region}:${callerIdentity.accountId}:function:${namePrefix}-snapshot-purge`,
        ],
      },
      {
        sid: "SsmParameterRead",
        effect: "Allow",
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: ssmParameterArns,
      },
      {
        // Scoped to the AWS-managed SSM key alias in this account/region
        // The alias resolves to the per-account
        // `aws/ssm` KMS key, which is what SecureString parameters are
        // encrypted with by default. The `kms:ViaService` condition is
        // kept as defence-in-depth so the grant only fires when SSM is
        // the calling service.
        sid: "KmsForSsm",
        effect: "Allow",
        actions: ["kms:Decrypt"],
        resources: [
          pulumi.interpolate`arn:aws:kms:${aws.config.region}:${callerIdentity.accountId}:alias/aws/ssm`,
        ],
        conditions: [
          {
            test: "StringEquals",
            variable: "kms:ViaService",
            values: [pulumi.interpolate`ssm.${aws.config.region}.amazonaws.com`],
          },
        ],
      },
      {
        // The api only calls SendEmailCommand. SendRawEmail
        // is intentionally withheld so a compromised
        // Lambda cannot craft arbitrary MIME messages from the verified
        // SES domain.
        sid: "SesSendVerification",
        effect: "Allow",
        actions: ["ses:SendEmail"],
        resources: ["*"], // SES doesn't support resource-level policies for SendEmail.
      },
    ],
  });

  new aws.iam.RolePolicy(`${namePrefix}-api-policy`, {
    role: apiRole.id,
    policy: apiPolicyDocument.json,
  });

  // ---------------------------------------------------------- compactor role
  const compactorRole = new aws.iam.Role(`${namePrefix}-compactor-role`, {
    name: `${namePrefix}-compactor-role`,
    assumeRolePolicy: lambdaAssumeRolePolicy.json,
    permissionsBoundary: permissionsBoundaryArn,
    description:
      "Runtime role for the compactor Lambda. MutationLog Query+BatchWriteItem, WorkspaceMeta read+update, S3 snapshots read+write. No auth-table access.",
  });

  new aws.iam.RolePolicyAttachment(`${namePrefix}-compactor-logs`, {
    role: compactorRole.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  });

  const compactorPolicyDocument = aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        sid: "MutationLogScan",
        effect: "Allow",
        actions: [
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:BatchWriteItem",
          "dynamodb:DeleteItem",
        ],
        resources: [tables.mutationLog.arn],
      },
      {
        sid: "WorkspaceMetaCheckpoint",
        effect: "Allow",
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Scan",
        ],
        resources: [tables.workspaceMeta.arn],
      },
      {
        sid: "S3Snapshots",
        effect: "Allow",
        actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
        resources: [
          snapshotsBucketArn,
          pulumi.interpolate`${snapshotsBucketArn}/*`,
        ],
      },
    ],
  });

  new aws.iam.RolePolicy(`${namePrefix}-compactor-policy`, {
    role: compactorRole.id,
    policy: compactorPolicyDocument.json,
  });

  // ------------------------------------------------------------ janitor role
  // The janitor enforces snapshot retention: list everything in the
  // snapshots bucket, group by `<householdId>/` prefix, delete the
  // ones past the configurable age + count thresholds. Deliberately
  // narrower than the compactor role — no DynamoDB, no SSM, no
  // PutObject. If a future feature needs the janitor to read snapshot
  // contents (e.g. integrity checks), add `s3:GetObject` explicitly
  // and document the reason here.
  const janitorRole = new aws.iam.Role(`${namePrefix}-janitor-role`, {
    name: `${namePrefix}-janitor-role`,
    assumeRolePolicy: lambdaAssumeRolePolicy.json,
    permissionsBoundary: permissionsBoundaryArn,
    description:
      "Runtime role for the janitor Lambda. ListBucket + DeleteObject on the snapshots bucket. No DynamoDB / SSM / SES.",
  });

  new aws.iam.RolePolicyAttachment(`${namePrefix}-janitor-logs`, {
    role: janitorRole.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  });

  const janitorPolicyDocument = aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        sid: "S3SnapshotsListAndDelete",
        effect: "Allow",
        actions: ["s3:ListBucket", "s3:DeleteObject"],
        resources: [
          snapshotsBucketArn,
          pulumi.interpolate`${snapshotsBucketArn}/*`,
        ],
      },
    ],
  });

  new aws.iam.RolePolicy(`${namePrefix}-janitor-policy`, {
    role: janitorRole.id,
    policy: janitorPolicyDocument.json,
  });

  // ----------------------------------------------- snapshot-purge role
  // The account-deletion snapshot-purge Lambda's role. Mirrors the
  // janitor grant exactly: ListBucket + DeleteObject on the snapshots
  // bucket only — no DynamoDB, SSM, SES, or PutObject. Isolating the
  // bulk-delete here is what lets the api role drop bucket-wide delete.
  const snapshotPurgeRole = new aws.iam.Role(`${namePrefix}-snapshot-purge-role`, {
    name: `${namePrefix}-snapshot-purge-role`,
    assumeRolePolicy: lambdaAssumeRolePolicy.json,
    permissionsBoundary: permissionsBoundaryArn,
    description:
      "Runtime role for the account-deletion snapshot-purge Lambda. ListBucket + DeleteObject on the snapshots bucket. No DynamoDB / SSM / SES / PutObject.",
  });

  new aws.iam.RolePolicyAttachment(`${namePrefix}-snapshot-purge-logs`, {
    role: snapshotPurgeRole.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  });

  const snapshotPurgePolicyDocument = aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        sid: "S3SnapshotsListAndDelete",
        effect: "Allow",
        actions: ["s3:ListBucket", "s3:DeleteObject"],
        resources: [
          snapshotsBucketArn,
          pulumi.interpolate`${snapshotsBucketArn}/*`,
        ],
      },
    ],
  });

  new aws.iam.RolePolicy(`${namePrefix}-snapshot-purge-policy`, {
    role: snapshotPurgeRole.id,
    policy: snapshotPurgePolicyDocument.json,
  });

  // ----------------------------------------------------------- backup role
  // The always-on AWS Backup SERVICE role. Used by the
  // Backup Plan + Selection to copy every DynamoDB table + the S3 snapshots
  // bucket into the GOVERNANCE-locked vault. Attaches the two backup-ONLY
  // AWS-managed policies; NEITHER includes backup:Delete*/backup:Disable*, so
  // the standing role cannot weaken the vault's immutability. Assumed by
  // backup.amazonaws.com (NOT lambda). Created UNCONDITIONALLY on every stack
  // (createRoles always runs) but inert without a Backup Plan — only the
  // vault/plan/selection/alarms are prod-gated behind enableBackups.
  const backupRole = new aws.iam.Role(`${namePrefix}-backup-role`, {
    name: `${namePrefix}-backup-role`,
    assumeRolePolicy: backupAssumeRolePolicy.json,
    permissionsBoundary: permissionsBoundaryArn,
    description:
      "AWS Backup service role for the immutable vault. Backup-only managed policies (AWSBackupServiceRolePolicyForBackup + ForS3Backup); no backup:Delete/Disable, so it cannot weaken the GOVERNANCE Vault Lock.",
  });

  new aws.iam.RolePolicyAttachment(`${namePrefix}-backup-ddb`, {
    role: backupRole.name,
    policyArn:
      "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
  });

  new aws.iam.RolePolicyAttachment(`${namePrefix}-backup-s3`, {
    role: backupRole.name,
    // NOTE: the S3 backup/restore managed policies live at the policy ROOT
    // (no `service-role/` path segment), unlike the DynamoDB ones above.
    policyArn:
      "arn:aws:iam::aws:policy/AWSBackupServiceRolePolicyForS3Backup",
  });

  // --------------------------------------------------- backup-restore role
  // A SEPARATE restore role, assumed ONLY during a documented
  // restore drill or incident (not standing-on). Attaches the two restore-ONLY
  // AWS-managed policies; like the backup role, neither grants
  // backup:Delete*/backup:Disable*, so the vault's immutability stays inspectable
  // per-role. Splitting backup vs restore keeps the always-on role's blast
  // radius to backup-write only.
  const backupRestoreRole = new aws.iam.Role(`${namePrefix}-backup-restore-role`, {
    name: `${namePrefix}-backup-restore-role`,
    assumeRolePolicy: backupAssumeRolePolicy.json,
    permissionsBoundary: permissionsBoundaryArn,
    description:
      "AWS Backup restore role, assumed only during a restore drill/incident. Restore-only managed policies (AWSBackupServiceRolePolicyForRestores + ForS3Restore); no backup:Delete/Disable.",
  });

  new aws.iam.RolePolicyAttachment(`${namePrefix}-backup-restore-ddb`, {
    role: backupRestoreRole.name,
    policyArn:
      "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores",
  });

  new aws.iam.RolePolicyAttachment(`${namePrefix}-backup-restore-s3`, {
    role: backupRestoreRole.name,
    // NOTE: the S3 backup/restore managed policies live at the policy ROOT
    // (no `service-role/` path segment), unlike the DynamoDB ones above.
    policyArn:
      "arn:aws:iam::aws:policy/AWSBackupServiceRolePolicyForS3Restore",
  });

  return {
    api: apiRole,
    compactor: compactorRole,
    janitor: janitorRole,
    snapshotPurge: snapshotPurgeRole,
    backup: backupRole,
    backupRestore: backupRestoreRole,
  };
}

/**
 * Probe Lambda's least-privilege role: basic Lambda execution + logs only.
 * Created by `createProbeLambda()` in lambda.ts (the probe Lambda itself is
 * built after the CloudFront distribution so its API_ENDPOINT is available —
 * which is outside the `createRoles()` resource graph). The probe makes
 * an outbound HTTPS fetch and emits an EMF metric to stdout; it touches no
 * DynamoDB, S3, SSM, or SES, so no policy beyond the managed basic-execution
 * attachment is needed.
 */
export function createProbeRole(
  namePrefix: string,
  permissionsBoundaryArn?: string,
): aws.iam.Role {
  const probeRole = new aws.iam.Role(`${namePrefix}-probe-role`, {
    name: `${namePrefix}-probe-role`,
    assumeRolePolicy: lambdaAssumeRolePolicy.json,
    permissionsBoundary: permissionsBoundaryArn,
    description:
      "Runtime role for the health-check probe Lambda. Basic Lambda execution + logs only - outbound HTTPS fetch + EMF stdout metric. No DynamoDB / S3 / SSM / SES.",
  });

  new aws.iam.RolePolicyAttachment(`${namePrefix}-probe-logs`, {
    role: probeRole.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  });

  return probeRole;
}
