// Correlation-only obfuscation of an email for log entries (16 hex chars of its sha256). A candidate-email dictionary can reverse it, an accepted residual.
// Trim and lowercase are fixed here so callers cannot drift into different fingerprints for one address.
import { createHash } from 'crypto';

/** Log-safe fingerprint of an email: defeats grep-based PII scans, not a dictionary attack. */
export function emailFingerprint(email: string): string {
  return createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex')
    .slice(0, 16);
}
