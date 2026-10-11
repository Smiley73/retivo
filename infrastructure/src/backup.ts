// Immutable AWS Backup vault — the live-role-isolated disaster floor.
//
// Created ONLY on the prod stack (gated by `retivo:enableBackups`). One
// daily Backup Plan copies every DynamoDB table + the S3 snapshots bucket into
// a GOVERNANCE Vault-Lock'd vault that no live app role and no accidental
// `pulumi destroy` can delete. 90-day retention sits ~2
// months past DynamoDB PITR's 35-day reach. Restore runs via the AWS Backup
// console/CLI: the operator starts a restore job and PASSES the dedicated
// `backupRestore` role (iam.ts) to AWS Backup, which assumes it to do the
// restore — the operator does not sts:AssumeRole it (that role trusts only
// backup.amazonaws.com).
//
// Threat model: catastrophic single-point loss — a leaked credential, a
// buggy/compromised api role overwriting the authoritative base snapshots, or
// an accidental teardown. PITR + hourly snapshots already cover fine-grained
// recovery within 35 days; the only genuinely additive protection is
// immutability + isolation from the live account surface.
//
// Vault encryption uses the default AWS-managed `aws/backup` KMS key — no CMK,
// no monthly KMS fee, consistent with the repo's no-CMK cost posture.
//
// Operator view: docs/deploy.md -> "Backups (`enableBackups`)"; what the vault
// protects: docs/security.md -> "Backups and at-rest encryption".

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { Tables } from "./dynamo";

// GOVERNANCE Vault-Lock minimum retention. The vault refuses to delete any
// recovery point younger than this, so neither the app roles, an accidental
// destroy, nor a bug can purge sooner (none hold the `backup:` bypass). Set
// equal to the plan's deleteAfter so the lock floor matches the retention.
const MIN_RETENTION_DAYS = 90;
// Generous ceiling so a future longer-retention rule still fits under the
// lock; the daily rule's 90-day deleteAfter sits well within it.
const MAX_RETENTION_DAYS = 36500;
// Per-recovery-point retention: one Backup Plan rule, daily cadence.
const DELETE_AFTER_DAYS = 90;
// No-job-created alarm window: one full day, matching the daily plan
// cadence — fewer than one completed job inside it means the plan is not
// running.
const NO_JOBS_ALARM_PERIOD_SECONDS = 86400;

interface BackupOpts {
  readonly namePrefix: string;
  /** Every DynamoDB table — ARNs derived via Object.values(tables). */
  readonly tables: Tables;
  /** The S3 snapshots bucket ARN — added explicitly to the Selection. */
  readonly snapshotsBucketArn: pulumi.Output<string>;
  /** The AWS Backup service role (backup-only managed policies; iam.ts). */
  readonly backupRole: aws.iam.Role;
  /** The existing per-stack alarm SNS topic — non-success terminal jobs (FAILED/EXPIRED/PARTIAL/ABORTED) + the no-job alarm notify it. */
  readonly alarmTopic: aws.sns.Topic;
}

export interface BackupOutputs {
  readonly vault: aws.backup.Vault;
  readonly plan: aws.backup.Plan;
}

