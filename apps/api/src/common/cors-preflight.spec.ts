// CORS preflight: an allowed-origin OPTIONS /api/v1/* returns 204 with the credentialed-CORS headers, a missing or hostile origin returns a bare 204 with no permissive headers, and the multi-origin allowlist holds.
import express from 'express';
import request from 'supertest';
import { createCorsPreflightHandler, CORS_EXPOSED_HEADERS } from './cors-preflight.js';

const WEB_ORIGIN = 'http://localhost:5173';
const LAN_ORIGIN = 'http://192.168.1.42:5173';

function appWithPreflight(allowed: readonly string[] = [WEB_ORIGIN]) {
  const app = express();
  app.use('/api/v1', createCorsPreflightHandler(allowed));
  app.post('/api/v1/auth/login', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('createCorsPreflightHandler', () => {
  it('returns 204 with credentialed CORS headers for an allowed origin', async () => {
    const res = await request(appWithPreflight())
      .options('/api/v1/auth/login')
      .set('Origin', WEB_ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('X-CSRF-Token');
    expect(res.headers['access-control-max-age']).toBe('600');
    expect(res.headers['vary']).toContain('Origin');
  });

  it('returns a bare 204 with no permissive CORS headers for a hostile origin', async () => {
    const res = await request(appWithPreflight())
      .options('/api/v1/auth/login')
      .set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    // Vary is still set so caches don't reuse another origin's answer.
    expect(res.headers['vary']).toContain('Origin');
  });

  it('returns a bare 204 with no permissive CORS headers when Origin is missing', async () => {
    const res = await request(appWithPreflight()).options('/api/v1/auth/login');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('passes non-OPTIONS requests through to the downstream handler', async () => {
    const res = await request(appWithPreflight())
      .post('/api/v1/auth/login')
      .set('Origin', WEB_ORIGIN)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('tolerates a trailing slash on a configured origin', async () => {
    const res = await request(appWithPreflight([`${WEB_ORIGIN}/`]))
      .options('/api/v1/auth/login')
      .set('Origin', WEB_ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
  });

  describe('multiple allowed origins', () => {
    const app = () => appWithPreflight([WEB_ORIGIN, LAN_ORIGIN]);

    it('reflects the localhost origin when it matches the allowlist', async () => {
      const res = await request(app())
        .options('/api/v1/auth/login')
        .set('Origin', WEB_ORIGIN);
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('reflects the LAN origin when it matches the allowlist', async () => {
      const res = await request(app())
        .options('/api/v1/auth/login')
        .set('Origin', LAN_ORIGIN);
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(LAN_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('does not reflect an origin outside the allowlist', async () => {
      const res = await request(app())
        .options('/api/v1/auth/login')
        .set('Origin', 'http://192.168.1.99:5173');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });
  });
});

// `Retry-After` must be in the CORS exposed-headers list that main.ts's enableCors reads, or a cross-origin browser reads it back as null and the client retry policy silently observes nothing.
// main.ts is not unit-testable, so this asserts the constant both it and this handler share.
describe('CORS_EXPOSED_HEADERS', () => {
  it('includes Retry-After alongside the existing exposed headers', () => {
    expect(CORS_EXPOSED_HEADERS).toContain('Retry-After');
    expect(CORS_EXPOSED_HEADERS).toContain('X-Correlation-ID');
    expect(CORS_EXPOSED_HEADERS).toContain('X-Build-Id');
  });
});
