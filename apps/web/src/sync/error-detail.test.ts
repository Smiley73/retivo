/**
 * Characterization tests for the error-classification helpers split out of
 * SyncContext.tsx to keep that file under the shape limit. These pin each function's CURRENT
 * input→output behavior as a regression net independent of the
 * CPU-load-sensitive `SyncContext.test.tsx` integration suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FreshnessError } from '../crypto/freshness';
import { SyncApiError, FreshnessRollbackError } from './sync-client';
import { SchemaAheadError, UnauthenticatedPayloadError } from './pull-apply';
import {
  buildErrorDetail,
  handleSchemaAhead,
  isRollbackDetectedRejection,
  notifyRollbackDetectedOutsideSync,
  setOnRollbackDetectedOutsideSync,
} from './error-detail';
import { clear as clearDiagnostics, getEntries } from '../lib/diagnostics/logger';

describe('buildErrorDetail', () => {
  it('flows the full SyncApiError envelope through (code/message/status/traceId)', () => {
    const err = new SyncApiError('DEVICE_MISMATCH', 'Device mismatch', 409, 'trace-1');
    expect(buildErrorDetail(err, 'push', 'fallback')).toEqual({
      phase: 'push',
      code: 'DEVICE_MISMATCH',
      message: 'Device mismatch',
      status: 409,
      traceId: 'trace-1',
    });
  });

  it('uses the plain Error message when not a SyncApiError', () => {
    expect(buildErrorDetail(new Error('boom'), 'pull', 'fallback')).toEqual({
      phase: 'pull',
      message: 'boom',
    });
  });

  it('falls back to fallbackMessage for a non-Error thrown value', () => {
    expect(buildErrorDetail('not an error', 'bootstrap', 'fallback')).toEqual({
      phase: 'bootstrap',
      message: 'fallback',
    });
  });
});

describe('isRollbackDetectedRejection', () => {
  beforeEach(() => clearDiagnostics());
  afterEach(() => clearDiagnostics());

  it('is true for FreshnessRollbackError', () => {
    expect(isRollbackDetectedRejection(new FreshnessRollbackError(1, 2))).toBe(true);
  });

  it('is true for FreshnessError', () => {
    expect(isRollbackDetectedRejection(new FreshnessError('mac failure'))).toBe(true);
  });

  it('is false for an unrelated error', () => {
    expect(isRollbackDetectedRejection(new Error('other'))).toBe(false);
  });

  // The transport guard's dedicated error also maps to the
  // rollback-detected badge, and the rejection is recorded via the shared
  // diagnostics helper with the phase/reason only — never payload content.
  it('is true for UnauthenticatedPayloadError, and records a payload-free breadcrumb', () => {
    expect(
      isRollbackDetectedRejection(new UnauthenticatedPayloadError('pull', 'not-envelope')),
    ).toBe(true);
    const entries = getEntries();
    const last = entries.at(-1);
    expect(last?.source).toBe('sync');
    // Built from the phase/reason only — no payload content was ever passed in
    // (the `[sync]` prefix is parsed off into `namespace` by the logger).
    expect(last?.namespace).toBe('sync');
    expect(last?.message).toBe(
      'rejected served payload — pull/not-envelope: not authenticated, no local write',
    );
  });
});

describe('setOnRollbackDetectedOutsideSync / notifyRollbackDetectedOutsideSync', () => {
  afterEach(() => setOnRollbackDetectedOutsideSync(() => {}));

  // The forced-export transport (createExportSyncTransport)
  // catches a rollback-detected rejection outside SyncProvider's own
  // pull/bootstrap poll, so it must be able to flip the shared badge through
  // this hook rather than silently leaving it `synced`.
  it('invokes the registered handler when notified', () => {
    let called = false;
    setOnRollbackDetectedOutsideSync(() => {
      called = true;
    });
    notifyRollbackDetectedOutsideSync();
    expect(called).toBe(true);
  });

  it('is a no-op when nothing is registered', () => {
    setOnRollbackDetectedOutsideSync(() => {});
    expect(() => notifyRollbackDetectedOutsideSync()).not.toThrow();
  });
});

describe('handleSchemaAhead', () => {
  it('builds a pull-phase SCHEMA_AHEAD detail naming both versions', () => {
    const err = new SchemaAheadError('account', 5, 3);
    const detail = handleSchemaAhead(err);
    expect(detail).toEqual({
      phase: 'pull',
      code: 'SCHEMA_AHEAD',
      message: 'account payload is at v5; this app only knows v3. Reload to update.',
    });
  });
});
