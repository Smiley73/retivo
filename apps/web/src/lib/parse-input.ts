// Input-parsing helpers for form fields taking raw keystrokes: `stripNonDigits` keeps a typed leading "0" as a string,
// `parseClampedInt` gives an integer in [0, max] (0 on garbage), `parseDecimal` a float (0 on garbage; DollarInput has its own).

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
