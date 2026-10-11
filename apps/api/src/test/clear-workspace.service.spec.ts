/**
 * Unit tests for ClearWorkspaceService. Built
 * with pure stubs (no AppModule / emulator) so it exercises the decisive
 * password-gate branches directly:
 *   - the reverify user-not-found guard: a JWT-valid claim whose User row is
 *     gone → 401 INVALID_CREDENTIALS, no sweep, exactly one
 *     workspace_clear_failed audit;
 *   - the workspace_clear_failed `metadata.reason` classification
 *     (invalid_credentials / login_backoff / server_error) — a refused person
 *     and an infra fault must stay distinguishable in the audit trail;
 *   - the backend-fault rethrow: a non-INVALID_CREDENTIALS fault from
 *     the verify closure propagates raw (never folded to a 401), sweeps
 *     nothing;
 *   - the mid-flight fault closure: a sweep/mint/repoint fault appends
 *     _failed (reason server_error) so a _started never dangles.
 *
 * The full HTTP + DynamoDB + S3 audit sequencing is covered end-to-end by
 * clear-workspace.spec.ts and clear-workspace-purge-order.spec.ts.
 */
import 'reflect-metadata';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { ClearWorkspaceService } from '../sync/clear-workspace.service.js';
import type { AccessTokenClaims } from '../auth/jwt.service.js';
import type { VerifyPasswordService } from '../auth/verify-password.service.js';
import type { AuthEventsRepository } from '../dynamo/auth-events.repository.js';
import type { UsersRepository } from '../dynamo/users.repository.js';
import type { RestoreService } from '../sync/restore.service.js';

const ME = {
  userId: 'user-1',
  householdId: 'household-1',
  deviceId: 'device-1',
} as unknown as AccessTokenClaims;

interface Harness {
  service: ClearWorkspaceService;
  findById: jest.Mock;
  verify: jest.Mock;
  record: jest.Mock;
  clearToEmpty: jest.Mock;
  purgeHistory: jest.Mock;
}

function makeService(): Harness {
  const findById = jest.fn();
  // Backoff now lives INSIDE VerifyPasswordService.verify(): the
  // service calls it directly, so a wrong password / lockout / backend fault is
  // whatever `verify` throws (401 INVALID_CREDENTIALS / 429 LOGIN_BACKOFF / a
  // raw fault). No outer verifyWithBackoff wrap remains here.
  const verify = jest.fn().mockResolvedValue(undefined);
  const record = jest.fn().mockResolvedValue(undefined);
  const clearToEmpty = jest.fn().mockResolvedValue({ historyErased: false });
  const purgeHistory = jest.fn().mockResolvedValue({ historyErased: false });
  const service = new ClearWorkspaceService(
    { findById } as unknown as UsersRepository,
    { verify } as unknown as VerifyPasswordService,
    { record } as unknown as AuthEventsRepository,
    { clearToEmpty, purgeHistory } as unknown as RestoreService,
  );
  return {
    service,
    findById,
    verify,
    record,
    clearToEmpty,
    purgeHistory,
  };
}

