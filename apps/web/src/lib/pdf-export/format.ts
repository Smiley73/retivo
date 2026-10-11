/** Shared formatting helpers for the pdf-export module. */

/** Zero-pad a number to 2 digits (e.g. month/day in filenames). */
export const pad2 = (n: number): string => String(n).padStart(2, '0');
