/**
 * Bootstrap smoke test for the integration harness. Confirms the test
 * helpers can spin up the full Nest app against the local emulator,
 * hit /health, and tear down cleanly. Other integration suites depend
 * on this working.
 */
import request from 'supertest';
import { bootstrapTestApp, type TestApp, purgeAllTables } from './test-helpers.js';

describe('harness', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootstrapTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('responds 200 to GET /api/v1/health', async () => {
    const res = await request(t.app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
  });

  it('echoes X-Build-Id on every response so the web detector can compare', async () => {
    const res = await request(t.app.getHttpServer()).get('/api/v1/health');
    // Tests run without BUILD_ID set → middleware emits the "dev"
    // sentinel, which the SPA detector treats as "never mismatch".
    expect(res.headers['x-build-id']).toBe('dev');
  });

  it('purgeAllTables runs without error against the local emulator', async () => {
    await expect(purgeAllTables(t.ddb)).resolves.not.toThrow();
  });
});
