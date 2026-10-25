// Health-check probe Lambda (schedule disabled): fetches `${API_ENDPOINT}/api/v1/health` and emits a HealthCheckStatus EMF metric;
// every failure maps to 0, never a throw. API_ENDPOINT is the CloudFront domain, which injects X-Origin-Verify.
import 'reflect-metadata';
import type { Handler, ScheduledEvent } from 'aws-lambda';

// Bounded outbound call; 5 s is ample for a shallow probe.
const FETCH_TIMEOUT_MS = 5_000;

interface HealthCheckResult {
  status: number;
}

async function probe(): Promise<number> {
  const endpoint = process.env.API_ENDPOINT;
  if (!endpoint) {
    // Misconfiguration is an unhealthy signal, not a crash: emit 0 so the alarm fires.
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
