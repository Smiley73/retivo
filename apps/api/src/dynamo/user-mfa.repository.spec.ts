/**
 * Integration tests for `UserMfaRepository` against DynamoDB Local.
 * Covers the get/put/update/delete contract:
 *  - get on a missing row returns null;
 *  - put round-trips the current TOTP row;
 *  - a raw legacy row with an unknown `backupCodes` attribute remains readable;
 *  - update applies a partial patch + stamps updatedAt without clobbering
 *    untouched attributes;
 *  - delete removes the row.
 *
 * Uses fresh userIds per case so suites stay independent on the shared
 * DynamoDB Local instance.
 */
import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { generateSecret, generateSync } from 'otplib';
import { createRepoTestEnv, type RepoTestEnv } from '../test/test-helpers.js';
import { UserMfaRepository } from './user-mfa.repository.js';
import { AuthEventsRepository } from './auth-events.repository.js';
import { MfaService } from '../auth/mfa.service.js';
import type { UserMfaRow } from './types.js';

describe('UserMfaRepository', () => {
  let env: RepoTestEnv;
  let repo: UserMfaRepository;

  beforeAll(async () => {
    env = await createRepoTestEnv();
    repo = new UserMfaRepository(env.doc, env.config);
  });

  afterAll(async () => {
    env.destroy();
  });

  it('returns null for a user with no MFA row', async () => {
    const got = await repo.get(randomUUID());
    expect(got).toBeNull();
  });

  it('round-trips a full row through put + get', async () => {
    const userId = randomUUID();
    const row: UserMfaRow = {
      userId,
      totpEnabled: true,
      totpSecret: 'JBSWY3DPEHPK3PXP',
      enrolledAt: '2026-06-12T00:00:00.000Z',
      lastVerifiedAt: '2026-06-12T01:00:00.000Z',
      updatedAt: '2026-06-12T01:00:00.000Z',
    };
    await repo.put(row);

    const got = await repo.get(userId);
    expect(got).toEqual(row);
  });

  it('reads current TOTP fields from a raw legacy row with an unknown backupCodes attribute', async () => {
    const userId = randomUUID();
    const totpSecret = generateSecret();
    const tableName = env.config.get('TABLE_USER_MFA', { infer: true });
    await env.doc.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          userId,
          totpEnabled: true,
          totpSecret,
          backupCodes: [{ hash: 'legacy-argon2-hash' }],
          enrolledAt: '2026-06-12T00:00:00.000Z',
          updatedAt: '2026-06-12T01:00:00.000Z',
        },
      }),
    );

    const got = await repo.get(userId);
    expect(got).toMatchObject({
      userId,
      totpEnabled: true,
      totpSecret,
      enrolledAt: '2026-06-12T00:00:00.000Z',
    });
    const mfa = new MfaService(repo, new AuthEventsRepository(env.doc, env.config));
    expect(await mfa.verifyTotp(userId, generateSync({ secret: totpSecret }))).toBe(true);
    expect(await mfa.getStatus(userId)).not.toHaveProperty('backupCodesCount');
  });

  it('applies a partial update and stamps updatedAt without clobbering other fields', async () => {
    const userId = randomUUID();
    await repo.put({
      userId,
      totpEnabled: false,
      pendingTotpSecret: 'PENDINGSECRET234',
      updatedAt: '2026-06-12T00:00:00.000Z',
    });

    await repo.update(userId, {
      totpEnabled: true,
      totpSecret: 'CONFIRMEDSECRET5',
      enrolledAt: '2026-06-12T02:00:00.000Z',
    });

    const got = await repo.get(userId);
    expect(got?.totpEnabled).toBe(true);
    expect(got?.totpSecret).toBe('CONFIRMEDSECRET5');
    expect(got?.enrolledAt).toBe('2026-06-12T02:00:00.000Z');
    // Untouched attribute survives the partial update.
    expect(got?.pendingTotpSecret).toBe('PENDINGSECRET234');
    // updatedAt was advanced past the original.
    expect(got?.updatedAt).not.toBe('2026-06-12T00:00:00.000Z');
  });

  it('deletes the row', async () => {
    const userId = randomUUID();
    await repo.put({ userId, totpEnabled: true, updatedAt: '2026-06-12T00:00:00.000Z' });
    await repo.delete(userId);
    expect(await repo.get(userId)).toBeNull();
  });

  it('confirmTotpEnrollment promotes the pending secret when still disabled and the pending secret is unchanged', async () => {
    const userId = randomUUID();
    await repo.put({
      userId,
      totpEnabled: false,
      pendingTotpSecret: 'PENDINGSECRET234',
      updatedAt: '2026-06-12T00:00:00.000Z',
    });

    const confirmed = await repo.confirmTotpEnrollment(userId, {
      totpSecret: 'PENDINGSECRET234',
      enrolledAt: '2026-06-12T02:00:00.000Z',
      lastVerifiedAt: '2026-06-12T02:00:00.000Z',
      expectedPendingSecret: 'PENDINGSECRET234',
      restricted: null,
    });
    expect(confirmed).toBe(true);

    const got = await repo.get(userId);
    expect(got?.totpEnabled).toBe(true);
    expect(got?.totpSecret).toBe('PENDINGSECRET234');
    expect(got?.pendingTotpSecret).toBeUndefined();
  });

  it('confirmTotpEnrollment reports a lost race and leaves the row untouched when TOTP was enabled in the meantime', async () => {
    const userId = randomUUID();
    await repo.put({
      userId,
      totpEnabled: false,
      pendingTotpSecret: 'PENDINGSECRET234',
      updatedAt: '2026-06-12T00:00:00.000Z',
    });
    // Simulates a concurrent confirm winning first: TOTP is now enabled with
    // a DIFFERENT live secret, and the pending secret has already been
    // cleared.
    await repo.update(userId, {
      totpEnabled: true,
      totpSecret: 'WINNERSECRET5678',
    });

    const confirmed = await repo.confirmTotpEnrollment(userId, {
      totpSecret: 'PENDINGSECRET234',
      enrolledAt: '2026-06-12T02:00:00.000Z',
      lastVerifiedAt: '2026-06-12T02:00:00.000Z',
      expectedPendingSecret: 'PENDINGSECRET234',
      restricted: null,
    });
    expect(confirmed).toBe(false);

    // The winner's live secret survives — the loser's stale write never
    // landed.
    const got = await repo.get(userId);
    expect(got?.totpEnabled).toBe(true);
    expect(got?.totpSecret).toBe('WINNERSECRET5678');
  });
});

