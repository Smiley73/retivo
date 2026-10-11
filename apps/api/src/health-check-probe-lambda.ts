/**
 * Standalone health-check probe Lambda.
 *
 * The EventBridge schedule that invoked this every 5 minutes is DISABLED on
 * both stacks (the probe was the largest scheduled consumer of the
 * account's shared Lambda concurrency quota) — the code is kept so
 * re-enabling the schedule is a one-word change. Calls the public shallow
 * `${API_ENDPOINT}/api/v1/health` endpoint with native `fetch` and emits a
 * `HealthCheckStatus` metric (1 = healthy, 0 = unhealthy) to CloudWatch via
 * Embedded Metric Format (one JSON line to stdout; CloudWatch Logs
 * auto-extracts it — no `cloudwatch:PutMetricData` grant needed).
 *
 * `API_ENDPOINT` is the CloudFront distribution domain
 * (`https://<dist>.cloudfront.net`), NOT the raw API Gateway host: only
 * CloudFront injects the `X-Origin-Verify` header the edge-auth middleware
 * requires, so a direct API GW call would be rejected.
 *
 * Standalone — no NestJS bootstrap. The probe is a single fetch + metric
 * emit; the framework cold-start cost is not worth it. Every failure mode
 * (non-2xx, network error, missing API_ENDPOINT) maps to
 * HealthCheckStatus=0 with no thrown error, so the alarm — not a Lambda
 * crash loop — is the signal.
 *
 * Namespace: `Retivo/${STACK}/HealthCheck`.
 */
import 'reflect-metadata';
import type { Handler, ScheduledEvent } from 'aws-lambda';

// Bounded outbound call (repo non-negotiable: every outbound call is
// time-bounded). 5s is ample for a shallow /health probe
// and stays well inside the Lambda timeout.
const FETCH_TIMEOUT_MS = 5_000;

interface HealthCheckResult {
  status: number;
}

async function probe(): Promise<number> {
  const endpoint = process.env.API_ENDPOINT;
  if (!endpoint) {
    // Misconfiguration is an unhealthy signal, not a crash — emit 0 and
    // surface the cause in logs so the alarm fires and the operator sees why.
    console.error('health-check probe: API_ENDPOINT is not set');
    return 0;
  }

  const url = `${endpoint}/api/v1/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok ? 1 : 0;
  } catch (err) {
    console.error(
      `health-check probe: fetch failed: ${err instanceof Error ? err.message : 'unknown'}`,
    );
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Emit the HealthCheckStatus EMF metric. Stack-scoped via the
 * namespace; no dimensions.
 */
function emit(status: number): void {
  const stack = process.env.STACK ?? 'local';
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: `Retivo/${stack}/HealthCheck`,
          Dimensions: [[]],
          Metrics: [{ Name: 'HealthCheckStatus', Unit: 'None' }],
        },
      ],
    },
    HealthCheckStatus: status,
  };
  process.stdout.write(`${JSON.stringify(emf)}\n`);
}

export const handler: Handler<ScheduledEvent, HealthCheckResult> = async () => {
  const status = await probe();
  emit(status);
  return { status };
};
