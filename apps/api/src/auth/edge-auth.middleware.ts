// Edge-to-origin shared-secret check: API Gateway answers only with the `X-Origin-Verify` header CloudFront attaches (EDGE_AUTH_REQUIRED
// otherwise); both secrets are accepted during rotation and compared with timingSafeEqual. Accepting exits also settle `req.ip` from
// the viewer-address header; a rejected request never reaches that step.
import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { EnvConfig } from '../common/env.config.js';
import { settleViewerAddress, viewerAddressProof } from '../common/visitor-address.js';

@Injectable()
export class EdgeAuthMiddleware implements NestMiddleware {
  private readonly accepted: ReadonlyArray<{ secret: Buffer; proof: Buffer }>;

  constructor(config: ConfigService<EnvConfig, true>) {
    const primary = config.get('EDGE_SHARED_SECRET', { infer: true });
    const previous = config.get('EDGE_SHARED_SECRET_PREVIOUS', { infer: true });
    const secrets = [primary, previous].filter((secret): secret is string => !!secret);
    this.accepted = secrets.map((secret) => ({
      secret: Buffer.from(secret),
      proof: Buffer.from(viewerAddressProof(secret)),
    }));

    // Fail closed: on a deployed stack (STACK set) env.config already refuses to boot without a real secret; refuse
    // to start here too rather than let `use()` read an empty accepted set as "edge auth is off".
    if (secrets.length === 0 && config.get('STACK', { infer: true }) !== undefined) {
      throw new Error(
        'EdgeAuthMiddleware: EDGE_SHARED_SECRET is required on a deployed stack (STACK set) and no usable secret was configured.',
      );
    }
  }

  use(req: Request, res: Response, next: NextFunction): void {
    if (this.accepted.length === 0) {
      settleViewerAddress(req, []);
      return next();
    }

    const presented = req.headers['x-origin-verify'];
    if (typeof presented === 'string' && presented.length > 0) {
      const presentedBuf = Buffer.from(presented);
      for (const { secret, proof } of this.accepted) {
        if (presentedBuf.length === secret.length && timingSafeEqual(presentedBuf, secret)) {
          // Only the proof derived from the secret this request matched counts.
          settleViewerAddress(req, [proof]);
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
