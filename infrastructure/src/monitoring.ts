// Per-stack CloudWatch monitoring: the SNS alert topic, its email subscription and the alarms.
// Alarm inventory and cost drivers are in docs/deploy.md "Alarms"; metrics are EMF from Lambda stdout, so no PutMetricData grant.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { anythingSendsAlerts } from "./config-helpers.mjs";

interface MonitoringOpts {
  readonly namePrefix: string;
  readonly stack: string;
  /** Operator inbox the alarm topic subscribes; absent only when nothing sends alerts. */
  readonly alarmEmail: string | undefined;
  /** Errors metric source for the api error-count alarm. */
  readonly apiLambda: aws.lambda.Function;
  /** Errors metric source for the compactor failure alarm. */
  readonly compactorLambda: aws.lambda.Function;
  /** Invocations metric source for the prod janitor heartbeat. */
  readonly janitorLambda: aws.lambda.Function;
  /** ApiId dimension for the prod p95 latency alarm. */
  readonly apiId: pulumi.Output<string>;
  readonly apiLogGroup: aws.cloudwatch.LogGroup;
  /** Account-wide Lambda concurrency quota; the prod concurrency alarm fires at `quota - 2`. */
  readonly lambdaConcurrencyQuota: number;
  /** Required switch: token-reuse, mfa-verify-failed and login-failed, on both stacks. */
  readonly enableSecurityAlarms: boolean;
  /** Required switch: api-errors, plus api-latency-p95 on prod. */
  readonly enableApiHealthAlarms: boolean;
  /** Required switch: the five compactor alarms, plus janitor-heartbeat on prod. */
  readonly enableBackgroundJobAlarms: boolean;
  /** Required switch: the two account-wide concurrency alarms, deployed on prod only. */
  readonly enableCapacityAlarms: boolean;
  /** Gates no alarm here, but backup.ts alerts through the topic, so it forces the topic to exist. */
  readonly enableBackups: boolean;
}

export interface MonitoringOutputs {
  readonly alarmTopic: aws.sns.Topic | undefined;
}

