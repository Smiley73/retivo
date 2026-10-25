// POST /auth/verify-password, the side-effect-free re-auth primitive used by the Profile-page data import and export flows.
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import {
  bootstrapTestApp,
  scanAll,
  signupVerifyLogin,
  STRONG_PASSWORD,
  type Session,
  type TestApp,
} from './test-helpers.js';
import type { AuthEventRow, FailedLoginAttemptRow } from '../dynamo/types.js';
import { EXPORT_AUTHORIZATION_COOKIE_NAME } from '../auth/cookie-config.js';

const WRONG_PASSWORD = 'WrongPassw0rd!Wrong';

function exportCookieLine(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  if (!raw) return undefined;
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.find((line) => line.startsWith(`${EXPORT_AUTHORIZATION_COOKIE_NAME}=`));
}

function verifyPassword(
  t: TestApp,
  s: Session,
  password: string,
  purpose?: 'data_export' | 'change_password' | 'password_slot_rewrap',
): request.Test {
  return request(t.app.getHttpServer())
    .post('/api/v1/auth/verify-password')
    .set('Origin', process.env.WEB_ORIGIN!)
    .set('Authorization', `Bearer ${s.accessToken}`)
    .set('X-CSRF-Token', s.csrfValue)
    .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
    .send(purpose ? { currentPassword: password, purpose } : { currentPassword: password });
}

function tableName(t: TestApp, key: string): string {
  return t.module
    .get(ConfigService)
    .get(key, { infer: true } as never) as unknown as string;
}

