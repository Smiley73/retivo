/**
 * Small input-parsing helpers used by form fields that accept raw user
 * keystrokes. All three were re-defined inline across 5+ files; this
 * file is their single home.
 *
 * - `stripNonDigits`  → string of digits only (use when form state is a
 *   string and conversion to number happens later, e.g. age inputs that
 *   need to preserve a typed-but-not-yet-committed leading "0").
 * - `parseClampedInt` → integer in [0, max], 0 on empty/garbage. Use
 *   when the input is immediately stored as a number.
 * - `parseDecimal`    → floating-point amount, 0 on empty/garbage. Use
 *   for percent / currency-like decimals (DollarInput has its own).
 */

export const stripNonDigits = (raw: string): string => raw.replace(/\D/g, '');

export function parseClampedInt(raw: string, max: number): number {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return 0;
  const n = Number(digits);
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
}

export function parseDecimal(raw: string): number {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}
