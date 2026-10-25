// Event-time metric mapping through AuthEventsRepository.record(), the single emission point, with a stubbed doc client and config: every selected event family, each MFA-failure subtype, the security mappings per stack,
// no metric for login/passkey_assert/signup/account_deletion_completed or on a failed durable write, and no high-cardinality userId in EMF.
import fs from 'node:fs';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ConfigService } from '@nestjs/config';
import type { EnvConfig } from '../common/env.config.js';
import { AuthEventsRepository } from './auth-events.repository.js';
import type { AuthEventType } from './types.js';

const HIGH_CARDINALITY_USER_ID = 'user-abc-123-should-never-be-in-emf';

interface CapturedMetric {
  namespace: string;
  name: string;
  value: number;
  raw: string;
}

function buildRepo(
  stack: string,
  send: () => Promise<unknown>,
): AuthEventsRepository {
  const doc = { send: jest.fn(send) } as unknown as DynamoDBDocumentClient;
  const config = {
    get: (key: string) => (key === 'STACK' ? stack : 'auth-event-table'),
  } as unknown as ConfigService<EnvConfig, true>;
  return new AuthEventsRepository(doc, config);
}

async function recordAndCapture(
  stack: string,
  eventType: AuthEventType,
  send: () => Promise<unknown> = () => Promise.resolve({}),
): Promise<CapturedMetric[]> {
  const captured: CapturedMetric[] = [];
  // The writer emits EMF via `fs.writeSync(1, ...)` (see common/operational-metrics.ts), so capture at that layer and pass other fds through.
  const realWriteSync = fs.writeSync.bind(fs);
  const spy = jest.spyOn(fs, 'writeSync').mockImplementation(((
    fd: number,
    data: unknown,
    ...rest: unknown[]
  ): number => {
    if (fd !== 1) {
      return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
    }
    const raw = String(data);
    // fd 1 also carries the Nest console-logger's failure warning on the rejected-write path; only EMF metric lines are captured.
    let parsed: {
      _aws?: { CloudWatchMetrics: { Namespace: string; Metrics: { Name: string }[] }[] };
      [key: string]: unknown;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return Buffer.byteLength(raw);
    }
    if (!parsed._aws) return Buffer.byteLength(raw);
    const def = parsed._aws.CloudWatchMetrics[0];
    const name = def.Metrics[0].Name;
    captured.push({
      namespace: def.Namespace,
      name,
      value: parsed[name] as number,
      raw,
    });
    return Buffer.byteLength(raw);
  }) as unknown as typeof fs.writeSync);
  try {
    const repo = buildRepo(stack, send);
    await repo.record({ userId: HIGH_CARDINALITY_USER_ID, eventType });
  } finally {
    spy.mockRestore();
  }
  return captured;
}

