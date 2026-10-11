// Per-stack CloudWatch monitoring: SNS alert topic + email subscription and
// alarms. Encodes an explicit dev/prod policy matrix: prod carries the
// full diagnostic alarm inventory; dev is reduced to critical
// availability, data-integrity, and intrusion-detection signals only. See
// docs/deploy.md -> "Alarms" for the operator view.
//
// Layered on top of the isProd matrix, four required group switches decide
// which alarms a stack deploys. Each switch gates exactly its own group:
//   - enableSecurityAlarms       token-reuse, mfa-verify-failed, login-failed
//   - enableApiHealthAlarms      api-errors; prod also api-latency-p95
//   - enableBackgroundJobAlarms  the five compactor alarms; prod also
//                                janitor-heartbeat
//   - enableCapacityAlarms       lambda-throttles and
//                                lambda-concurrency-headroom (prod only)
// The isProd-only alarms stay prod-only inside their group. backup.ts's
// no-job alarm and failed-job rule are NOT in any group: they ride
// `enableBackups` alone and keep alerting with all four groups off.
//
// The alarm SNS topic and its email subscription exist only when at least
// one of the four groups or `enableBackups` is on (`anythingSendsAlerts` in
// config-helpers.mjs, the same predicate that makes `alarmNotificationEmail`
// required). With all five off there is no topic and no subscription;
// turning any one back on then re-creates the subscription, which lands in
// SNS's `PendingConfirmation` state until a human clicks the confirmation
// link in the inbox. See the JSDoc on the switches in config.ts.
//
// All alarms are SIMPLE alarms (1 alarm-metric each). AWS bills per
// alarm-metric above a shared free tier; see docs/deploy.md -> "Alarms" for
// the cost drivers. SNS email and EventBridge invocations are free at this
// scale.
//
// Metric sources:
//   - Security metrics `LoginFailed` / `MfaVerifyFailed` / `RefreshTokenReuse`
//     are emitted DIRECTLY as EMF from AuthEventsRepository.record() into the
//     per-stack `Retivo/${stack}/Security` namespace (dev AND prod), NOT
//     from the old, production-unverified Nest service-log markers.
//   - Compactor metrics are direct EMF into the per-stack
//     `Retivo/${stack}/Compactor` namespace.
// EMF metrics are emitted from Lambda stdout and auto-extracted by CloudWatch
// Logs — no cloudwatch:PutMetricData IAM grant.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { anythingSendsAlerts } from "./config-helpers.mjs";

interface MonitoringOpts {
  readonly namePrefix: string;
  readonly stack: string;
  /**
   * Operator inbox the alarm SNS topic subscribes
   * (`retivo:alarmNotificationEmail`). Absent only when nothing sends alerts,
   * in which case there is no topic to subscribe.
   */
  readonly alarmEmail: string | undefined;
  /** api Lambda — native Errors metric source for the error-count alarm. */
  readonly apiLambda: aws.lambda.Function;
  /** compactor Lambda — native Errors metric source for the compactor alarm. */
  readonly compactorLambda: aws.lambda.Function;
  /** janitor Lambda — Invocations metric source for the janitor heartbeat alarm (prod only). */
  readonly janitorLambda: aws.lambda.Function;
  /** HTTP API — ApiId dimension for the whole-API p95 latency alarm. */
  readonly apiId: pulumi.Output<string>;
  /** api Lambda log group — retained for future log-derived signals. */
  readonly apiLogGroup: aws.cloudwatch.LogGroup;
  /**
   * Account-wide Lambda concurrency ceiling (`retivo:lambdaConcurrencyQuota`,
   * optional, defaults 10). Feeds the prod-only `ConcurrentExecutions` alarm
   * threshold (`quota - 2`) — the only place the ceiling is written.
   */
  readonly lambdaConcurrencyQuota: number;
  /**
   * `retivo:enableSecurityAlarms` (required, no default): the three
   * intrusion-detection alarms (token-reuse, mfa-verify-failed,
   * login-failed), both stacks.
   */
  readonly enableSecurityAlarms: boolean;
  /**
   * `retivo:enableApiHealthAlarms` (required, no default): api-errors, plus
   * api-latency-p95 on prod only.
   */
  readonly enableApiHealthAlarms: boolean;
  /**
   * `retivo:enableBackgroundJobAlarms` (required, no default): the five
   * compactor alarms, plus janitor-heartbeat on prod only.
   */
  readonly enableBackgroundJobAlarms: boolean;
  /**
   * `retivo:enableCapacityAlarms` (required, no default): the two
   * account-wide concurrency alarms, prod only — deploys nothing elsewhere.
   */
  readonly enableCapacityAlarms: boolean;
  /**
   * `retivo:enableBackups` — this function does not gate any alarm on it, but
   * the topic must exist whenever backup.ts's non-success-job / no-job
   * alarms need somewhere to send mail. See the `enableBackups: true`
   * overload below.
   */
  readonly enableBackups: boolean;
}

