// The EMF operational-metrics writer: exact JSON shape, no dimensions, allow-list enforcement (a non-allow-listed name or an extra field never reaches stdout), and non-fatal PII-free failure handling.
import fs from 'node:fs';

import { emitOperationalMetric } from './operational-metrics.js';

type MetricSpec = Parameters<typeof emitOperationalMetric>[0];

interface EmfLine {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: {
      Namespace: string;
      Dimensions: string[][];
      Metrics: { Name: string; Unit: string }[];
    }[];
  };
  [key: string]: unknown;
}

// The writer emits with `fs.writeSync(1, ...)`, not `process.stdout.write`, so a line cannot sit in a userland buffer when Lambda freezes; capture at that layer for fd 1
// and pass other fds through, returning the byte length so the writer never loops on a perceived partial write.
function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const realWriteSync = fs.writeSync.bind(fs);
  const spy = jest.spyOn(fs, 'writeSync').mockImplementation(((
    fd: number,
    data: unknown,
    ...rest: unknown[]
  ): number => {
    if (fd === 1) {
      const raw = String(data);
      lines.push(raw);
      return Buffer.byteLength(raw);
    }
    return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
  }) as unknown as typeof fs.writeSync);
  return { lines, restore: () => spy.mockRestore() };
}

describe('emitOperationalMetric', () => {
  it('should_write_exact_emf_json_with_no_dimensions', () => {
    const cap = captureStdout();
    try {
      emitOperationalMetric({
        namespace: 'Retivo/prod/Security',
        name: 'LoginFailed',
        value: 1,
      });
      expect(cap.lines).toHaveLength(1);
      expect(cap.lines[0].endsWith('\n')).toBe(true);
      const parsed = JSON.parse(cap.lines[0]) as EmfLine;
      const metricDef = parsed._aws.CloudWatchMetrics[0];
      expect(metricDef.Namespace).toBe('Retivo/prod/Security');
      expect(metricDef.Dimensions).toEqual([[]]);
      expect(metricDef.Metrics).toEqual([{ Name: 'LoginFailed', Unit: 'Count' }]);
      expect(parsed.LoginFailed).toBe(1);
      expect(typeof parsed._aws.Timestamp).toBe('number');
    } finally {
      cap.restore();
    }
  });

  it('should_reject_non_allowlisted_metric_name_without_writing_stdout', () => {
    const cap = captureStdout();
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      emitOperationalMetric({
        namespace: 'Retivo/prod/Security',
        name: 'ArbitraryUserMetric',
        value: 1,
      });
      expect(cap.lines).toHaveLength(0);
      expect(errSpy).toHaveBeenCalledTimes(1);
      // The fallback breadcrumb carries no name or value (PII-free).
      expect(String(errSpy.mock.calls[0][0])).not.toContain('ArbitraryUserMetric');
    } finally {
      errSpy.mockRestore();
      cap.restore();
    }
  });

  it.each([
    'LoginSucceeded',
    'SignupSucceeded',
    'AccountDeletionCompleted',
    'ForcedBootstrap',
  ])('should_reject_the_removed_metric_%s_without_writing_stdout', (name) => {
    const cap = captureStdout();
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      emitOperationalMetric({ namespace: 'Retivo/prod/Security', name, value: 1 });
      expect(cap.lines).toHaveLength(0);
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
      cap.restore();
    }
  });

  it('should_never_serialize_an_arbitrary_extra_field_on_the_spec', () => {
    const cap = captureStdout();
    try {
      // A caller sneaks an extra property past the type via a cast.
      emitOperationalMetric({
        namespace: 'Retivo/prod/Security',
        name: 'RefreshTokenReuse',
        value: 1,
        userEmail: 'victim@example.com',
      } as MetricSpec & { userEmail: string });
      expect(cap.lines).toHaveLength(1);
      expect(cap.lines[0]).not.toContain('victim@example.com');
      expect(cap.lines[0]).not.toContain('userEmail');
    } finally {
      cap.restore();
    }
  });

  it('should_swallow_a_synchronous_write_failure_without_pii', () => {
    const realWriteSync = fs.writeSync.bind(fs);
    const writeSpy = jest.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      data: unknown,
      ...rest: unknown[]
    ): number => {
      if (fd === 1) {
        // A synchronous fd-1 write can still throw (e.g. EPIPE); the writer must stay non-fatal.
        throw new Error('EPIPE');
      }
      return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
    }) as unknown as typeof fs.writeSync);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() =>
        emitOperationalMetric({
          namespace: 'Retivo/prod/Security',
          name: 'LoginFailed',
          value: 1,
        }),
      ).not.toThrow();
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(String(errSpy.mock.calls[0][0])).not.toContain('LoginFailed');
    } finally {
      errSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });
});
