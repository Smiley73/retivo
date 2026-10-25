// Per-stack least-privilege IAM roles; the scope of each is in AGENTS.md "IAM scoping matters".
// Every grant is enumerated: no `dynamodb:*`, no `*` resources except SES SendEmail.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { Tables } from "./dynamo";

interface IamOpts {
  readonly namePrefix: string;
  readonly tables: Tables;
  readonly snapshotsBucketArn: pulumi.Output<string>;
  readonly ssmParameterArns: pulumi.Output<string[]>;
  /** Permissions-boundary ARN stamped on every role, for accounts that require one. */
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

// The backup roles trust backup.amazonaws.com; lambdaAssumeRolePolicy hardcodes lambda.amazonaws.com.
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

  // Builds the AWS-managed SSM KMS alias ARN for the api role's `kms:Decrypt`.
  const callerIdentity = aws.getCallerIdentityOutput({});

  // ---------------------------------------------------------------- api role
  const apiRole = new aws.iam.Role(`${namePrefix}-api-role`, {
    name: `${namePrefix}-api-role`,
    assumeRolePolicy: lambdaAssumeRolePolicy.json,
    permissionsBoundary: permissionsBoundaryArn,
    description:
      "Runtime role for the api Lambda. Per-table actions; BatchWriteItem on MutationLog/IdempotencyKey/AggregateVersion/DeviceRegistry is scoped to the shared household-data sweep (HouseholdSweepService) used by DELETE /auth/account, POST /auth/encrypted-workspace-reset, and POST /sync/restore (RestoreService).",
  });

  new aws.iam.RolePolicyAttachment(`${namePrefix}-api-logs`, {
    role: apiRole.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  });

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

  // DynamoDB requires GSI ARNs to be listed separately from the base table.
  const apiGsiArns: pulumi.Output<string>[] = [
    pulumi.interpolate`${tables.user.arn}/index/EmailIndex`,
    pulumi.interpolate`${tables.revokedToken.arn}/index/UserIndex`,
  ];

  const apiPolicyDocument = aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        sid: "DynamoTableActions",
        effect: "Allow",
        // No `dynamodb:TransactWriteItems` / `TransactGetItems` IAM action exists; a transaction is
        // authorized by the per-item actions below.
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:ConditionCheckItem",
          // /health runs DescribeTable on the User table.
          "dynamodb:DescribeTable",
        ],
        resources: pulumi.all([...apiTableArns, ...apiGsiArns]).apply((arns) => arns),
      },
      {
        // Scan only where a caller needs it, so a compromised dependency cannot enumerate the
        // credential, refresh, revoked or passkey tables. Callers: User (hasAnyUser), IdempotencyKey (the
        // household sweep), EmailVerification and SignupApproval (the account-deletion auth-state sweep).
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
        // BatchWriteItem for the household sweep only (HouseholdSweepService); any other table or
        // caller needs a scope-change proposal.
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
        // Api role only: wrapped key material stays outside the compactor's privilege boundary. The
        // deleteAllForHousehold sweep loops Query + DeleteItem rather than BatchWriteItem to stay
        // inside this grant. ConditionCheckItem runs inside the change-password transaction.
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
        // Api role only. Point-ops, no Query, Scan or BatchWriteItem: access is keyed by userId.
        // Not in apiTableArns, to keep Query off these secret tables.
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
        // Api role only. The MfaSecretPointOps set plus Query: listByUser and the account-deletion
        // cascade enumerate a user's rows by the userId key.
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
        // Api role only. Challenge storage and the shared request-throttle counter (UpdateItem
        // backs its atomic increment). Keyed point-ops on `key`: no GetItem, Query, Scan or
        // BatchWriteItem.
        sid: "PasskeyChallengeAndThrottleCounter",
        effect: "Allow",
        actions: ["dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem"],
        resources: [tables.passkeyChallenge.arn],
      },
      {
        sid: "S3SnapshotsRead",
        effect: "Allow",
        // ListBucket is bucket-wide because IAM cannot scope it to a per-caller prefix;
        // SnapshotsService enforces the `${householdId}/` prefix. No s3:DeleteObject: purges go
        // through the snapshot-purge Lambda.
        actions: ["s3:GetObject", "s3:ListBucket"],
        resources: [
          snapshotsBucketArn,
          pulumi.interpolate`${snapshotsBucketArn}/*`,
        ],
      },
      {
        sid: "S3SnapshotsWrite",
        effect: "Allow",
        // Object-scoped (`/*`) only, so restores can mint a fresh snapshot. No s3:DeleteObject.
        actions: ["s3:PutObject"],
        resources: [pulumi.interpolate`${snapshotsBucketArn}/*`],
      },
      {
        sid: "S3SnapshotsLocation",
        effect: "Allow",
        // Bucket-level metadata read for /health/dependencies; the resource is the bucket ARN
        // itself.
        actions: ["s3:GetBucketLocation"],
        resources: [snapshotsBucketArn],
      },
      {
        // Only the snapshot-purge Lambda; its ARN is derived from the stack name to avoid a
        // role-lambda cycle.
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
        // The AWS-managed SSM key alias only, and only when SSM is the calling service.
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
        // SendRawEmail is withheld so a compromised Lambda cannot craft arbitrary MIME messages.
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
  // MutationLog, WorkspaceMeta and snapshots only; no auth-table access.
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
  // Snapshot retention only: no DynamoDB, SSM or PutObject.
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
  // Same grant as the janitor; isolating bulk delete here is what lets the api role drop DeleteObject.
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
  // AWS Backup service role. Its managed policies carry no backup:Delete*/Disable*, so it cannot weaken
  // the vault lock. Created on every stack, inert without a Backup Plan.
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
    // The S3 managed policies sit at the policy root, without `service-role/`.
    policyArn:
      "arn:aws:iam::aws:policy/AWSBackupServiceRolePolicyForS3Backup",
  });

  // --------------------------------------------------- backup-restore role
  // Restore-only, assumed during a restore drill or incident; kept apart so the always-on role stays
  // backup-write only.
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
    // The S3 managed policies sit at the policy root, without `service-role/`.
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

/** Probe Lambda role: basic execution and logs only. Created by `createProbeLambda()` in lambda.ts. */
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
