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
 * Controls (C0, C1), format characters (soft hyphen, zero-width and directional marks, bidi
 * embeddings, overrides and isolates, word joiner and invisible operators, the byte-order mark,
 * interlinear annotation, and the Tags block U+E0000 to U+E007F that hides text a person cannot see
 * but a model still reads), and every other default-ignorable code point (variation selectors,
 * Hangul fillers, the combining grapheme joiner, unassigned tag and ignorable code points). Named by
 * property rather than listed, so no invisible range is left out.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u{E0000}-\u{E007F}]/gu;

/** Compiled masker for a set of literal terms. */
export interface Masker {
  /** The cleaned terms as given, with their lower- and upper-cased spellings, longest first. */
  readonly terms: readonly string[];
  readonly pattern: RegExp | null;
  /** True when `token` is, as a whole, one of the terms. For leaves that cannot be masked in part (ids, enum values). */
  isTerm(token: string): boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Scripts whose words are not separated by spaces, so a name there can only be found as a substring. */
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const WORD_CHARACTER = /^[\p{L}\p{N}\p{M}]$/u;
/** A term shorter than this (in code points) is matched as a whole word, so `Ng` leaves `Savings` alone. */
const WHOLE_WORD_BELOW_CHARS = 4;

/**
 * How a term is found in text. This is the one place the policy lives:
 *  - `word`       a short term in a spaced script (an initial, `Ng`, `Ann`) matches only where letters
 *                 and digits do not touch it. Masked as a substring it would garble every unrelated
 *                 word that contains those letters.
 *  - `substring`  anything else. A longer name pasted against other text (`TheSmithFamily`,
 *                 `Smithfield`) must still be caught, and a character from a script written without
 *                 spaces (李) has no word to be part of. Over-masking here is the safe side of the
 *                 trade: it can shorten an unrelated word that contains a long name (`Checking` for
 *                 `King`), never leak one.
 */
function matchModeFor(term: string): 'word' | 'substring' {
  return Array.from(term).length >= WHOLE_WORD_BELOW_CHARS || UNSPACED_SCRIPT.test(term) ? 'substring' : 'word';
}

/** The pattern source for one term under `matchModeFor`. */
function termSource(term: string): string {
  const escaped = escapeRegExp(term);
  if (matchModeFor(term) === 'substring') return escaped;
  const characters = Array.from(term);
  const first = characters[0] ?? '';
  const last = characters[characters.length - 1] ?? '';
  const before = WORD_CHARACTER.test(first) ? '(?<![\\p{L}\\p{N}\\p{M}])' : '';
  const after = WORD_CHARACTER.test(last) ? '(?![\\p{L}\\p{N}\\p{M}])' : '';
  return `${before}${escaped}${after}`;
}

/**
 * Builds a masker. Terms are cleaned like the text they will be matched against, so a
 * name stored with odd spacing still matches; the longest term goes first so an email wins over a
 * name it contains. See `termSource` for which terms match only as whole words.
 *
 * The pattern holds each term as written, not only lower-cased: the `iu` flags fold case one
 * character at a time, and some letters have no such fold. `İ` lower-cases to `i` plus a combining
 * dot, so a lower-cased `İpek` would never match the name as stored. Its lower- and upper-cased
 * spellings ride along, so a note that wrote the name either way is caught too.
 */
export function buildMasker(rawTerms: readonly string[]): Masker {
  const cleaned = new Set<string>();
  for (const raw of rawTerms) {
    const term = cleanText(raw);
    if (term === '') continue;
    for (const spelling of [term, term.toLowerCase(), term.toUpperCase()]) cleaned.add(spelling.normalize('NFC'));
  }
  const terms = [...cleaned].sort((a, b) => b.length - a.length);
  const pattern = terms.length === 0 ? null : new RegExp(terms.map(termSource).join('|'), 'giu');
  const exact = new Set(terms.map((term) => term.toLowerCase()));
  return { terms, pattern, isTerm: (token) => exact.has(cleanText(token).toLowerCase()) };
}

/** A masker that masks nothing. */
const EMPTY_MASKER: Masker = buildMasker([]);

/**
 * Removes invisible characters, normalizes to NFC and collapses whitespace; the first half of every
 * sanitizer and of every term. Both sides of a match go through it, so a name typed precomposed
 * (`Müller`) is still found in text pasted decomposed (`Mu\u0308ller`).
 */
function cleanText(text: string): string {
  return text.replace(LINE_BREAKS, ' ').replace(INVISIBLE, '').normalize('NFC').replace(/\s+/gu, ' ').trim();
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
