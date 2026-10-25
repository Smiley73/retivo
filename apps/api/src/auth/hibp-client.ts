// Have-I-Been-Pwned k-anonymity client: only the first 5 chars of the SHA-1 leave the server. A timeout (3s), network failure or non-200 fails
// open, since the local common-passwords check is the primary defense.
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const REQUEST_TIMEOUT_MS = 3000;

@Injectable()
export class HibpClient {
  private readonly logger = new Logger(HibpClient.name);

  /** True if the password SHA-1 appears in the HIBP corpus. */
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
