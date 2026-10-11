/**
 * Have-I-Been-Pwned k-anonymity client.
 *
 * Sends only the first 5 chars of the SHA-1 hash to api.pwnedpasswords.com,
 * receives every full-hash suffix that shares that prefix, and looks for the
 * remaining 35 chars locally. The plaintext password never leaves the server.
 *
 * Always invoked by PasswordValidatorService (no opt-out flag). A request
 * timeout (3s AbortController), network failure, or non-200 fails open
 * (returns false) — the local common-passwords check still runs as the
 * primary defense, so an HIBP outage never blocks a password change.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const REQUEST_TIMEOUT_MS = 3000;

@Injectable()
export class HibpClient {
  private readonly logger = new Logger(HibpClient.name);

  /** True if the password's SHA-1 appears in the HIBP breach corpus. */
  async isPwned(password: string): Promise<boolean> {
    const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(`${HIBP_RANGE_URL}${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'retivo-auth' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        this.logger.warn(`HIBP range API returned ${res.status}; failing open`);
        return false;
      }

      const body = await res.text();
      for (const line of body.split('\n')) {
        const [hashSuffix, count] = line.trim().split(':');
        // Padded entries return a count of 0 — ignore them so they don't false-positive.
        if (hashSuffix === suffix && Number(count) > 0) {
          return true;
        }
      }
      return false;
    } catch (err) {
      this.logger.warn(`HIBP check failed (${(err as Error).message}); failing open`);
      return false;
    }
  }
}
