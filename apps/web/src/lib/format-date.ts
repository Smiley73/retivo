// Absolute-date display, default `MMMM d, yyyy`. `YYYY-MM-DD` strings parse as UTC parts to dodge the
// `new Date('2026-05-20')` previous-day shift west of GMT; full ISO timestamps format in local time. Read-only display.

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

/** `MMMM d, yyyy` for an ISO date or datetime; empty, falsy or unparseable input returns `''` for the caller to render. */
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
