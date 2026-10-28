// Re-points `req.ip` at the visitor on the Lambda path. serverless-express assigns `ip` as an own data property holding the
// API Gateway `sourceIp` (a CloudFront edge), which shadows Express's `trust proxy`-aware getter, so every `req.ip` read and the
// throttler tracker would otherwise see the edge. EdgeAuthMiddleware guarantees the gateway's caller is CloudFront, whose appended
// X-Forwarded-For entry is the visitor; anything left of it is client-controlled.
import type { Request, Response, NextFunction } from 'express';

/**
 * The visitor address from the X-Forwarded-For value and the gateway `sourceIp`. Whether API Gateway appends `sourceIp` as a
 * further entry is unconfirmed, so one trailing match is dropped (never more: a client cannot place an entry right of the one
 * CloudFront appends) and the last remaining entry is the visitor.
 */
export function visitorAddress(forwardedFor: string | undefined, sourceIp: string): string {
  const entries = (forwardedFor ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.at(-1) === sourceIp) entries.pop();
  return entries.at(-1) ?? sourceIp;
}

/** Only a serverless-express request carries `ip` as an own property; on a socket it is a setter-less accessor and is left alone. */
export function visitorAddressMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (Object.hasOwn(req, 'ip') && req.ip) {
    const forwardedFor = req.headers['x-forwarded-for'];
    (req as { ip?: string }).ip = visitorAddress(
      typeof forwardedFor === 'string' ? forwardedFor : undefined,
      req.ip,
    );
  }
  next();
}
