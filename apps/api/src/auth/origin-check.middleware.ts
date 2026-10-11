/**
 * Origin / Referer check on every state-changing request. A present `Origin`
 * must exactly match an allowed web origin (any entry in
 * `WEB_ALLOWED_ORIGINS`, which defaults to `WEB_ORIGIN`); `Referer` is only
 * consulted as a fallback when `Origin` is absent. Rejects otherwise.
 * Defense-in-depth
 * alongside CSRF; closes the gap on browsers without strict CORS-credentials
 * support and on form-encoded cross-origin POSTs.
 *
 * See docs/security.md, "Request-forgery protection".
 */
import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import type { EnvConfig } from '../common/env.config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class OriginCheckMiddleware implements NestMiddleware {
  private readonly allowedOrigins: readonly string[];

  constructor(config: ConfigService<EnvConfig, true>) {
    // The env parser already normalizes the allowlist to canonical origins
    // (trailing slash stripped, path/query/hash rejected). Use it as the
    // single source so this middleware can't drift from CORS/preflight.
    this.allowedOrigins = config.get('WEB_ALLOWED_ORIGINS_PARSED', {
      infer: true,
    });
  }

  use(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = (req.headers.origin as string | undefined) ?? '';
    const referer = (req.headers.referer as string | undefined) ?? '';

    // Origin is the trustworthy signal (the browser sets it, the page can't
    // forge it). When present it must exactly match the allowlist — we do NOT
    // fall through to Referer, or a hostile `Origin: evil.com` would sneak in
    // on a stale/allowed `Referer`. Referer is only the fallback for the rare
    // request that omits Origin entirely (browsers send full Referer URLs with
    // paths, so match the bare origin or anything sitting under it).
    if (origin !== '') {
      if (this.allowedOrigins.includes(origin)) return next();
    } else {
      for (const allowed of this.allowedOrigins) {
        if (referer === allowed) return next();
        if (referer.startsWith(allowed + '/')) return next();
      }
    }

    res.status(403).json({
      error: {
        code: 'ORIGIN_MISMATCH',
        message: 'Request Origin/Referer does not match an allowed web origin.',
      },
    });
  }
}
