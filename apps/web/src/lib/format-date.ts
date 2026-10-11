/**
 * Single source for absolute-date display across the app.
 *
 * Default format: `MMMM d, yyyy` (e.g. `May 20, 2026`).
 *
 * Calendar-date strings (`YYYY-MM-DD`) are parsed as UTC year/month/day
 * to avoid the `new Date('2026-05-20')` midnight-UTC pitfall — that
 * coerces to the previous calendar day in any timezone west of GMT.
 *
 * Full ISO timestamps are formatted in the user's local timezone, since
 * those represent a moment in time (e.g. `lastUsedAt`) and the calendar
 * day the user perceives is the local one.
 *
 * Numeric input controls keep `MM/dd/yyyy` via `<input type="date">` —
 * this helper is for read-only display only.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Returns `MMMM d, yyyy` for the given ISO date or datetime string.
 * Empty / falsy / unparseable inputs return an empty string — callers
 * decide how to render the empty state.
 */
export function formatDate(input: string | null | undefined): string {
  if (!input) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [y, m, d] = input.split('-').map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return '';
    if (m < 1 || m > 12) return '';
    return `${MONTHS[m - 1]} ${d}, ${y}`;
  }
  const dt = new Date(input);
  if (Number.isNaN(dt.getTime())) return '';
  return `${MONTHS[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}
