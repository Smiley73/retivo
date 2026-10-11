/**
 * Correlation ID middleware.
 *
 * Generates a unique `x-correlation-id` on every request and propagates it
 * to the response headers so that logs can be correlated across services.
 * If the client already sent one (e.g. from a gateway), we reuse it — but
 * only when it matches the canonical UUID v1-5 shape. An unsanitised value
 * would flow into Pino logs (log forging) and echo back on every response.
 */
import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const incoming = req.headers['x-correlation-id'] as string | undefined;
    const correlationId = incoming && UUID_RE.test(incoming) ? incoming : randomUUID();
    req.headers['x-correlation-id'] = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    next();
  }
}
