/**
 * Pure timestamp formatter for the per-address guessing notice —
 * free of SES/Nest wiring so it is
 * unit-testable without a stub client.
 *
 * The mail body itself is composed INLINE in
 * `login-guessing-notice.service.ts`, not here: the repo's HTML mail-body
 * escaping regression guard (`common/mail-html-escaping.spec.ts`) can
 * only see an interpolation when the HTML value is a template literal (or
 * `+`-chain) written where the mail-send call is built — a value composed by
 * a separate builder and assigned in is invisible to it. So only the
 * escaping-irrelevant, purely derived piece (the timestamp string) lives
 * here.
 *
 * Copy is a DRAFT pending owner approval.
 */

/** `2 September 2026 at 14:05 UTC` — the exact form the draft copy uses. */
export function formatUtcTimestamp(d: Date): string {
  const day = d.getUTCDate();
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${d.getUTCFullYear()} at ${hh}:${mm} UTC`;
}