describe('verify-password', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('returns 204 on a correct password and records a password_verify audit event', async () => {
    const s = await signupVerifyLogin(t);
    const eventsBefore = (await scanAll<AuthEventRow>(
      t.doc,
      tableName(t, 'TABLE_AUTH_EVENT'),
    )).filter((r) => r.userId === s.userId && r.eventType === 'password_verify');

    const res = await verifyPassword(t, s, STRONG_PASSWORD);
    expect(res.status).toBe(204);

    const eventsAfter = (await scanAll<AuthEventRow>(
      t.doc,
      tableName(t, 'TABLE_AUTH_EVENT'),
    )).filter((r) => r.userId === s.userId && r.eventType === 'password_verify');
    expect(eventsAfter.length).toBe(eventsBefore.length + 1);

    const probe = await request(t.app.getHttpServer())
      .post('/api/v1/auth/verify-password')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${s.accessToken}`)
      .set('X-CSRF-Token', s.csrfValue)
      .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
      .send({ currentPassword: STRONG_PASSWORD });
    expect(probe.status).toBe(204);
  });

  it('returns 401 INVALID_CREDENTIALS on a wrong password and records password_verify_failed', async () => {
    const s = await signupVerifyLogin(t);
    const res = await verifyPassword(t, s, WRONG_PASSWORD);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

    const failed = (await scanAll<AuthEventRow>(
      t.doc,
      tableName(t, 'TABLE_AUTH_EVENT'),
    )).filter((r) => r.userId === s.userId && r.eventType === 'password_verify_failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
  });

  it('a wrong password increments the shared per-account backoff counter; a correct password clears it', async () => {
    const s = await signupVerifyLogin(t);
    const emailLowercase = s.email.toLowerCase();
    const failedTable = tableName(t, 'TABLE_FAILED_LOGIN_ATTEMPT');
    const rowFor = async (): Promise<FailedLoginAttemptRow | undefined> =>
      (await scanAll<FailedLoginAttemptRow>(t.doc, failedTable)).find(
        (r) => r.emailLowercase === emailLowercase,
      );

    // Backoff lives in VerifyPasswordService.verify(), so this endpoint shares the login path's counter.
    expect(await rowFor()).toBeUndefined();

    const wrong = await verifyPassword(t, s, WRONG_PASSWORD);
    expect(wrong.status).toBe(401);
    // Exactly 1: a wrong attempt is counted once, not double-incremented by the shared login path and this endpoint; `>= 1` would pass a double count.
    expect((await rowFor())?.consecutiveFailures).toBe(1);

    const ok = await verifyPassword(t, s, STRONG_PASSWORD);
    expect(ok.status).toBe(204);
    expect(await rowFor()).toBeUndefined();
  });

  it('records a data_export audit event when purpose is data_export and the password is correct', async () => {
    const s = await signupVerifyLogin(t);

    const res = await verifyPassword(t, s, STRONG_PASSWORD, 'data_export');
    expect(res.status).toBe(204);

    const events = await scanAll<AuthEventRow>(t.doc, tableName(t, 'TABLE_AUTH_EVENT'));
    const exportEvents = events.filter(
      (r) => r.userId === s.userId && r.eventType === 'data_export',
    );
    expect(exportEvents.length).toBe(1);
    const generic = events.filter(
      (r) => r.userId === s.userId && r.eventType === 'password_verify',
    );
    expect(generic.length).toBe(0);
  });

  it('records a data_export_failed audit event when purpose is data_export and the password is wrong', async () => {
    const s = await signupVerifyLogin(t);

    const res = await verifyPassword(t, s, WRONG_PASSWORD, 'data_export');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

    const events = await scanAll<AuthEventRow>(t.doc, tableName(t, 'TABLE_AUTH_EVENT'));
    const failed = events.filter(
      (r) => r.userId === s.userId && r.eventType === 'data_export_failed',
    );
    expect(failed.length).toBe(1);
    const generic = events.filter(
      (r) => r.userId === s.userId && r.eventType === 'password_verify_failed',
    );
    expect(generic.length).toBe(0);
  });

  it('rejects 400 on an invalid purpose value and writes no audit event', async () => {
    const s = await signupVerifyLogin(t);
    const eventsBefore = (await scanAll<AuthEventRow>(
      t.doc,
      tableName(t, 'TABLE_AUTH_EVENT'),
    )).filter((r) => r.userId === s.userId);

    const res = await request(t.app.getHttpServer())
      .post('/api/v1/auth/verify-password')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${s.accessToken}`)
      .set('X-CSRF-Token', s.csrfValue)
      .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
      .send({ currentPassword: STRONG_PASSWORD, purpose: 'not_allowed' });
    expect(res.status).toBe(400);

    // Validation rejects the request before the service runs, so no data_export/_failed or generic password_verify/_failed event fires.
    const eventsAfter = (await scanAll<AuthEventRow>(
      t.doc,
      tableName(t, 'TABLE_AUTH_EVENT'),
    )).filter((r) => r.userId === s.userId);
    expect(eventsAfter.length).toBe(eventsBefore.length);
  });

  it('records the generic password_verify event when no purpose is supplied (regression guard)', async () => {
    const s = await signupVerifyLogin(t);

    const res = await verifyPassword(t, s, STRONG_PASSWORD);
    expect(res.status).toBe(204);

    const events = await scanAll<AuthEventRow>(t.doc, tableName(t, 'TABLE_AUTH_EVENT'));
    const generic = events.filter(
      (r) => r.userId === s.userId && r.eventType === 'password_verify',
    );
    expect(generic.length).toBe(1);
    const exportEvents = events.filter(
      (r) => r.userId === s.userId && r.eventType === 'data_export',
    );
    expect(exportEvents.length).toBe(0);
  });

  it('mints the session-bound export-authorization cookie on a successful data_export verify', async () => {
    const s = await signupVerifyLogin(t);

    const res = await verifyPassword(t, s, STRONG_PASSWORD, 'data_export');
    expect(res.status).toBe(204);

    const cookie = exportCookieLine(res);
    expect(cookie).toBeDefined();
    // Session-bound, short-lived, HttpOnly, SameSite=Strict and scoped to /api/v1 so it also reaches GET /sync/pull and /sync/bootstrap where the guard reads it.
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1(?:;|$)/i);
    expect(cookie).toMatch(/Max-Age=300(?:;|$)/i);
  });

  it('does NOT mint the export-authorization cookie on a failed data_export verify', async () => {
    const s = await signupVerifyLogin(t);

    const res = await verifyPassword(t, s, WRONG_PASSWORD, 'data_export');
    expect(res.status).toBe(401);
    expect(exportCookieLine(res)).toBeUndefined();
  });

  it('does NOT mint the export-authorization cookie when no purpose is supplied', async () => {
    const s = await signupVerifyLogin(t);

    const res = await verifyPassword(t, s, STRONG_PASSWORD);
    expect(res.status).toBe(204);
    expect(exportCookieLine(res)).toBeUndefined();
  });

  it('does NOT mint the export-authorization cookie for a non-data_export purpose', async () => {
    const s = await signupVerifyLogin(t);

    const res = await request(t.app.getHttpServer())
      .post('/api/v1/auth/verify-password')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${s.accessToken}`)
      .set('X-CSRF-Token', s.csrfValue)
      .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
      .send({ currentPassword: STRONG_PASSWORD, purpose: 'not_allowed' });
    // The DTO allows only `data_export`; any other purpose is a 400 before the mint path.
    expect(res.status).toBe(400);
    expect(exportCookieLine(res)).toBeUndefined();
  });

  it('accepts the password_slot_rewrap purpose, records the generic password_verify event, and mints no export cookie', async () => {
    const s = await signupVerifyLogin(t);

    const res = await verifyPassword(t, s, STRONG_PASSWORD, 'password_slot_rewrap');
    expect(res.status).toBe(204);
    expect(exportCookieLine(res)).toBeUndefined();

    const events = await scanAll<AuthEventRow>(t.doc, tableName(t, 'TABLE_AUTH_EVENT'));
    // The purpose is an exemption entry only: it writes the same generic audit pair as any bare verification, never a bespoke `password_slot_rewrap` event type.
    const generic = events.filter(
      (r) => r.userId === s.userId && r.eventType === 'password_verify',
    );
    expect(generic.length).toBe(1);
  });

  it('records the generic password_verify_failed event on a wrong password with the password_slot_rewrap purpose', async () => {
    const s = await signupVerifyLogin(t);

    const res = await verifyPassword(t, s, WRONG_PASSWORD, 'password_slot_rewrap');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

    const events = await scanAll<AuthEventRow>(t.doc, tableName(t, 'TABLE_AUTH_EVENT'));
    const failed = events.filter(
      (r) => r.userId === s.userId && r.eventType === 'password_verify_failed',
    );
    expect(failed.length).toBe(1);
  });
});