/** Calling with the literal `enableBackups: true` narrows `alarmTopic` to a non-optional Topic. */
export function createMonitoring(
  opts: MonitoringOpts & { readonly enableBackups: true },
): MonitoringOutputs & { readonly alarmTopic: aws.sns.Topic };
export function createMonitoring(opts: MonitoringOpts): MonitoringOutputs;
export function createMonitoring(opts: MonitoringOpts): MonitoringOutputs {
  const {
    namePrefix,
    stack,
    alarmEmail,
    apiLambda,
    compactorLambda,
    janitorLambda,
    apiId,
    apiLogGroup,
    lambdaConcurrencyQuota,
    enableSecurityAlarms,
    enableApiHealthAlarms,
    enableBackgroundJobAlarms,
    enableCapacityAlarms,
    enableBackups,
  } = opts;
  // Unused today; removing the parameter would touch index.ts.
  void apiLogGroup;

  // Dev keeps availability, data-integrity and security alarms; prod adds latency, janitor and
  // capacity.
  const isProd = stack === "prod";

  // Per-stack namespaces so a dev event cannot trip a prod alarm.
  const securityNs = `Retivo/${stack}/Security`; // LoginFailed/MfaVerifyFailed/RefreshTokenReuse (dev+prod)
  const compactorNs = `Retivo/${stack}/Compactor`; // per-stack compactor EMF

  // ---------------------------------------------------------- SNS alert topic
  // The topic exists iff something sends alerts; the predicate is shared with config.ts so the topic
  // and the email requirement cannot drift.
  const alarmsEnabled = anythingSendsAlerts({
    enableSecurityAlarms,
    enableApiHealthAlarms,
    enableBackgroundJobAlarms,
    enableCapacityAlarms,
    enableBackups,
  });
  const alarmTopic = alarmsEnabled
    ? new aws.sns.Topic(`${namePrefix}-alarms`, {
        name: `${namePrefix}-alarms`,
        displayName: `Retivo ${stack} alarms`,
      })
    : undefined;

  // The subscription must be confirmed from the inbox after the first `pulumi up`; until then AWS
  // sends no alarm mail.
  if (alarmTopic) {
    if (alarmEmail === undefined) {
      // config.ts requires the address whenever the topic exists.
      throw new Error(
        "createMonitoring: alarmEmail is required whenever the alarm topic exists",
      );
    }
    new aws.sns.TopicSubscription(`${namePrefix}-alarms-email`, {
      topic: alarmTopic.arn,
      protocol: "email",
      endpoint: alarmEmail,
    });
  }

  // Only used inside the group guards below, which imply the topic exists; outside one it would
  // yield an alarm that pages nobody.
  const topicArns = alarmTopic ? [alarmTopic.arn] : [];

  // ------------------------------------------------------ security alarms
  if (enableSecurityAlarms) {
    new aws.cloudwatch.MetricAlarm(`${namePrefix}-token-reuse-alarm`, {
      name: `${namePrefix}-token-reuse`,
      alarmDescription:
        "Refresh-token reuse detected (any occurrence is a token-theft signal).",
      namespace: securityNs,
      metricName: "RefreshTokenReuse",
      statistic: "Sum",
      period: 300,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      threshold: 0,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      alarmActions: topicArns,
      okActions: topicArns,
    });

    new aws.cloudwatch.MetricAlarm(`${namePrefix}-mfa-verify-failed-alarm`, {
      name: `${namePrefix}-mfa-verify-failed`,
      alarmDescription:
        "More than 10 failed second-factor (MFA) attempts in 5 minutes — possible brute-force on 2FA.",
      namespace: securityNs,
      metricName: "MfaVerifyFailed",
      statistic: "Sum",
      period: 300,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      threshold: 10,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      alarmActions: topicArns,
      okActions: topicArns,
    });

    new aws.cloudwatch.MetricAlarm(`${namePrefix}-login-failed-alarm`, {
      name: `${namePrefix}-login-failed`,
      alarmDescription:
        "More than 5 failed password logins in 5 minutes — possible credential-guessing burst.",
      namespace: securityNs,
      metricName: "LoginFailed",
      statistic: "Sum",
      period: 300,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      threshold: 5,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      alarmActions: topicArns,
      okActions: topicArns,
    });
  }

  // ------------------------------------------------- API health alarms
  if (enableApiHealthAlarms) {
    new aws.cloudwatch.MetricAlarm(`${namePrefix}-api-errors-alarm`, {
      name: `${namePrefix}-api-errors`,
      alarmDescription:
        "api Lambda logged more than 5 errors in 5 minutes (3 of 3 periods).",
      namespace: "AWS/Lambda",
      metricName: "Errors",
      dimensions: { FunctionName: apiLambda.name },
      statistic: "Sum",
      period: 300,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      threshold: 5,
      comparisonOperator: "GreaterThanThreshold",
      // notBreaching: a quiet (no-invocation) function is healthy, not alarming.
      treatMissingData: "notBreaching",
      alarmActions: topicArns,
      okActions: topicArns,
    });

    // Prod only: dev cold starts and sporadic traffic make it noisy.
    if (isProd) {
      new aws.cloudwatch.MetricAlarm(`${namePrefix}-api-latency-alarm`, {
        name: `${namePrefix}-api-latency-p95`,
        alarmDescription:
          "Whole-API p95 latency exceeded 1s over 15 minutes (3 of 3 periods).",
        namespace: "AWS/ApiGateway",
        metricName: "Latency",
        dimensions: { ApiId: apiId },
        extendedStatistic: "p95",
        period: 900,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        threshold: 1000,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "missing",
        alarmActions: topicArns,
        okActions: topicArns,
      });
    }
  }

  // ---------------------------------------------- background job alarms
  if (enableBackgroundJobAlarms) {
    // A new per-stack namespace has no history, so the first window after deploy has no baseline.
    new aws.cloudwatch.MetricAlarm(`${namePrefix}-compactor-failure-alarm`, {
      name: `${namePrefix}-compactor-failure`,
      alarmDescription: "Compactor Lambda threw at least one error in 5 minutes.",
      namespace: "AWS/Lambda",
      metricName: "Errors",
      dimensions: { FunctionName: compactorLambda.name },
      statistic: "Sum",
      period: 300,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      threshold: 0,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      alarmActions: topicArns,
      okActions: topicArns,
    });

    new aws.cloudwatch.MetricAlarm(`${namePrefix}-compactor-coverage`, {
      name: `${namePrefix}-compactor-coverage`,
      alarmDescription:
        "Compactor kept an uncovered mutation-log row (coverage violation) — a stranded/orphaned change it refused to delete. Investigate within one compaction cycle.",
      namespace: compactorNs,
      metricName: "CompactorCoverageViolation",
      statistic: "Sum",
      period: 300,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      threshold: 0,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      alarmActions: topicArns,
      okActions: topicArns,
    });

    new aws.cloudwatch.MetricAlarm(`${namePrefix}-compactor-snapshot-read-error`, {
      name: `${namePrefix}-compactor-snapshot-read-error`,
      alarmDescription:
        "Compactor could not read a household's snapshot baseline (unreadable, not empty) and skipped it — the household's compaction is stalled until the read recovers. Investigate within one compaction cycle.",
      namespace: compactorNs,
      metricName: "CompactorSnapshotReadError",
      statistic: "Sum",
      period: 300,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      threshold: 0,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      alarmActions: topicArns,
      okActions: topicArns,
    });

    new aws.cloudwatch.MetricAlarm(`${namePrefix}-compactor-budget-limited`, {
      name: `${namePrefix}-compactor-budget-limited`,
      alarmDescription:
        "Compactor bounded a household's compaction to a prefix or skipped it this run (a safety budget tripped). A single occurrence after a large legitimate import can be benign; repeats across successive runs mean a household is not draining — investigate.",
      namespace: compactorNs,
      metricName: "CompactorBudgetLimited",
      statistic: "Sum",
      period: 300,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      threshold: 0,
      comparisonOperator: "GreaterThanThreshold",
      treatMissingData: "notBreaching",
      alarmActions: topicArns,
      okActions: topicArns,
    });

    new aws.cloudwatch.MetricAlarm(`${namePrefix}-compactor-heartbeat`, {
      name: `${namePrefix}-compactor-heartbeat`,
      alarmDescription:
        "Compactor Lambda has not invoked in the last 24h — job may have stopped",
      namespace: "AWS/Lambda",
      metricName: "Invocations",
      dimensions: { FunctionName: compactorLambda.name },
      statistic: "Sum",
      period: 86400,
      evaluationPeriods: 1,
      comparisonOperator: "LessThanThreshold",
      threshold: 1,
      treatMissingData: "breaching",
      alarmActions: topicArns,
      okActions: topicArns,
    });

    // Prod only: dev snapshot retention is disposable.
    if (isProd) {
      new aws.cloudwatch.MetricAlarm(`${namePrefix}-janitor-heartbeat`, {
        name: `${namePrefix}-janitor-heartbeat`,
        alarmDescription:
          "Janitor Lambda has not invoked in the last 24h — job may have stopped",
        namespace: "AWS/Lambda",
        metricName: "Invocations",
        dimensions: { FunctionName: janitorLambda.name },
        statistic: "Sum",
        period: 86400,
        evaluationPeriods: 1,
        comparisonOperator: "LessThanThreshold",
        threshold: 1,
        treatMissingData: "breaching",
        alarmActions: topicArns,
        okActions: topicArns,
      });
    }
  }

  // ------------------------------------------------------ capacity alarms
  if (enableCapacityAlarms) {
    // No `FunctionName` dimension: dev and prod share the account's concurrency quota, so a
    // per-function alarm would miss dev starving prod.
    if (isProd) {
      new aws.cloudwatch.MetricAlarm(`${namePrefix}-lambda-throttles-alarm`, {
        name: `${namePrefix}-lambda-throttles`,
        alarmDescription:
          "An AWS/Lambda invocation was throttled somewhere in the account — the shared concurrency quota is being hit.",
        namespace: "AWS/Lambda",
        metricName: "Throttles",
        statistic: "Sum",
        period: 60,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        threshold: 0,
        comparisonOperator: "GreaterThanThreshold",
        treatMissingData: "notBreaching",
        alarmActions: topicArns,
        okActions: topicArns,
      });

      new aws.cloudwatch.MetricAlarm(`${namePrefix}-lambda-concurrency-alarm`, {
        name: `${namePrefix}-lambda-concurrency-headroom`,
        alarmDescription: `Account-wide Lambda concurrency reached within 2 executions of the ${lambdaConcurrencyQuota}-execution quota — throttling is imminent.`,
        namespace: "AWS/Lambda",
        metricName: "ConcurrentExecutions",
        statistic: "Maximum",
        period: 60,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        threshold: lambdaConcurrencyQuota - 2,
        comparisonOperator: "GreaterThanOrEqualToThreshold",
        treatMissingData: "notBreaching",
        alarmActions: topicArns,
        okActions: topicArns,
      });
    }
  }

  return { alarmTopic };
}
