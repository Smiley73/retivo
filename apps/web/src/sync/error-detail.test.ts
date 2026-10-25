// Pins each error-classification helper's input-to-output behaviour independently of the SyncContext integration suites.
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

  it('is true for UnauthenticatedPayloadError, and records a payload-free breadcrumb', () => {
    expect(
      isRollbackDetectedRejection(new UnauthenticatedPayloadError('pull', 'not-envelope')),
    ).toBe(true);
    const entries = getEntries();
    const last = entries.at(-1);
    expect(last?.source).toBe('sync');
    expect(last?.namespace).toBe('sync');
    expect(last?.message).toBe(
      'rejected served payload — pull/not-envelope: not authenticated, no local write',
    );
  });
});

describe('setOnRollbackDetectedOutsideSync / notifyRollbackDetectedOutsideSync', () => {
  afterEach(() => setOnRollbackDetectedOutsideSync(() => {}));

  // The forced-export transport catches a rollback-detected rejection outside the poll, so this hook must be able to flip the shared badge.
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
