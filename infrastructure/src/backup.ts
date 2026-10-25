// Prod-only immutable AWS Backup vault (`enableBackups`), with a daily plan over every table and the snapshots bucket.
// Docs: docs/deploy.md "Backups (`enableBackups`)", docs/security.md "Backups and at-rest encryption".

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { Tables } from "./dynamo";

// GOVERNANCE lock floor, equal to the plan's retention so nothing without the `backup:` bypass can
// purge sooner.
const MIN_RETENTION_DAYS = 90;
// Generous ceiling so a longer-retention rule still fits under the lock.
const MAX_RETENTION_DAYS = 36500;
const DELETE_AFTER_DAYS = 90;
// One full day, matching the daily plan: fewer than one completed job inside it means the plan is
// not running.
const NO_JOBS_ALARM_PERIOD_SECONDS = 86400;

interface BackupOpts {
  readonly namePrefix: string;
  readonly tables: Tables;
  readonly snapshotsBucketArn: pulumi.Output<string>;
  readonly backupRole: aws.iam.Role;
  readonly alarmTopic: aws.sns.Topic;
}

export interface BackupOutputs {
  readonly vault: aws.backup.Vault;
  readonly plan: aws.backup.Plan;
}

export function createBackup(opts: BackupOpts): BackupOutputs {
  const { namePrefix, tables, snapshotsBucketArn, backupRole, alarmTopic } =
    opts;

  // S3 backup is off by default; without this opt-in the S3 selection silently does nothing.
  // RegionSettings is an account+region singleton that prod owns, so dev must never enable backups.
  new aws.backup.RegionSettings(`${namePrefix}-backup-region-settings`, {
    resourceTypeOptInPreference: {
      DynamoDB: true,
      S3: true,
    },
    resourceTypeManagementPreference: {
      DynamoDB: true,
    },
  });

  // No kmsKeyArn: the default `aws/backup` key, so no CMK and no monthly KMS fee. retainOnDelete
  // because a GOVERNANCE vault holding locked recovery points cannot be deleted, so a rollback
  // would error and a delete would defeat immutability (docs/deploy.md "Tearing down").
  const vault = new aws.backup.Vault(
    `${namePrefix}-backups`,
    {
      name: `${namePrefix}-backups`,
    },
    { retainOnDelete: true },
  );

  // GOVERNANCE, not COMPLIANCE: `changeableForDays` is omitted because its presence makes the lock
  // irreversible. A break-glass admin can still purge a specific recovery point. Residual risk
  // accepted.
  new aws.backup.VaultLockConfiguration(
    `${namePrefix}-backups-lock`,
    {
      backupVaultName: vault.name,
      minRetentionDays: MIN_RETENTION_DAYS,
      maxRetentionDays: MAX_RETENTION_DAYS,
    },
    { retainOnDelete: true },
  );

  // Daily at 05:00 UTC; a ~24h RPO is fine for the disaster floor, since PITR and hourly snapshots
  // cover fine-grained recovery.
  const plan = new aws.backup.Plan(`${namePrefix}-backup-plan`, {
    name: `${namePrefix}-backup-plan`,
    rules: [
      {
        ruleName: "daily",
        targetVaultName: vault.name,
        schedule: "cron(0 5 * * ? *)",
        startWindow: 60,
        completionWindow: 180,
        lifecycle: {
          deleteAfter: DELETE_AFTER_DAYS,
        },
      },
    ],
  });

  // Mapped over `Tables`, not a hand-kept list, so a new table is included automatically.
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

  // Non-success job events go to the alarm topic. PARTIAL counts: the snapshots bucket is the only
  // copy of compacted base state.
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

  // EventBridge needs an explicit grant to publish to SNS, scoped to this rule by aws:SourceArn.
  // SetTopicAttributes replaces the whole policy, so the default owner statement is reproduced to
  // keep the account's own access.
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

  // The failed-job event fires only once a job exists, so this alarm catches a plan that never
  // creates one. Per-vault dimension: AWS Backup publishes no account-wide series, so without it
  // the "breaching" missing-data setting would leave the alarm permanently in ALARM.
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
