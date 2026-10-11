/**
 * Test-infra guards for the per-process / per-worker isolation that lets
 * the API suite run with `maxWorkers > 1` and lets two concurrent jest
 * processes (e.g. two worktrees) run without cross-
 * contamination.
 *
 * 1. Probe: `JEST_RUN_ID` is set (jest.config.cjs ran before this
 *    worker forked) and every namespaced table/bucket name is well-
 *    formed `retirement-test-${JEST_RUN_ID}-${JEST_WORKER_ID}-…`. The
 *    fail-loud throws in jest.setup.ts / global-teardown.ts are what
 *    *guarantee* no silent leak; this probe is the positive assertion.
 * 2. Benign-gap confirmation: the real `approvePendingSignup`
 *    helper, driven with the caller's own raw approval token, approves
 *    only that token's row (caller User → `approved`, the coexisting
 *    second user's row stays `pending`) — proving the digest-keyed
 *    lookup resolves only the token
 *    owner and the 14→15 `TABLE_ENV_KEYS` fix is completeness, not a
 *    correctness patch.
 * 3. Fail-loud negative: the two separate exported guards —
 *    `global-teardown.ts`'s `assertRunId` and `jest.setup.ts`'s
 *    `assertJestRunId` — each throw when `JEST_RUN_ID` is unset (the
 *    positive probe alone can't prove the silent-leak guard fires).
 *    They are intentionally separate (jest.setup is a `setupFiles`
 *    entry; importing global-teardown's @aws-sdk graph into every
 *    worker breaks jest's CJS VM).
 */
import request from 'supertest';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ConfigService } from '@nestjs/config';
import {
  STRONG_PASSWORD,
  approvePendingSignup,
  bootstrapTestApp,
  freshEmail,
  scanAll,
  type TestApp,
} from './test-helpers.js';
import type { SignupApprovalRow, UserRow } from '../dynamo/types.js';

interface SignupResponse {
  userId: string;
  verificationToken?: string;
}

describe('test isolation', () => {
  describe('namespace probe', () => {
    it('JEST_RUN_ID is set by jest.config.cjs before the worker forks', () => {
      expect(process.env.JEST_RUN_ID).toBeTruthy();
      expect(process.env.JEST_RUN_ID).toMatch(/^\d+$/);
    });

    it('every namespaced resource name is well-formed for this run + worker', () => {
      const prefix = `retirement-test-${process.env.JEST_RUN_ID}-${process.env.JEST_WORKER_ID}-`;
      const names = [
        process.env.TABLE_USER,
        process.env.TABLE_SIGNUP_APPROVAL,
        process.env.TABLE_MUTATION_LOG,
        process.env.SNAPSHOTS_BUCKET,
      ];
      for (const name of names) {
        expect(name).toBeTruthy();
        expect(name!.startsWith(prefix)).toBe(true);
      }
    });
  });

  describe('approvePendingSignup selects by the caller userId', () => {
    let t: TestApp;

    beforeAll(async () => {
      t = await bootstrapTestApp();
    });

    afterAll(async () => {
      await t.app.close();
    });

    function configValue(key: string): string {
      return t.module
        .get(ConfigService)
        .get(key, { infer: true } as never) as unknown as string;
    }

    async function signupVerify(): Promise<{ userId: string; approvalToken: string }> {
      const signup = await request(t.app.getHttpServer())
        .post('/api/v1/auth/signup')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ email: freshEmail(), password: STRONG_PASSWORD });
      expect(signup.status).toBe(202);
      const body = signup.body as SignupResponse;
      const verify = await request(t.app.getHttpServer())
        .post('/api/v1/auth/verify-email')
        .set('Origin', process.env.WEB_ORIGIN!)
        .send({ token: body.verificationToken });
      expect(verify.status).toBe(200);
      // The approval token is stored hashed; the raw token is
      // returned only in the verify-email dev-trapdoor response.
      expect(typeof verify.body.approvalToken).toBe('string');
      return { userId: body.userId, approvalToken: verify.body.approvalToken as string };
    }

    async function approvalStatus(userId: string): Promise<string | undefined> {
      const row = await t.doc.send(
        new GetCommand({
          TableName: configValue('TABLE_USER'),
          Key: { userId },
        }),
      );
      return (row.Item as UserRow | undefined)?.approvalStatus;
    }

    it('approvePendingSignup approves only the token owner when another pending row coexists', async () => {
      // Two verified-but-pending signups land in the same (per-worker)
      // SignupApproval table — the leftover-row case parallelism creates.
      const other = await signupVerify();
      const mine = await signupVerify();

      const approvalTable = configValue('TABLE_SIGNUP_APPROVAL');
      const before = await scanAll<SignupApprovalRow>(t.doc, approvalTable);
      expect(before.some((r) => r.userId === mine.userId)).toBe(true);
      expect(before.some((r) => r.userId === other.userId)).toBe(true);
      expect(await approvalStatus(mine.userId)).toBe('pending');
      expect(await approvalStatus(other.userId)).toBe('pending');

      // Approve using *my* raw token while the other user's pending row
      // coexists — the digest-keyed lookup resolves only my row, proving
      // approving one token never touches another user's pending signup.
      await approvePendingSignup(t.app, mine.approvalToken);

      // Token owner is approved; the other user's row is untouched (still
      // pending, its SignupApproval row still present).
      expect(await approvalStatus(mine.userId)).toBe('approved');
      expect(await approvalStatus(other.userId)).toBe('pending');
      const after = await scanAll<SignupApprovalRow>(t.doc, approvalTable);
      expect(after.some((r) => r.userId === other.userId)).toBe(true);
    });
  });

  describe('fail-loud guards throw when JEST_RUN_ID is unset', () => {
    // `global-teardown.ts` (jest-main hook) and `jest.setup.ts`
    // (per-worker setup) each export their own guard — both must fail
    // loud rather than silently no-op (the silent-leak case that
    // must never happen). They are intentionally separate (jest.setup is a
    // setupFiles entry; importing global-teardown's @aws-sdk graph into
    // every worker breaks jest's CJS VM), so both are asserted here.
    //
    // Both modules are already loaded for this worker, so importing them returns the cached exports
    // — no module re-evaluation, no setup side effects re-run. The intra-namespace discipline is
    // load-bearing: mutating process.env here must not poison sibling suites sharing this worker —
    // JEST_RUN_ID is restored in a finally block.

    it('global-teardown assertRunId returns the id when set and throws when unset', async () => {
      const { assertRunId } = await import('./global-teardown.js');
      const original = process.env.JEST_RUN_ID;
      try {
        expect(assertRunId()).toBe(original);
        delete process.env.JEST_RUN_ID;
        expect(() => assertRunId()).toThrow(/JEST_RUN_ID is not set/);
      } finally {
        process.env.JEST_RUN_ID = original;
      }
    });

    it('jest.setup assertJestRunId returns the id when set and throws when unset', async () => {
      const { assertJestRunId } = await import('./jest.setup.js');
      const original = process.env.JEST_RUN_ID;
      try {
        expect(assertJestRunId()).toBe(original);
        delete process.env.JEST_RUN_ID;
        expect(() => assertJestRunId()).toThrow(/JEST_RUN_ID is not set/);
      } finally {
        process.env.JEST_RUN_ID = original;
      }
    });
  });
});
