/**
 * CORS preflight handler for `OPTIONS /api/v1/*`.
 *
 * Live testing showed the API Gateway HTTP API `corsConfiguration` is
 * not consuming preflights for the deployed distribution, so the origin
 * answers them itself. An `Origin` that exactly
 * matches an entry in the configured allowlist (`WEB_ALLOWED_ORIGINS`,
 * default `WEB_ORIGIN`) gets a `204` with the credentialed-CORS headers
 * the SPA needs; a missing or disallowed `Origin` gets a bare `204` with
 * no permissive CORS headers (the actual request would still be blocked
 * by `OriginCheckMiddleware`). Only the exact request origin is reflected —
 * never a wildcard or an arbitrary reflected `Origin`. The `Vary`
 * header is always set so caches don't reuse one origin's preflight for
 * another.
 *
 * Used by both the Lambda handler (lambda.ts) and local dev (main.ts) so
 * preflight behavior stays identical across runtimes.
 */
import type { Request, Response, NextFunction } from 'express';

const ALLOWED_METHODS = 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS';
const ALLOWED_HEADERS = 'Content-Type,Authorization,X-CSRF-Token,X-Correlation-ID';
const MAX_AGE_SECONDS = '600';

/**
 * Response headers `main.ts`'s `app.enableCors(...)` exposes on the ACTUAL
 * (non-preflight) response — the single source of truth so this preflight
 * handler and that call never drift apart. `Retry-After` is not CORS-safelisted, so without it here a cross-origin
 * (local `pnpm dev`) browser reads `res.headers.get('Retry-After')` back as
 * `null` — deployed stacks are same-origin behind CloudFront and are
 * unaffected either way.
 */
export const CORS_EXPOSED_HEADERS = ['X-Correlation-ID', 'X-Build-Id', 'Retry-After'] as const;

/**
 * Build the preflight middleware bound to `allowedOrigins` (the canonical,
 * normalized allowed-origin set — trailing slashes already stripped by the
 * env parser). Returns Express middleware that answers preflights and passes
 * everything else through. A request `Origin` is reflected only when it
 * exactly matches a configured origin — no wildcard, no arbitrary reflection.
 */
export function createCorsPreflightHandler(
  allowedOrigins: readonly string[],
): (req: Request, res: Response, next: NextFunction) => void {
  // Strip a stray trailing slash defensively even though the env parser
  // already normalizes; cheap and keeps the helper correct if called directly.
  const normalizedAllowed = new Set(
    allowedOrigins.map((origin) => origin.replace(/\/$/, '')),
  );
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'OPTIONS') return next();

    // Always vary on the request characteristics that change the answer
    // so a shared cache can't serve one origin's preflight to another.
    res.setHeader(
      'Vary',
      'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    );

    const origin = (req.headers.origin as string | undefined) ?? '';
    if (normalizedAllowed.has(origin)) {
      // Reflect only the exact matched origin, never the whole list.
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', MAX_AGE_SECONDS);
    }
    // Missing / disallowed Origin → bare 204, no permissive headers.
    res.status(204).end();
  };
}