describe('UserMfaRepository — per-account TOTP failure state', () => {
  let env: RepoTestEnv;
  let repo: UserMfaRepository;
  const DECAY_SEC = 24 * 60 * 60;

  beforeAll(async () => {
    env = await createRepoTestEnv();
    repo = new UserMfaRepository(env.doc, env.config);
  });

  afterAll(async () => {
    env.destroy();
  });

  it('reserves the first attempt on a row with no failure state as miss #1', async () => {
    const userId = randomUUID();
    const reserved = await repo.reserveTotpAttempt(userId, {}, DECAY_SEC);
    expect(reserved?.totpFailureCount).toBe(1);
    expect(reserved?.totpLastFailureAt).toBeTruthy();
    const row = await repo.get(userId);
    expect(row?.totpFailureCount).toBe(1);
    expect(row?.totpLastFailureAt).toBe(reserved?.totpLastFailureAt);
  });

  it('continues the count when the observed state is still current', async () => {
    const userId = randomUUID();
    const first = await repo.reserveTotpAttempt(userId, {}, DECAY_SEC);
    const second = await repo.reserveTotpAttempt(userId, first!, DECAY_SEC);
    expect(second?.totpFailureCount).toBe(2);
  });

  it('loses the swap — null, nothing written — when the observed state has already moved on', async () => {
    // The property: an attempt whose observation is stale (it read the
    // row before a concurrent attempt's reservation landed) must not count
    // itself, or a refused attempt would restart the window it was refused
    // under and the lock would never reopen.
    const userId = randomUUID();
    const first = await repo.reserveTotpAttempt(userId, {}, DECAY_SEC);
    expect(await repo.reserveTotpAttempt(userId, {}, DECAY_SEC)).toBeNull();
    const row = await repo.get(userId);
    expect(row?.totpFailureCount).toBe(1);
    expect(row?.totpLastFailureAt).toBe(first?.totpLastFailureAt);
    // A stale count under a matching timestamp loses too (two stamps can land
    // in the same millisecond; the count is what still tells them apart).
    expect(
      await repo.reserveTotpAttempt(
        userId,
        { totpFailureCount: 0, totpLastFailureAt: first!.totpLastFailureAt },
        DECAY_SEC,
      ),
    ).toBeNull();
    expect((await repo.get(userId))?.totpFailureCount).toBe(1);
  });

  it('admits exactly one of N concurrent reservations against the same observed state', async () => {
    // Against the real conditional write, not a stub: N requests that all read
    // the same pre-burst row race the swap. A winner is an attempt that gets to
    // compare a code, so there must be exactly one per observed state.
    const userId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => repo.reserveTotpAttempt(userId, {}, DECAY_SEC)),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect((await repo.get(userId))?.totpFailureCount).toBe(1);
  });

  it('a reservation against a long-stale observed state resets rather than continues the count', async () => {
    // A controlled-clock probe (real time would take 24h to reproduce): seed
    // the row with a high count whose last failure is already past the decay
    // window, then prove the NEXT attempt starts over at 1 rather than 6.
    const userId = randomUUID();
    const staleTimestamp = new Date(Date.now() - (DECAY_SEC + 3600) * 1000).toISOString();
    await repo.put({
      userId,
      totpEnabled: true,
      totpSecret: 'JBSWY3DPEHPK3PXP',
      totpFailureCount: 5,
      totpLastFailureAt: staleTimestamp,
      updatedAt: staleTimestamp,
    });

    const result = await repo.reserveTotpAttempt(
      userId,
      { totpFailureCount: 5, totpLastFailureAt: staleTimestamp },
      DECAY_SEC,
    );
    expect(result?.totpFailureCount).toBe(1);
    expect(result?.totpLastFailureAt).not.toBe(staleTimestamp);
  });

  it('clearTotpFailure removes the counter and timestamp (the next reservation observes none and starts fresh)', async () => {
    const userId = randomUUID();
    const first = await repo.reserveTotpAttempt(userId, {}, DECAY_SEC);
    await repo.reserveTotpAttempt(userId, first!, DECAY_SEC);
    await repo.clearTotpFailure(userId);

    const cleared = await repo.get(userId);
    expect(cleared?.totpFailureCount).toBeUndefined();
    expect(cleared?.totpLastFailureAt).toBeUndefined();

    const afterClear = await repo.reserveTotpAttempt(userId, {}, DECAY_SEC);
    expect(afterClear?.totpFailureCount).toBe(1);
  });

  it('clearTotpFailure on a row with no failure state is a harmless no-op', async () => {
    const userId = randomUUID();
    await repo.put({ userId, totpEnabled: true, updatedAt: '2026-06-12T00:00:00.000Z' });
    await expect(repo.clearTotpFailure(userId)).resolves.toBeUndefined();
    expect((await repo.get(userId))?.totpFailureCount).toBeUndefined();
  });
});