describe('AuthEventsRepository event-time metrics', () => {
  describe('production (security mappings only)', () => {
    it.each<AuthEventType>([
      'login',
      'passkey_assert',
      'signup',
      'account_deletion_completed',
    ])('should_emit_nothing_for_the_removed_activity_event_%s', async (eventType) => {
      const metrics = await recordAndCapture('prod', eventType);
      expect(metrics).toHaveLength(0);
    });

    it('should_emit_LoginFailed_in_the_prod_security_namespace', async () => {
      const metrics = await recordAndCapture('prod', 'login_failed');
      expect(metrics).toEqual([
        expect.objectContaining({
          namespace: 'Retivo/prod/Security',
          name: 'LoginFailed',
          value: 1,
        }),
      ]);
    });

    it('should_emit_RefreshTokenReuse_for_refresh_reuse_detected', async () => {
      const metrics = await recordAndCapture('prod', 'refresh_reuse_detected');
      expect(metrics).toEqual([
        expect.objectContaining({
          namespace: 'Retivo/prod/Security',
          name: 'RefreshTokenReuse',
          value: 1,
        }),
      ]);
    });

    it.each<AuthEventType>([
      'mfa_totp_failed',
      'mfa_email_otp_failed',
      // Historical-only event retained for audit replay.
      'mfa_backup_code_failed',
      // Per-account TOTP lock threshold crossing, mapped onto an existing metric.
      'mfa_totp_locked',
    ])('should_map_%s_to_a_single_MfaVerifyFailed', async (eventType) => {
      const metrics = await recordAndCapture('prod', eventType);
      expect(metrics).toEqual([
        expect.objectContaining({
          namespace: 'Retivo/prod/Security',
          name: 'MfaVerifyFailed',
          value: 1,
        }),
      ]);
    });
  });

  describe('dev (security mappings only)', () => {
    it('should_emit_the_three_security_metrics_in_the_dev_namespace', async () => {
      const failed = await recordAndCapture('dev', 'login_failed');
      expect(failed).toEqual([
        expect.objectContaining({
          namespace: 'Retivo/dev/Security',
          name: 'LoginFailed',
        }),
      ]);
      const mfa = await recordAndCapture('dev', 'mfa_totp_failed');
      expect(mfa).toEqual([
        expect.objectContaining({
          namespace: 'Retivo/dev/Security',
          name: 'MfaVerifyFailed',
        }),
      ]);
      const reuse = await recordAndCapture('dev', 'refresh_reuse_detected');
      expect(reuse).toEqual([
        expect.objectContaining({
          namespace: 'Retivo/dev/Security',
          name: 'RefreshTokenReuse',
        }),
      ]);
    });

    it.each<AuthEventType>(['login', 'passkey_assert', 'signup', 'account_deletion_completed'])(
      'should_suppress_the_removed_activity_metric_%s_in_dev',
      async (eventType) => {
        const metrics = await recordAndCapture('dev', eventType);
        expect(metrics).toHaveLength(0);
      },
    );
  });

  describe('any other non-local stack name', () => {
    it('should_still_emit_the_security_metrics_in_that_stacks_namespace', async () => {
      const failed = await recordAndCapture('staging', 'login_failed');
      expect(failed).toEqual([
        expect.objectContaining({
          namespace: 'Retivo/staging/Security',
          name: 'LoginFailed',
        }),
      ]);
      const mfa = await recordAndCapture('staging', 'mfa_totp_failed');
      expect(mfa).toEqual([
        expect.objectContaining({
          namespace: 'Retivo/staging/Security',
          name: 'MfaVerifyFailed',
        }),
      ]);
      const reuse = await recordAndCapture('staging', 'refresh_reuse_detected');
      expect(reuse).toEqual([
        expect.objectContaining({
          namespace: 'Retivo/staging/Security',
          name: 'RefreshTokenReuse',
        }),
      ]);
    });
  });

  describe('negatives', () => {
    it('should_emit_nothing_for_a_local_stack', async () => {
      for (const eventType of ['login', 'login_failed', 'signup'] as AuthEventType[]) {
        const metrics = await recordAndCapture('local', eventType);
        expect(metrics).toHaveLength(0);
      }
    });

    it.each<AuthEventType>(['logout', 'refresh', 'mfa_challenge_issued', 'password_change'])(
      'should_emit_nothing_for_the_unrelated_event_%s',
      async (eventType) => {
        const metrics = await recordAndCapture('prod', eventType);
        expect(metrics).toHaveLength(0);
      },
    );

    it('should_not_emit_any_metric_when_the_durable_write_fails', async () => {
      const metrics = await recordAndCapture('prod', 'login_failed', () =>
        Promise.reject(new Error('dynamo down')),
      );
      expect(metrics).toHaveLength(0);
    });
  });

  it('should_not_leak_the_userId_into_the_emf_line', async () => {
    const metrics = await recordAndCapture('prod', 'login_failed');
    expect(metrics).toHaveLength(1);
    expect(metrics[0].raw).not.toContain(HIGH_CARDINALITY_USER_ID);
  });

  describe('listForUser — consistent reads', () => {
    it('should_query_with_ConsistentRead_true_so_the_account_export_cannot_miss_a_just-written_row_under_replica_lag', async () => {
      const send = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
      const doc = { send } as unknown as DynamoDBDocumentClient;
      const config = {
        get: (key: string) => (key === 'STACK' ? 'prod' : 'auth-event-table'),
      } as unknown as ConfigService<EnvConfig, true>;
      const repo = new AuthEventsRepository(doc, config);

      await repo.listForUser('user-1');

      expect(send).toHaveBeenCalledTimes(1);
      const command = send.mock.calls[0][0] as { input: Record<string, unknown> };
      expect(command.input).toMatchObject({ ConsistentRead: true });
    });
  });

  describe('listForUser — page size', () => {
    it('should_send_no_Limit_by_default_so_DynamoDB_pages_by_its_own_1MB_cap_instead_of_an_artificial_row_count', async () => {
      const send = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
      const doc = { send } as unknown as DynamoDBDocumentClient;
      const config = {
        get: (key: string) => (key === 'STACK' ? 'prod' : 'auth-event-table'),
      } as unknown as ConfigService<EnvConfig, true>;
      const repo = new AuthEventsRepository(doc, config);

      await repo.listForUser('user-1');

      const command = send.mock.calls[0][0] as { input: Record<string, unknown> };
      expect(command.input.Limit).toBeUndefined();
    });

    it('should_honor_an_explicit_opts.limit_when_a_caller_passes_one', async () => {
      const send = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: undefined });
      const doc = { send } as unknown as DynamoDBDocumentClient;
      const config = {
        get: (key: string) => (key === 'STACK' ? 'prod' : 'auth-event-table'),
      } as unknown as ConfigService<EnvConfig, true>;
      const repo = new AuthEventsRepository(doc, config);

      await repo.listForUser('user-1', { limit: 50 });

      const command = send.mock.calls[0][0] as { input: Record<string, unknown> };
      expect(command.input.Limit).toBe(50);
    });
  });
});
