// CORS preflight for `OPTIONS /api/v1/*`, answered by the origin because API Gateway corsConfiguration does not consume it. Only an
// exact allowlisted origin is reflected, never a wildcard; `Vary` is always set.
import type { Request, Response, NextFunction } from 'express';

const ALLOWED_METHODS = 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS';
const ALLOWED_HEADERS = 'Content-Type,Authorization,X-CSRF-Token,X-Correlation-ID';
const MAX_AGE_SECONDS = '600';

/**
 * Response headers `main.ts` exposes on the actual response, shared so the preflight handler and `enableCors` never
 * drift. `Retry-After` is not CORS-safelisted, so a cross-origin local dev browser would read it as null without it.
 */
export const CORS_EXPOSED_HEADERS = ['X-Correlation-ID', 'X-Build-Id', 'Retry-After'] as const;

/**
 * Builds the preflight middleware for the normalized `allowedOrigins`; it answers preflights and passes everything
 * else through.
 */
export function createCorsPreflightHandler(
  allowedOrigins: readonly string[],
): (req: Request, res: Response, next: NextFunction) => void {
  // Strip a stray trailing slash in case the helper is called directly.
  const normalizedAllowed = new Set(
    allowedOrigins.map((origin) => origin.replace(/\/$/, '')),
  );
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'OPTIONS') return next();

    // Vary on the request characteristics so a shared cache cannot serve one origin preflight to another.
    res.setHeader(
      'Vary',
      'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    );

    const origin = (req.headers.origin as string | undefined) ?? '';
    if (normalizedAllowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', MAX_AGE_SECONDS);
    }
    // A missing or disallowed Origin gets a bare 204 with no permissive headers.
    res.status(204).end();
  };
}
