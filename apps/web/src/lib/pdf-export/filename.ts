/**
 * Dated filename builder for the unified PDF export. The scenario
 * component is user-entered, so it goes through a STRICT allowlist sanitizer
 * before it ever lands in a download filename: only `[A-Za-z0-9-_]` survive,
 * everything else (control chars, RTL-override marks, path separators,
 * unicode) collapses to `-`, leading dots are stripped, and the result is
 * capped so a pathological name can't produce an unusable filename.
 *
 * Framework-free: pure string functions, no React / DOM / jsPDF import.
 */
import { pad2 } from './format';

const MAX_COMPONENT_LENGTH = 40;

/**
 * Sanitize a user-entered name to a strict filename-safe component:
 *   - keep only `[A-Za-z0-9-_]`; collapse every other character (including
 *     control chars, the RTL-override (U+202E), `/`, spaces, unicode) to `-`;
 *   - collapse runs of `-` to a single `-`;
 *   - strip leading dots (a leading `.` would make a hidden file) and any
 *     leading/trailing `-`;
 *   - cap at 40 characters.
 * Returns `'untitled'` when nothing usable remains.
 */
export function sanitizeFilenameComponent(name: string): string {
  // Strip leading dots first so `.hidden` does not become `-hidden`.
  const noLeadingDots = name.replace(/^\.+/, '');
  const collapsed = noLeadingDots
    .replace(/[^A-Za-z0-9\-_]+/g, '-') // non-allowlist → single dash
    .replace(/-+/g, '-') // runs of dash → one dash
    .replace(/^-+|-+$/g, ''); // trim leading/trailing dash
  const capped = collapsed.slice(0, MAX_COMPONENT_LENGTH).replace(/-+$/g, '');
  return capped.length > 0 ? capped : 'untitled';
}

export interface BuildPdfFilenameParams {
  readonly scenarioName: string;
  /** A fixed basis label key (already from a controlled set — sanitized
   *  defensively all the same). */
  readonly basisKey: string;
  /** Render-clock "now" as parts (month 1-12, day 1-31). */
  readonly date: { year: number; month: number; day: number };
}

/**
 * Build the PDF download filename:
 *   `retivo-<scenario>-<basis>-<YYYY-MM-DD>.pdf`
 * The scenario + basis components both pass through `sanitizeFilenameComponent`
 * (the basis is from a fixed set, sanitized defensively).
 */
export function buildPdfFilename(params: BuildPdfFilenameParams): string {
  const scenario = sanitizeFilenameComponent(params.scenarioName);
  const basis = sanitizeFilenameComponent(params.basisKey);
  const { year, month, day } = params.date;
  const datePart = `${year}-${pad2(month)}-${pad2(day)}`;
  return `retivo-${scenario}-${basis}-${datePart}.pdf`;
}
