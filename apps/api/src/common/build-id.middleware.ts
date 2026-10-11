/**
 * Build-id middleware.
 *
 * Stamps every response with `X-Build-Id` so the SPA can compare it
 * against the build id baked into its own bundle and prompt a reload
 * when a new version has shipped (see apps/web/src/lib/build-id.ts +
 * apps/web/src/components/VersionBanner.tsx).
 *
 * Source of truth: `process.env.BUILD_ID`, set by Pulumi at deploy
 * time from the same source the SPA build uses (so an atomic deploy
 * publishes matching ids on both sides). Defaults to `dev` locally,
 * which the SPA detector treats as "never mismatch" — vite-dev and
 * jest tests don't pop the banner.
 */
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

export const BUILD_ID = process.env.BUILD_ID ?? 'dev';

@Injectable()
export class BuildIdMiddleware implements NestMiddleware {
  use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('X-Build-Id', BUILD_ID);
    next();
  }
}
