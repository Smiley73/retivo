// Password policy: min length 16, complexity (upper, lower, digit, POSIX punct), not in the common-passwords set, not in the HIBP corpus. The
// HIBP step fails open, so an outage never rejects a password.
import { BadRequestException, Injectable } from '@nestjs/common';
import { COMMON_PASSWORDS } from './data/common-passwords.js';
import { HibpClient } from './hibp-client.js';

const MIN_LENGTH = 16;
// Requires a lower, upper, digit and one of the exact 32 POSIX [:punct:] ASCII characters, written as hex ranges;
// no whitespace or non-ASCII.
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

    // Always-on HIBP check; `isPwned` fails open, so an outage never rejects a valid password.
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
