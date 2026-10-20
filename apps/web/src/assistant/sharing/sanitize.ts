/**
 * Text that reaches an assistant is data, never instructions: every string the
 * share view emits goes through one of these. Control characters, zero-width and
 * bidirectional override code points are removed, whitespace is collapsed, the
 * result is capped (cut with an ellipsis) and literal occurrences of the terms a
 * tool must never say (a member's email and last name, the household name, and
 * first names while the person chose role labels) are masked. The output is
 * structured JSON; the "treat user text as data" sentence belongs to the
 * response envelope, not here.
 */

/** Names of members, accounts, expenses, categories, income streams, scenarios and institutions. */
const MAX_LABEL_CHARS = 60;
/** Notes and descriptions. */
const MAX_FREE_TEXT_CHARS = 500;

const ELLIPSIS = '…';
/** Replaces a masked term. It holds no letters or digits, so no term can match inside it and masking twice changes nothing. */
export const MASK = '[…]';

/** Whitespace-like controls become a space before the rest are stripped, so words never fuse. */
const LINE_BREAKS = /[\t\n\r\f\v\u0085\u2028\u2029]/g;
/**
 * C0 and C1 controls, soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width
 * and directional marks (U+200B to U+200F), bidi embeddings and overrides (U+202A to U+202E),
 * word joiner and invisible operators (U+2060 to U+2064), bidi isolates (U+2066 to U+2069),
 * the byte-order mark, and the interlinear annotation and specials block.
 */
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB]/g;

/** Compiled masker for a set of literal terms. */
export interface Masker {
  readonly terms: readonly string[];
  readonly pattern: RegExp | null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Scripts whose words are not separated by spaces, so a name there can only be found as a substring. */
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const WORD_CHARACTER = /^[\p{L}\p{N}]$/u;
/** A term shorter than this (in code points) is matched as a whole word, so `Ng` leaves `Savings` alone. */
const WHOLE_WORD_BELOW_CHARS = 4;

/**
 * The pattern source for one term. A short term in a spaced script (an initial, `Ng`, `Ann`) would
 * otherwise mask that letter sequence inside every unrelated word, so it only matches where letters
 * and digits do not touch it on either side. Longer terms, and terms with a character from a script
 * written without spaces (李), match as plain substrings: there a surrounding letter does not mean
 * a different word, and a name pasted against other text must still be masked.
 */
function termSource(term: string): string {
  const characters = Array.from(term);
  const escaped = escapeRegExp(term);
  if (characters.length >= WHOLE_WORD_BELOW_CHARS || UNSPACED_SCRIPT.test(term)) return escaped;
  const first = characters[0] ?? '';
  const last = characters[characters.length - 1] ?? '';
  const before = WORD_CHARACTER.test(first) ? '(?<![\\p{L}\\p{N}])' : '';
  const after = WORD_CHARACTER.test(last) ? '(?![\\p{L}\\p{N}])' : '';
  return `${before}${escaped}${after}`;
}

/**
 * Builds a masker. Terms are cleaned like the text they will be matched against, so a
 * name stored with odd spacing still matches; the longest term goes first so an email wins over a
 * name it contains. See `termSource` for which terms match only as whole words.
 */
export function buildMasker(rawTerms: readonly string[]): Masker {
  const cleaned = new Set<string>();
  for (const raw of rawTerms) {
    const term = cleanText(raw);
    if (term !== '') cleaned.add(term.toLowerCase());
  }
  const terms = [...cleaned].sort((a, b) => b.length - a.length);
  const pattern = terms.length === 0 ? null : new RegExp(terms.map(termSource).join('|'), 'giu');
  return { terms, pattern };
}

/** A masker that masks nothing. */
export const EMPTY_MASKER: Masker = buildMasker([]);

/** Removes invisible characters and collapses whitespace; the first half of every sanitizer. */
export function cleanText(text: string): string {
  return text.replace(LINE_BREAKS, ' ').replace(INVISIBLE, '').replace(/\s+/gu, ' ').trim();
}

function capText(text: string, maxChars: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxChars) return text;
  return `${characters.slice(0, maxChars - 1).join('').trimEnd()}${ELLIPSIS}`;
}

/** Cleans, masks, then caps `value` at `maxChars` code points, the ellipsis included. */
function sanitizeText(value: string, maxChars: number, masker: Masker): string {
  const cleaned = cleanText(value);
  const masked = masker.pattern === null ? cleaned : cleaned.replace(masker.pattern, MASK);
  return capText(masked, maxChars);
}

/** A name: governed by its category's switch, always sanitized, 60 characters. */
export function sanitizeLabel(value: string, masker: Masker): string {
  return sanitizeText(value, MAX_LABEL_CHARS, masker);
}

/** A note or description: governed by the notes switch, 500 characters. */
export function sanitizeFreeText(value: string, masker: Masker): string {
  return sanitizeText(value, MAX_FREE_TEXT_CHARS, masker);
}

/** The assistant's self-reported name, which the bridge learned from an untrusted client field. */
export function sanitizeClientName(value: string | null | undefined, masker: Masker = EMPTY_MASKER): string {
  return value === null || value === undefined ? '' : sanitizeLabel(value, masker);
}
