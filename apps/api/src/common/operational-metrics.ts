// Dependency-free CloudWatch EMF writer for event-time operational metrics (one stdout JSON line, no PutMetricData grant). Only
// allow-listed names are written; a failure is non-fatal and PII-free.
import fs from 'node:fs';

import type { AuthEventType } from '../dynamo/types.js';

interface MetricSpec {
  /** CloudWatch namespace, e.g. `Retivo/prod/Security`. */
  namespace: string;
  /** Allow-listed metric name (see `ALLOWED_METRIC_NAMES`). */
  name: string;
  /** Datapoint value; always `1` for the event-time metrics. */
  value: number;
}

// The exhaustive set of metric names the writer emits, so a caller can never publish an arbitrary or user-derived
// name.
const ALLOWED_METRIC_NAMES: ReadonlySet<string> = new Set([
  'LoginFailed',
  'MfaVerifyFailed',
  'RefreshTokenReuse',
  // The shared DynamoDB-backed throttle counter fell back to instance-local counting.
  'ThrottleStoreDegraded',
]);

/**
 * Emits one EMF metric line, rejecting a non-allow-listed name and reading only the three known `MetricSpec` fields.
 * Never throws.
 */
export function emitOperationalMetric(spec: MetricSpec): void {
  try {
    if (!ALLOWED_METRIC_NAMES.has(spec.name)) {
      // PII-free: the rejected name is ours or a coding mistake, but it is not echoed into the fallback line.
      console.error('operational-metrics: rejected non-allow-listed metric name');
      return;
    }
    // Build the body from known fields only, so an extra field on the argument is never serialized.
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
    // Synchronous fd-1 write, not `process.stdout.write`: under Lambda freeze an async write can sit unflushed and
    // vanish (the failure logger.module.ts SonicBoom `sync: true` repairs). Keeps the writer dependency-free.
    fs.writeSync(1, `${JSON.stringify(emf)}\n`);
  } catch {
    // A failed write (e.g. EPIPE) must never break the auth or bootstrap flow: emit a fixed breadcrumb and swallow.
    console.error('operational-metrics: failed to write metric line');
  }
}

/**
 * Maps a recorded AuthEvent to its operational metrics: nothing on `local`, and on every other stack only the
 * security counts (LoginFailed, MfaVerifyFailed, RefreshTokenReuse) under `Retivo/<stack>/Security`.
 */
export function mapAuthEventToMetrics(
  eventType: AuthEventType,
  stack: string,
): MetricSpec[] {
  if (stack === 'local') return [];
  const securityNamespace = `Retivo/${stack}/Security`;

  // Emitted on every non-local stack.
  switch (eventType) {
    case 'login_failed':
      return [{ namespace: securityNamespace, name: 'LoginFailed', value: 1 }];
    case 'mfa_totp_failed':
    case 'mfa_email_otp_failed':
    // Historical-only classification retained for old audit-event replay.
    case 'mfa_backup_code_failed':
    // Maps onto the existing MfaVerifyFailed metric; no new alarm.
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
