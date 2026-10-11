/**
 * Minimal, dependency-free CloudWatch Embedded Metric Format (EMF) writer for
 * the event-time operational metrics.
 *
 * A metric is one standard-resolution EMF JSON line written to stdout; the
 * Lambda's CloudWatch Logs subscription auto-extracts it into the metric's
 * namespace. No `cloudwatch:PutMetricData` IAM grant is needed (matches the
 * compactor emitter). The writer is deliberately narrow:
 *   - only an allow-listed metric NAME is ever written (no user-derived or
 *     arbitrary names, no arbitrary extra fields — the EMF body is built from
 *     the three known fields only);
 *   - no dimensions (metrics are stack-scoped via the namespace);
 *   - a write failure or a rejected name is non-fatal and PII-free — auth and
 *     bootstrap flows must never break because a metric line could not be
 *     emitted.
 *
 * `mapAuthEventToMetrics` is the single event-type -> metric table plus the
 * emission policy (nothing on `local`, the security counts on every other
 * stack); `AuthEventsRepository.record()` calls it after a durable AuthEvent
 * write and feeds each result here.
 */
import fs from 'node:fs';

import type { AuthEventType } from '../dynamo/types.js';

/** A single standard-resolution `Count` datapoint destined for one namespace. */
export interface MetricSpec {
  /** CloudWatch namespace, e.g. `Retivo/prod/Security`. */
  namespace: string;
  /** Allow-listed metric name (see `ALLOWED_METRIC_NAMES`). */
  name: string;
  /** Datapoint value; always `1` for the event-time metrics. */
  value: number;
}

/**
 * The exhaustive set of metric names this writer will emit. Anything else is
 * rejected before a byte reaches stdout, so a caller can never publish an
 * arbitrary (potentially high-cardinality or user-derived) metric name.
 */
const ALLOWED_METRIC_NAMES: ReadonlySet<string> = new Set([
  'LoginFailed',
  'MfaVerifyFailed',
  'RefreshTokenReuse',
  // The shared DynamoDB-backed throttle
  // counter fell back to instance-local counting for a degradation episode.
  'ThrottleStoreDegraded',
]);

/**
 * Emit one EMF metric line. Rejects a non-allow-listed name and reads only the
 * three known `MetricSpec` fields, so an arbitrary extra field on the argument
 * object can never be written. Never throws.
 */
export function emitOperationalMetric(spec: MetricSpec): void {
  try {
    if (!ALLOWED_METRIC_NAMES.has(spec.name)) {
      // PII-free: the rejected name is one of ours or a coding mistake, not
      // user data — but we still don't echo it into the fallback line.
      console.error('operational-metrics: rejected non-allow-listed metric name');
      return;
    }
    // Build the EMF body from known fields ONLY — no spread of `spec`, so an
    // arbitrary extra field on the argument is never serialized to stdout.
    const emf = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: spec.namespace,
            Dimensions: [[]],
            Metrics: [{ Name: spec.name, Unit: 'Count' }],
          },
        ],
      },
      [spec.name]: spec.value,
    };
    // Synchronous fd-1 write (`fs.writeSync`), NOT `process.stdout.write`.
    // Under Lambda's freeze-after-return execution model stdout is a pipe that
    // Node buffers in userland, so an async `process.stdout.write` issued near
    // the end of an invocation can sit unflushed when the environment freezes
    // and the metric line silently disappears — the exact failure the
    // logger.module.ts SonicBoom `sync: true` destination repairs. `writeSync`
    // hands the bytes to the OS before this call returns, keeping the writer
    // dependency-free (no pino/SonicBoom import here) as the file header intends.
    fs.writeSync(1, `${JSON.stringify(emf)}\n`);
  } catch {
    // A failed synchronous write (e.g. EPIPE) must never break the
    // auth/bootstrap flow. Emit a fixed, PII-free breadcrumb and swallow.
    console.error('operational-metrics: failed to write metric line');
  }
}

/**
 * Map a durably-recorded AuthEvent to the operational metrics it should emit:
 *   - `local`/unset stack: emit nothing.
 *   - every other stack name: emit only the three security metrics
 *     (LoginFailed, MfaVerifyFailed, RefreshTokenReuse) that the security
 *     alarms read.
 *
 * Every event type not in the table (successful login, signup, account
 * deletion, refresh, step-up, password change, MFA-challenge issuance, etc.)
 * maps to nothing. Security metrics carry the per-stack `Retivo/<stack>/
 * Security` namespace.
 */
export function mapAuthEventToMetrics(
  eventType: AuthEventType,
  stack: string,
): MetricSpec[] {
  if (stack === 'local') return [];
  const securityNamespace = `Retivo/${stack}/Security`;

  // Security metrics — emitted on every non-local stack.
  switch (eventType) {
    case 'login_failed':
      return [{ namespace: securityNamespace, name: 'LoginFailed', value: 1 }];
    case 'mfa_totp_failed':
    case 'mfa_email_otp_failed':
    // Historical-only classification retained for old audit-event replay.
    case 'mfa_backup_code_failed':
    // Per-account TOTP lock threshold crossing — no
    // new metric name/alarm; mapped onto the same existing metric.
    case 'mfa_totp_locked':
      return [{ namespace: securityNamespace, name: 'MfaVerifyFailed', value: 1 }];
    case 'refresh_reuse_detected':
      return [
        { namespace: securityNamespace, name: 'RefreshTokenReuse', value: 1 },
      ];
    default:
      return [];
  }
}
