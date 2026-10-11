/**
 * Correlation-only obfuscation of an email address for log entries.
 *
 * Returns the first 16 hex chars of `sha256(email.trim().toLowerCase())`.
 * That's 64 bits of entropy — enough to correlate two failure logs that
 * involve the same address without writing the raw address to
 * CloudWatch. NOT a cryptographic anonymization: a maintainer with log
 * read access AND a candidate-email dictionary can still rainbow-table
 * the digest back to the original. The threat model accepts that
 * residual exposure (the maintainer is already trusted within their
 * IAM scope); the goal is to defeat grep-based PII scans and log-
 * forwarding-to-third-parties exposure of raw mail addresses.
 *
 * Locking trim + lowercase here so callers cannot accidentally drift
 * (e.g. one service hashes `user.email`, another hashes the lowercase
 * form — both would emit the same fingerprint with this helper).
 */
import { createHash } from 'crypto';

export function emailFingerprint(email: string): string {
  return createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex')
    .slice(0, 16);
}
