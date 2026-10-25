/**
 * Dated filename builder for the PDF export. The user-entered scenario name goes through an allowlist sanitizer before it reaches a download filename.
 */
import { pad2 } from './format';

const MAX_COMPONENT_LENGTH = 40;

/**
 * Reduce a user-entered name to `[A-Za-z0-9-_]` (runs collapsed, no leading dots, max 40 chars);
 * `'untitled'` when nothing usable remains.
 */
function sanitizeFilenameComponent(name: string): string {
  // A leading dot would make a hidden file.
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
  readonly basisKey: string;
  readonly date: { year: number; month: number; day: number };
}

/** Build `retivo-<scenario>-<basis>-<YYYY-MM-DD>.pdf`; both name parts are sanitized. */
export function buildPdfFilename(params: BuildPdfFilenameParams): string {
  const scenario = sanitizeFilenameComponent(params.scenarioName);
  const basis = sanitizeFilenameComponent(params.basisKey);
  const { year, month, day } = params.date;
  const datePart = `${year}-${pad2(month)}-${pad2(day)}`;
  return `retivo-${scenario}-${basis}-${datePart}.pdf`;
}
