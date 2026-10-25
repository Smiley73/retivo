// Pure timestamp formatter for the guessing notice. The mail body is composed inline in `login-guessing-notice.service.ts` so the HTML
// escaping guard (`common/mail-html-escaping.spec.ts`) can see the interpolation; copy is a draft pending owner approval.

/** `2 September 2026 at 14:05 UTC` — the exact form the draft copy uses. */
export function formatUtcTimestamp(d: Date): string {
  const day = d.getUTCDate();
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${d.getUTCFullYear()} at ${hh}:${mm} UTC`;
}
