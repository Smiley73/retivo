// Stamps every response with `X-Build-Id` (from BUILD_ID, `dev` locally) so the SPA can prompt a reload when a new version ships.
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
