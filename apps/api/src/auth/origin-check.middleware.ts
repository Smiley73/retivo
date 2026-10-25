// Origin/Referer check on every state-changing request, as defense in depth beside CSRF. See docs/security.md, "Request-forgery protection".
import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response, NextFunction } from 'express';
import type { EnvConfig } from '../common/env.config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class OriginCheckMiddleware implements NestMiddleware {
  private readonly allowedOrigins: readonly string[];

  constructor(config: ConfigService<EnvConfig, true>) {
    // The env parser already normalizes the allowlist; use it as the single source so this cannot drift from CORS and
    // preflight.
    this.allowedOrigins = config.get('WEB_ALLOWED_ORIGINS_PARSED', {
      infer: true,
    });
  }

  use(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = (req.headers.origin as string | undefined) ?? '';
    const referer = (req.headers.referer as string | undefined) ?? '';

    // Origin is the trustworthy signal (the browser sets it). When present it must match exactly and does not fall
    // through to Referer, or a hostile Origin would pass on an allowed Referer. Referer is only the fallback when
    // Origin is absent, matched as the bare origin or anything under it.
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
