/**
 * Unit tests for `formatUtcTimestamp`. The mail
 * body itself is composed inline in `login-guessing-notice.service.ts` (so
 * the HTML mail-body escaping regression guard can see it) and is covered by
 * `login-guessing-notice.service.spec.ts`.
 */
import { formatUtcTimestamp } from './login-guessing-notice-mail.js';

describe('formatUtcTimestamp', () => {
  it('matches the draft copy shape ("2 September 2026 at 14:05 UTC")', () => {
    expect(formatUtcTimestamp(new Date('2026-09-02T14:05:00.000Z'))).toBe(
      '2 September 2026 at 14:05 UTC',
    );
  });

  it('zero-pads single-digit hours and minutes', () => {
    expect(formatUtcTimestamp(new Date('2026-01-01T03:07:00.000Z'))).toBe(
      '1 January 2026 at 03:07 UTC',
    );
  });
});
