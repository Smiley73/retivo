// The real @Throttle(5/hr) on POST /sync/workspace/clear: the harness sets DISABLE_THROTTLE=true (jest.setup.ts), so this file clears the flag before building the app (the ThrottlerModule skipIf reads process.env per request) and proves the 6th call is throttled.
// Isolated in its own file because clearing the flag affects the whole worker process.
import request from 'supertest';
import {
  bootstrapTestApp,
  signupVerifyLogin,
  STRONG_PASSWORD,
  type Session,
  type TestApp,
} from './test-helpers.js';

describe('POST /sync/workspace/clear — rate limit', () => {
  let t: TestApp;
  let priorFlag: string | undefined;

  beforeAll(async () => {
    priorFlag = process.env.DISABLE_THROTTLE;
    delete process.env.DISABLE_THROTTLE;
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    try {
      await t.app.close();
    } finally {
      if (priorFlag !== undefined) process.env.DISABLE_THROTTLE = priorFlag;
    }
  });

  function clearWorkspace(s: Session): request.Test {
    return request(t.app.getHttpServer())
      .post('/api/v1/sync/workspace/clear')
      .set('Origin', process.env.WEB_ORIGIN!)
      .set('Authorization', `Bearer ${s.accessToken}`)
      .set('X-CSRF-Token', s.csrfValue)
      .set('Cookie', [s.refreshCookie, s.csrfCookie].join('; '))
      .send({ currentPassword: STRONG_PASSWORD, eraseHistory: false });
  }

  it('throttles the 6th clear in the window (5/hr)', async () => {
    const s = await signupVerifyLogin(t);
    for (let i = 0; i < 5; i += 1) {
      const r = await clearWorkspace(s);
      expect(r.status).toBe(201);
    }
    const sixth = await clearWorkspace(s);
    expect(sixth.status).toBe(429);
  });
});