export function createBackup(opts: BackupOpts): BackupOutputs {
  const { namePrefix, tables, snapshotsBucketArn, backupRole, alarmTopic } =
    opts;

  // Opt the region into AWS Backup for DynamoDB (advanced/full management) + S3
  // S3 backup is NOT on by default — without this opt-in the S3
  // selection silently does nothing. RegionSettings is an account+region
  // SINGLETON: dev + prod share one account+region, so PROD owns it and dev
  // must never set enableBackups=true while prod owns it (enforced by the
  // prod-only gating in config/index). DynamoDB "advanced" backup features
  // require the management-preference opt-in alongside the plain opt-in.
  new aws.backup.RegionSettings(`${namePrefix}-backup-region-settings`, {
    resourceTypeOptInPreference: {
      DynamoDB: true,
      S3: true,
    },
    resourceTypeManagementPreference: {
      DynamoDB: true,
    },
  });

  // The vault. Default AWS-managed `aws/backup` KMS key (no kmsKeyArn → no CMK).
  // retainOnDelete: on rollback (enableBackups=false) Pulumi drops
  // the vault from state WITHOUT issuing a delete — a GOVERNANCE vault holding
  // locked recovery points cannot be deleted, so without this the rollback
  // `pulumi up` would error, and deleting the vault would defeat
  // immutability. Final teardown is a deliberate post-retention
  // break-glass step (see docs/deploy.md → "Tearing down").
  const vault = new aws.backup.Vault(
    `${namePrefix}-backups`,
    {
      name: `${namePrefix}-backups`,
    },
    { retainOnDelete: true },
  );

  // GOVERNANCE Vault Lock. `changeableForDays` is DELIBERATELY OMITTED —
  // its presence is what makes a lock COMPLIANCE (irreversible). A GOVERNANCE
  // lock enforces minRetentionDays so normal operations cannot delete recovery
  // points sooner, but a break-glass admin can still purge a specific one.
  // retainOnDelete mirrors the vault.
  new aws.backup.VaultLockConfiguration(
    `${namePrefix}-backups-lock`,
    {
      backupVaultName: vault.name,
      minRetentionDays: MIN_RETENTION_DAYS,
      maxRetentionDays: MAX_RETENTION_DAYS,
      // changeableForDays intentionally NOT set — see comment above.
    },
    { retainOnDelete: true },
  );

  // One Backup Plan rule: daily at 05:00 UTC, 90-day retention. Default
  // start/completion windows. The vault is the disaster floor, so a ~24h RPO on
  // the immutable copy is fine — live PITR + hourly snapshots cover fine-grained
  // recovery.
  const plan = new aws.backup.Plan(`${namePrefix}-backup-plan`, {
    name: `${namePrefix}-backup-plan`,
    rules: [
      {
        ruleName: "daily",
        targetVaultName: vault.name,
        schedule: "cron(0 5 * * ? *)",
        // Default windows: begin within 60 min, complete within 180 min.
        startWindow: 60,
        completionWindow: 180,
        lifecycle: {
          deleteAfter: DELETE_AFTER_DAYS,
        },
      },
    ],
  });

  // Selection: every table ARN derived by mapping over the Tables object — NOT
  // the hand-maintained tableArns() list — so any new table added to `Tables`
  // is auto-included with no manual step (a hand-picked list once missed
  // householdKeyEnvelope). The S3 snapshots bucket ARN
  // is added explicitly. iamRoleArn is the backup-only service role.
  const tableArns: pulumi.Output<string>[] = Object.values(tables).map(
    (t) => t.arn,
  );

  new aws.backup.Selection(`${namePrefix}-backup-selection`, {
    name: `${namePrefix}-backup-selection`,
    iamRoleArn: backupRole.arn,
    planId: plan.id,
    resources: pulumi
      .all([...tableArns, snapshotsBucketArn])
      .apply((arns) => arns),
  });

  // Non-success backup-job events -> the existing SNS alarm topic. A
  // silently-failing backup is worse than none; the repo already alarms on
  // compactor failure, so backups must not be the exception. All four
  // non-success terminal states are caught: FAILED, EXPIRED, PARTIAL (an S3
  // backup where some objects failed — the snapshots bucket is the only copy
  // of compacted base state, so a partial is a real gap), and ABORTED.
  const failedJobRule = new aws.cloudwatch.EventRule(
    `${namePrefix}-backup-job-failed`,
    {
      name: `${namePrefix}-backup-job-failed`,
      description:
        "AWS Backup job entered FAILED, EXPIRED, PARTIAL, or ABORTED — route to the alarm SNS topic.",
      eventPattern: JSON.stringify({
        source: ["aws.backup"],
        "detail-type": ["Backup Job State Change"],
        detail: { state: ["FAILED", "EXPIRED", "PARTIAL", "ABORTED"] },
      }),
    },
  );

  new aws.cloudwatch.EventTarget(`${namePrefix}-backup-job-failed-target`, {
    rule: failedJobRule.name,
    arn: alarmTopic.arn,
  });

  // EventBridge cannot publish to SNS without an explicit topic resource-policy
  // grant — omitting it makes the failure alarm silently no-op. Scoped to
  // the EventBridge rule's ARN via aws:SourceArn so only this rule can publish.
  //
  // SNS SetTopicAttributes REPLACES the topic's entire access policy (it does
  // not merge), so this document MUST also carry the default owner statement
  // that SNS normally injects ("__default_statement_ID"). Omitting it would
  // drop the account/CloudWatch's own resource-policy access to the topic the
  // moment enableBackups flips true. Statement 1 reproduces that default owner
  // grant verbatim (scoped to this account via AWS:SourceOwner); statement 2 is
  // the EventBridge publish grant.
  const accountId = aws.getCallerIdentityOutput({}).accountId;
  new aws.sns.TopicPolicy(`${namePrefix}-alarms-backup-events-policy`, {
    arn: alarmTopic.arn,
    policy: pulumi
      .all([alarmTopic.arn, failedJobRule.arn, accountId])
      .apply(([topicArn, ruleArn, ownerAccountId]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "__default_statement_ID",
              Effect: "Allow",
              Principal: { AWS: "*" },
              Action: [
                "SNS:GetTopicAttributes",
                "SNS:SetTopicAttributes",
                "SNS:AddPermission",
                "SNS:RemovePermission",
                "SNS:DeleteTopic",
                "SNS:Subscribe",
                "SNS:ListSubscriptionsByTopic",
                "SNS:Publish",
                "SNS:Receive",
              ],
              Resource: topicArn,
              Condition: {
                StringEquals: { "AWS:SourceOwner": ownerAccountId },
              },
            },
            {
              Sid: "AllowEventBridgePublish",
              Effect: "Allow",
              Principal: { Service: "events.amazonaws.com" },
              Action: "sns:Publish",
              Resource: topicArn,
              Condition: {
                ArnEquals: { "aws:SourceArn": ruleArn },
              },
            },
          ],
        }),
      ),
  });

  // No-job-created alarm. The per-job FAILED/EXPIRED/PARTIAL/ABORTED event
  // above only fires once a job EXISTS — if the daily plan never CREATES a job
  // (an ineffective selection, an S3 opt-in that never took effect, a paused
  // plan, RegionSettings contention), no event is emitted and the disaster
  // floor silently never runs. This CloudWatch alarm closes that gap: it fires
  // when AWS Backup completes fewer than one job in a day. treatMissingData
  // "breaching" so an entirely-absent metric (no jobs at all) alarms rather than
  // sitting silently in INSUFFICIENT_DATA.
  //
  // Scoped to THIS vault via the BackupVaultName dimension: AWS Backup publishes
  // NumberOfBackupJobsCompleted dimensioned by BackupVaultName (and ResourceType),
  // so an un-dimensioned alarm would watch a non-existent account-wide aggregate
  // series and, with treatMissingData "breaching", sit permanently in ALARM. The
  // per-vault series exists once this vault's daily plan runs jobs.
  new aws.cloudwatch.MetricAlarm(`${namePrefix}-backup-no-jobs-alarm`, {
    name: `${namePrefix}-backup-no-jobs`,
    alarmDescription:
      "AWS Backup completed fewer than one backup job in the last 24h - the daily disaster-floor plan may not be running.",
    namespace: "AWS/Backup",
    metricName: "NumberOfBackupJobsCompleted",
    dimensions: { BackupVaultName: vault.name },
    statistic: "Sum",
    period: NO_JOBS_ALARM_PERIOD_SECONDS,
    evaluationPeriods: 1,
    threshold: 1,
    comparisonOperator: "LessThanThreshold",
    treatMissingData: "breaching",
    alarmActions: [alarmTopic.arn],
    okActions: [alarmTopic.arn],
  });

  return { vault, plan };
}