describe('ClearWorkspaceService — password reverify', () => {
  it('rejects with 401 INVALID_CREDENTIALS, sweeps nothing, and audits exactly one workspace_clear_failed when the User row is gone', async () => {
    const h = makeService();
    h.findById.mockResolvedValue(null); // JWT-valid claim, but the row is gone

    const err = await h.service
      .clearWorkspace(
        ME,
        { currentPassword: 'whatever', eraseHistory: false },
        '203.0.113.7',
        'jest',
      )
      .then(
        () => {
          throw new Error('expected the clear to reject');
        },
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getStatus()).toBe(401);
    expect((err as UnauthorizedException).getResponse()).toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });

    // The missing row short-circuits before any password check or sweep.
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.clearToEmpty).not.toHaveBeenCalled();
    expect(h.purgeHistory).not.toHaveBeenCalled();

    // Exactly one audit row, and it is workspace_clear_failed — never _started
    // (which lands only after a successful verify).
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        eventType: 'workspace_clear_failed',
        ip: '203.0.113.7',
        userAgent: 'jest',
        metadata: { householdId: 'household-1', reason: 'invalid_credentials' },
      }),
    );
  });

  it('rejects a wrong password with 401 INVALID_CREDENTIALS, sweeps nothing, and audits exactly one workspace_clear_failed', async () => {
    const h = makeService();
    h.findById.mockResolvedValue({ userId: 'user-1', emailLowercase: 'a@b.test' });
    // VerifyPasswordService throws INVALID_CREDENTIALS on a wrong password; the
    // reverify closure folds that to `false`, and verifyWithBackoff owns the
    // single 401 throw.
    h.verify.mockRejectedValue(
      new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is incorrect.',
      }),
    );

    const err = await h.service
      .clearWorkspace(
        ME,
        { currentPassword: 'WrongPassw0rd!', eraseHistory: false },
        '203.0.113.7',
        'jest',
      )
      .then(
        () => {
          throw new Error('expected the clear to reject');
        },
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getStatus()).toBe(401);
    expect((err as UnauthorizedException).getResponse()).toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });

    // A rejected password sweeps nothing and never emits _started.
    expect(h.clearToEmpty).not.toHaveBeenCalled();
    expect(h.purgeHistory).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'workspace_clear_failed',
        metadata: { householdId: 'household-1', reason: 'invalid_credentials' },
      }),
    );
  });

  it('audits a backoff lockout as workspace_clear_failed with reason login_backoff and rethrows the 429', async () => {
    const h = makeService();
    h.findById.mockResolvedValue({ userId: 'user-1', emailLowercase: 'a@b.test' });
    const lockout = new HttpException(
      { code: 'LOGIN_BACKOFF', message: 'Invalid password. Try again in 2s.' },
      429,
    );
    // The lockout now surfaces from inside VerifyPasswordService.verify().
    h.verify.mockRejectedValue(lockout);

    const err = await h.service
      .clearWorkspace(
        ME,
        { currentPassword: 'WrongPassw0rd!', eraseHistory: false },
        null,
        null,
      )
      .then(
        () => {
          throw new Error('expected the clear to reject');
        },
        (e: unknown) => e,
      );

    expect(err).toBe(lockout); // the 429 is preserved, not re-wrapped
    expect(h.clearToEmpty).not.toHaveBeenCalled();
    expect(h.purgeHistory).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'workspace_clear_failed',
        metadata: { householdId: 'household-1', reason: 'login_backoff' },
      }),
    );
  });

  it('propagates a backend fault raw (never folded to a 401), sweeps nothing, and audits reason server_error', async () => {
    const h = makeService();
    h.findById.mockResolvedValue({ userId: 'user-1', emailLowercase: 'a@b.test' });
    // A NON-INVALID_CREDENTIALS rejection: the verify closure must rethrow it
    // untouched (isInvalidCredentialsError → false) so a transient fault never
    // records a backoff failure or masquerades as a wrong password.
    const fault = new Error('DynamoDB unavailable');
    h.verify.mockRejectedValue(fault);

    const err = await h.service
      .clearWorkspace(
        ME,
        { currentPassword: 'correct-horse', eraseHistory: false },
        null,
        null,
      )
      .then(
        () => {
          throw new Error('expected the clear to reject');
        },
        (e: unknown) => e,
      );

    expect(err).toBe(fault);
    expect(h.clearToEmpty).not.toHaveBeenCalled();
    expect(h.purgeHistory).not.toHaveBeenCalled();
    // Exactly one audit row — _failed tagged as an infra fault, never _started.
    const events = h.record.mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
    expect(events).toEqual(['workspace_clear_failed']);
    expect(h.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'workspace_clear_failed',
        metadata: { householdId: 'household-1', reason: 'server_error' },
      }),
    );
  });

  it('closes the audit trail on a mid-flight fault: _started then _failed with reason server_error, error propagated', async () => {
    const h = makeService();
    h.findById.mockResolvedValue({ userId: 'user-1', emailLowercase: 'a@b.test' });
    const fault = new Error('sweep died mid-flight');
    h.clearToEmpty.mockRejectedValue(fault);

    const err = await h.service
      .clearWorkspace(
        ME,
        { currentPassword: 'correct-horse', eraseHistory: false },
        null,
        null,
      )
      .then(
        () => {
          throw new Error('expected the clear to reject');
        },
        (e: unknown) => e,
      );

    expect(err).toBe(fault);
    const events = h.record.mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
    // _started is closed by a _failed ending — it never dangles.
    expect(events).toEqual(['workspace_clear_started', 'workspace_clear_failed']);
    expect(h.record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: 'workspace_clear_failed',
        metadata: { householdId: 'household-1', reason: 'server_error' },
      }),
    );
  });

  it('on a correct password sweeps to empty and audits workspace_clear_started then _completed', async () => {
    const h = makeService();
    h.findById.mockResolvedValue({ userId: 'user-1', emailLowercase: 'a@b.test' });
    // verify resolves (no throw) → closure returns true → the clear proceeds.

    const res = await h.service.clearWorkspace(
      ME,
      { currentPassword: 'correct-horse', eraseHistory: false },
      null,
      null,
    );

    expect(res).toEqual({ ok: true, historyErased: false });
    expect(h.clearToEmpty).toHaveBeenCalledWith('household-1', {
      eraseHistory: false,
    });
    expect(h.purgeHistory).not.toHaveBeenCalled();
    const events = h.record.mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
    expect(events).toEqual([
      'workspace_clear_started',
      'workspace_clear_completed',
    ]);
  });
});