export interface MonitoringOutputs {
  readonly alarmTopic: aws.sns.Topic | undefined;
}

// The backup branch in index.ts needs a guaranteed real Topic, not an
// optional one it must narrow or cast — TypeScript cannot infer "enableBackups
// implies the topic exists" from a plain boolean field, so the guarantee is
// carried by this overload instead: calling with the literal `enableBackups:
// true` narrows the return type's `alarmTopic` to non-optional. The
// shared `anythingSendsAlerts` predicate inside the implementation is what
// actually makes this true at runtime (enableBackups is one of its terms) —
// this overload documents that invariant to callers, it doesn't enforce it.
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
  // apiLogGroup is threaded for future log-derived signals; the token-reuse /
  // mfa log-marker filters that used it were replaced by direct EMF
  // so nothing here reads it today.
  void apiLogGroup;

  // Dev/prod policy matrix. `isProd` gates every surface the dev
  // critical-only matrix removes: API latency alarm, janitor heartbeat, and
  // the account-wide concurrency alarms. Dev keeps availability,
  // data-integrity, and the three intrusion-detection security alarms.
  const isProd = stack === "prod";

  // Per-stack namespaces. Security + compactor are per-stack in BOTH stacks so
  // a dev event can never trip a prod alarm.
  const securityNs = `Retivo/${stack}/Security`; // LoginFailed/MfaVerifyFailed/RefreshTokenReuse (dev+prod)
  const compactorNs = `Retivo/${stack}/Compactor`; // per-stack compactor EMF

  // ---------------------------------------------------------- SNS alert topic
  // The topic + its email subscription exist iff something sends alerts: any
  // of the four alarm groups or enableBackups. The decision comes from the
  // same predicate config.ts uses to require `alarmNotificationEmail`, so the
  // two cannot drift apart. A stack with enableBackups=true and every group
  // off still gets the topic, so backup.ts's alerting still reaches the
  // inbox; a stack with all five off gets neither the topic nor the
  // subscription (config.ts warns non-fatally when that happens).
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

  // Single email subscription. The operator must CONFIRM this from their
  // inbox after the first `pulumi up` — until confirmed, AWS sends no alarm
  // mail. Format is not pre-validated: a bad address surfaces as a
  // failed subscription with a clear AWS error. A stack whose topic was
  // absent (all five switches were false) and now has it re-created lands
  // here in the same PendingConfirmation state.
  if (alarmTopic) {
    if (alarmEmail === undefined) {
      // config.ts requires the address whenever the topic exists; this only
      // guards a caller that bypasses it.
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

  // Consumed only inside the four group guards below — every one of them
  // implies `alarmsEnabled`, so the topic exists. Never use it outside a
  // guard, or a deploy could ship an alarm with an empty action list that
  // looks healthy in the console and pages nobody.
  const topicArns = alarmTopic ? [alarmTopic.arn] : [];

  // ------------------------------------------------------ security alarms
  // All three fire in BOTH dev and prod off the direct per-stack
  // `Retivo/${stack}/Security` EMF metrics — credential-guessing / token-
  // replay detection is a critical signal, not a business-KPI luxury. Gated
  // by `enableSecurityAlarms` alone (docs/deploy.md -> "Alarms").
  if (enableSecurityAlarms) {
    // (c) Refresh-token reuse — any occurrence is a theft signal: Sum > 0 over a
    // single 5-min period. Fire on the first event.
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

    // (c2) Failed second-factor (MFA) brute force — a handful of wrong second-
    // factor codes is ordinary user error, so this fires only on a sustained
    // burst: Sum > 10 over a single 5-min period, aggregated across every
    // account on this stack. 10 failures in 5 min, system-wide, is well above
    // what unrelated typos across separate accounts should produce; treat it
    // as an automated 2FA-guessing run.
    // Who revisits: the operator. Revisit trigger: an alarm period whose
    // failures trace to unrelated accounts' ordinary retries rather than to one
    // guessing run — i.e. the threshold has started paging on organic traffic.
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

    // (c3) Failed-login burst — password logins that reached credential
    // validation and failed. Sum > 5 in one 5-min period: set ABOVE dev's
    // observed 3-failures/5-min baseline so normal typing/test mistakes don't
    // page, while still catching a real credential-guessing burst.
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
  // `enableApiHealthAlarms`: the api error count in both stacks, plus the
  // whole-API p95 latency alarm on prod only. The guard implies the topic exists.
  if (enableApiHealthAlarms) {
    // (a) api Lambda error count — SIMPLE alarm on native AWS/Lambda Errors for
    // the api function only, FunctionName dimension (stack-scoped, 1 alarm-metric;
    // NOT a metric-math aggregate). Sum > 5 over 5 min, 3 datapoints. Kept
    // in BOTH stacks (critical application-failure signal).
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

    // (b) Whole-API p95 latency — native AWS/ApiGateway Latency on the API stage
    // (not per-route; the single $default route makes per-route isolation
    // infeasible). p95 > 1000ms over 15 min, 3 periods. PROD-ONLY: dev cold
    // starts and sporadic traffic make it noisy rather than actionable.
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
  // `enableBackgroundJobAlarms`: the five compactor alarms in both stacks, plus
  // the janitor heartbeat on prod only. The guard implies the topic exists.
  if (enableBackgroundJobAlarms) {
    // ---------------------------------------------------- compactor alarms
    // These read the per-stack `Retivo/${stack}/Compactor` EMF namespace that
    // compactor.service.ts emits to. A new per-stack namespace starts with
    // ZERO history, so the coverage/snapshot-read-error/budget-limited alarms
    // have no baseline for the first evaluation window immediately after
    // deploy — a one-time, short deploy-window gap, not a masked ongoing risk
    // (the emitter and these consumers deploy together, so there is never a
    // window where one namespace is emitted-to but unwatched).
    //
    // (d) Compactor failure — native AWS/Lambda Errors on the compactor function.
    // Any thrown exception (Sum > 0) over a single 5-min period. Kept in
    // BOTH stacks (critical data-path failure).
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

    // (d2) Compactor coverage violation — the `CompactorCoverageViolation` EMF
    // metric, in the per-stack `Retivo/${stack}/Compactor`
    // namespace so a dev coverage violation cannot trip the prod alarm and vice
    // versa. The sweep emits this only when it KEEPS an uncovered row (a
    // KSUID-disorder strand or a latent orphan it refuses to delete), so any
    // occurrence is a real data-integrity signal: Sum > 0 over a single 5-min
    // period. No custom dimensions (householdId stays in the structured log).
    // Kept in BOTH stacks.
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

    // (d3) Compactor snapshot-read error — the `CompactorSnapshotReadError` EMF
    // metric, in the same per-stack `Retivo/${stack}/Compactor`
    // namespace. The compactor emits this when a snapshot baseline read fails
    // with anything other than NoSuchKey and it SKIPS the household and
    // continues — so the native AWS/Lambda Errors alarm never fires for this
    // condition, leaving a household's compaction silently stalled with no
    // signal. Any occurrence is a real data-integrity signal: Sum > 0 over a
    // single 5-min period. No custom dimensions (householdId stays in the
    // structured log). Kept in BOTH stacks.
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

    // (d4) Compactor budget limited — the `CompactorBudgetLimited` EMF metric:
    // the compactor bounded a household's compaction pass this
    // run, either to a partial prefix or a true skip (an oversized baseline/
    // merged snapshot, a read/time budget with nothing usable). Any occurrence
    // is worth a look but is not necessarily urgent on its own — a single hit
    // after a large legitimate import can be benign, since the next run
    // resumes from the advanced cursor; repeats across successive runs mean a
    // household is not draining. Sum > 0 over a single 5-min period,
    // same per-stack compactorNs namespace as the two alarms beside it, no
    // custom dimensions (householdId stays in the structured log). Kept
    // in BOTH stacks.
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

    // (f) Compactor heartbeat — fires if the compactor Lambda stops invoking.
    // Kept in BOTH stacks (a stopped compactor can otherwise fail silently).
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

    // (g) Janitor heartbeat — fires if the janitor Lambda stops invoking.
    // PROD-ONLY: dev snapshot retention is disposable/noncritical.
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
  // `enableCapacityAlarms`: the two account-wide concurrency alarms, PROD-ONLY.
  // On a non-prod stack the switch deploys no alarms (the topic and the email
  // requirement still follow it). The guard implies the topic exists.
  if (enableCapacityAlarms) {
    // Both PROD-ONLY, on the account-wide `AWS/Lambda` aggregate — deliberately
    // NO `FunctionName` dimension: dev and prod share one account's Lambda
    // concurrency quota, so a per-function alarm on the prod api Lambda alone
    // would miss dev starving prod's headroom, which is exactly the scenario
    // this pages for. Both attach to the SAME `topicArns` every other alarm
    // uses — no new SNS topic, no new subscription; because both stacks send
    // alarm mail to the same owner inbox, prod-only placement still reaches
    // the operator.
    if (isProd) {
      // (h) Any account-wide throttle is worth a look immediately: Sum > 0
      // over a single 60s period, 1 datapoint.
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

      // (i) Headroom warning ahead of an actual throttle: account-wide
      // concurrency sustained within 2 of the configured quota
      // (`retivo:lambdaConcurrencyQuota`, default 10) for 2 of 3 60s periods.
      // The threshold is an expression over that config option, never a
      // literal — raising the key and redeploying moves this alarm with it.
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
