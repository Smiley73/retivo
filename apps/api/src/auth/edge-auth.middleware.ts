/**
 * Edge → origin shared-secret enforcement.
 *
 * Locks the API Gateway invoke URL so it answers only when the request
 * carries the `X-Origin-Verify` header CloudFront attaches as a custom
 * origin header. Direct hits to the public APIGW hostname (which
 * bypass CloudFront's WAF + geo-restriction) are rejected with
 * `EDGE_AUTH_REQUIRED`.
 *
 * Header name: `X-Origin-Verify` is AWS's recommended convention for
 * this pattern. CloudFront's custom-origin-header allowlist rejects
 * `X-Edge-*` (and most reserved prefixes) at deploy time.
 *
 * Rotation: the middleware accepts both `EDGE_SHARED_SECRET` (the new
 * one) and `EDGE_SHARED_SECRET_PREVIOUS` (the prior one) so warm
 * Lambdas don't briefly reject CF traffic during the gap between an
 * SSM rotation and the CloudFront origin-header update.
 *
 * Local dev / integration tests / emulator runs leave both env vars
 * unset (STACK is also unset there); the middleware short-circuits to a
 * no-op so nothing changes. On a deployed stack (STACK set),
 * env.config.ts's superRefine already refuses to boot when
 * EDGE_SHARED_SECRET is missing, blank, or the Pulumi placeholder,
 * so this constructor should never observe an empty accepted-secret set
 * there — but it re-checks and throws (a boot failure) if it somehow does,
 * rather than let the no-op branch below decide on its own that edge auth
 * is off. That keeps this last line of defense fail-closed even if a
 * future change loosens the env schema.
 *
 * Comparison uses `crypto.timingSafeEqual` so the check doesn't leak
 * information about a near-miss secret length.
 */
import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { EnvConfig } from '../common/env.config.js';

@Injectable()
export class EdgeAuthMiddleware implements NestMiddleware {
  private readonly accepted: ReadonlyArray<Buffer>;

  constructor(config: ConfigService<EnvConfig, true>) {
    const primary = config.get('EDGE_SHARED_SECRET', { infer: true });
    const previous = config.get('EDGE_SHARED_SECRET_PREVIOUS', { infer: true });
    const set: Buffer[] = [];
    if (primary) set.push(Buffer.from(primary));
    if (previous) set.push(Buffer.from(previous));
    this.accepted = set;

    // Belt-and-suspenders for the fail-closed rule (see the header comment): refuse to
    // start rather than let `use()` treat an empty accepted set as
    // "edge auth is off" on a deployed stack.
    if (set.length === 0 && config.get('STACK', { infer: true }) !== undefined) {
      throw new Error(
        'EdgeAuthMiddleware: EDGE_SHARED_SECRET is required on a deployed stack (STACK set) and no usable secret was configured.',
      );
    }
  }

  use(req: Request, res: Response, next: NextFunction): void {
    if (this.accepted.length === 0) return next();

    const presented = req.headers['x-origin-verify'];
    if (typeof presented === 'string' && presented.length > 0) {
      const presentedBuf = Buffer.from(presented);
      for (const candidate of this.accepted) {
        if (
          presentedBuf.length === candidate.length &&
          timingSafeEqual(presentedBuf, candidate)
        ) {
          return next();
        }
      }
    }

    res.status(403).json({
      error: {
        code: 'EDGE_AUTH_REQUIRED',
        message: 'Direct origin access denied.',
      },
    });
  }
}
