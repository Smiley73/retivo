// Settles `req.ip` on the Lambda path: the X-Viewer-Address header replaces the gateway's `sourceIp` only behind edge auth and a valid proof.
// The header names and proof derivation are a contract with the edge function that writes them.
import { Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';

const ADDRESS_HEADER = 'x-viewer-address';
const PROOF_HEADER = 'x-viewer-address-proof';
const PROOF_MESSAGE = 'viewer-address-v1';

const logger = new Logger('VisitorAddress');

/** Lowercase hex HMAC-SHA256 of the proof message, keyed with the edge shared secret as the exact string edge auth compares. */
export function viewerAddressProof(secret: string): string {
  return createHmac('sha256', secret).update(PROOF_MESSAGE).digest('hex');
}

/**
 * Called by edge auth on its accepting exits. `acceptedProofs` is empty when no secret is configured, which skips the proof check.
 * Only a serverless-express request carries `ip` as an own property; on a socket it is a setter-less accessor and is left alone.
 */
export function settleViewerAddress(req: Request, acceptedProofs: ReadonlyArray<Buffer>): void {
  if (!Object.hasOwn(req, 'ip')) return;

  if (acceptedProofs.length > 0) {
    const presented = req.headers[PROOF_HEADER];
    const presentedBuf = typeof presented === 'string' ? Buffer.from(presented) : undefined;
    const valid = acceptedProofs.some(
      (proof) => presentedBuf?.length === proof.length && timingSafeEqual(presentedBuf, proof),
    );
    if (!valid) return;
  }

  const address = req.headers[ADDRESS_HEADER];
  if (typeof address === 'string' && isIP(address) !== 0) {
    (req as { ip?: string }).ip = address;
  } else if (acceptedProofs.length > 0) {
    logger.warn('A valid viewer-address proof arrived without a usable X-Viewer-Address; using the gateway address.');
  }
}
