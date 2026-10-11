/**
 * Unit tests for the standalone health-check probe Lambda.
 *
 * `fetch` is stubbed per test (no network). We assert the HealthCheckStatus
 * value the handler emits + returns for each branch:
 *   - HTTP 200 → 1
 *   - non-2xx → 0
 *   - thrown error (network failure / abort) → 0
 *   - missing API_ENDPOINT → 0 (caught before any fetch attempt)
 * plus the EMF JSON structure.
 */
import 'reflect-metadata';
import type { Context } from 'aws-lambda';
import { handler } from './health-check-probe-lambda.js';

const CONTEXT = {} as Context;
const EVENT = {} as Parameters<typeof handler>[0];

interface EmfLine {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: Array<{
      Namespace: string;
      Dimensions: string[][];
      Metrics: Array<{ Name: string; Unit: string }>;
    }>;
  };
  HealthCheckStatus: number;
}

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      lines.push(chunk.toString());
      return true;
    });
  return { lines, restore: () => spy.mockRestore() };
}

const ENDPOINT = 'https://dist.cloudfront.net';

describe('health-check probe Lambda', () => {
  const realFetch = global.fetch;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.API_ENDPOINT = ENDPOINT;
    process.env.STACK = 'test';
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.API_ENDPOINT;
    delete process.env.STACK;
    jest.restoreAllMocks();
  });

  it('emits HealthCheckStatus=1 on HTTP 200 and calls the /api/v1/health URL', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { lines, restore } = captureStdout();

    const result = await handler(EVENT, CONTEXT, () => undefined);
    restore();

    expect(result).toEqual({ status: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${ENDPOINT}/api/v1/health`);

    const emf = JSON.parse(lines[0].trim()) as EmfLine;
    expect(emf.HealthCheckStatus).toBe(1);
    expect(emf._aws.CloudWatchMetrics[0].Namespace).toBe(
      'Retivo/test/HealthCheck',
    );
    expect(emf._aws.CloudWatchMetrics[0].Metrics[0].Name).toBe(
      'HealthCheckStatus',
    );
  });

  it('emits HealthCheckStatus=0 on a non-2xx response', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    const { lines, restore } = captureStdout();

    const result = await handler(EVENT, CONTEXT, () => undefined);
    restore();

    expect(result).toEqual({ status: 0 });
    expect((JSON.parse(lines[0].trim()) as EmfLine).HealthCheckStatus).toBe(0);
  });

  it('emits HealthCheckStatus=0 on a thrown fetch error (network failure)', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    const { lines, restore } = captureStdout();

    const result = await handler(EVENT, CONTEXT, () => undefined);
    restore();

    expect(result).toEqual({ status: 0 });
    expect((JSON.parse(lines[0].trim()) as EmfLine).HealthCheckStatus).toBe(0);
    expect(errSpy).toHaveBeenCalled();
  });

  it('emits HealthCheckStatus=0 without attempting fetch when API_ENDPOINT is unset', async () => {
    delete process.env.API_ENDPOINT;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { lines, restore } = captureStdout();

    const result = await handler(EVENT, CONTEXT, () => undefined);
    restore();

    expect(result).toEqual({ status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((JSON.parse(lines[0].trim()) as EmfLine).HealthCheckStatus).toBe(0);
    expect(errSpy).toHaveBeenCalled();
  });
});
