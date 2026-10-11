/**
 * Password policy enforcement.
 *
 * Rules (in order):
 *   1. Minimum length 16 → PASSWORD_TOO_SHORT
 *   2. Complexity: at least one upper, one lower, one digit, one special
 *      character (POSIX [:punct:] set) → PASSWORD_WEAK
 *   3. Not in the embedded common-passwords set → PASSWORD_TOO_COMMON
 *   4. Not in the HIBP breach corpus → PASSWORD_PWNED
 *
 * The HIBP step always runs (no opt-out flag). It fails open: an HIBP outage
 * (timeout / network error / non-200) never rejects the password, so the
 * local common-passwords check above stays the primary defense.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { COMMON_PASSWORDS } from './data/common-passwords.js';
import { HibpClient } from './hibp-client.js';

const MIN_LENGTH = 16;
// Requires at least one lower, one upper, one digit, and one special character
// from the exact 32-character POSIX [:punct:] ASCII set — expressed as a
// hex-range character class (!"#$%&'()*+,-./ :;<=>?@ [\]^_` {|}~), no
// whitespace and no non-ASCII.
const COMPLEXITY_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E])/;

@Injectable()
export class PasswordValidatorService {
  constructor(private readonly hibp: HibpClient) {}

  async validate(password: string): Promise<void> {
    if (password.length < MIN_LENGTH) {
      throw new BadRequestException({
        code: 'PASSWORD_TOO_SHORT',
        message: `Password must be at least ${MIN_LENGTH} characters.`,
      });
    }

    if (!COMPLEXITY_REGEX.test(password)) {
      throw new BadRequestException({
        code: 'PASSWORD_WEAK',
        message:
          'Password must contain at least one uppercase letter, one lowercase letter, one digit, and one special character.',
      });
    }

    if (COMMON_PASSWORDS.has(password.toLowerCase())) {
      throw new BadRequestException({
        code: 'PASSWORD_TOO_COMMON',
        message: 'Password is too common. Choose a more unique password.',
      });
    }

    // Always-on HIBP breach check. `isPwned` fails open (returns false) on
    // timeout / network error / non-200, so an HIBP outage never rejects a
    // valid password — the local common-passwords check above is the primary
    // defense.
    const pwned = await this.hibp.isPwned(password);
    if (pwned) {
      throw new BadRequestException({
        code: 'PASSWORD_PWNED',
        message:
          'This password has appeared in a known data breach. Choose a different password.',
      });
    }
  }
}
