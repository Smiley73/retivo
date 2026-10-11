/**
 * Shared stored-RMD-fact validators. Single source of truth for
 * the stored ISO-date bound and the beneficiary-category vocabulary so the
 * MIGRATION-TIME sanitiser (`migrations.ts`, account v5→v6) and the
 * RUNTIME consumption boundary (the fact-based RMD engine in projection
 * output) cannot silently diverge. Mirrors the
 * `roth-fact-validation.ts` precedent.
 *
 * A CURRENT-schema-version (v6) row bypasses the v5→v6 migration entirely
 * (migrations only run on payloads below the current version), so a
 * directly-imported / hand-constructed v6 payload must be re-validated at the
 * runtime boundary against the IDENTICAL bounds.
 */

/**
 * Beneficiary category for an INHERITED (non-owner) retirement account. Selects
 * the applicable post-death distribution rule under the SECURE Act (10-year rule
 * vs a life-expectancy stretch for an eligible designated beneficiary vs the
 * 5-year / ghost-life rule for a non-designated beneficiary). This is the SSOT
 * union — `AccountPayload.rmdBeneficiaryType` re-exports it, and the DB-free RMD
 * engine mirrors the literal values locally (matching how `rmd.ts` mirrors
 * `AccountType`).
 */
const RMD_BENEFICIARY_TYPES = [
  'SPOUSE',
  'MINOR_CHILD_OF_OWNER',
  'DISABLED_OR_CHRONICALLY_ILL',
  'NOT_MORE_THAN_10_YEARS_YOUNGER',
  'OTHER_DESIGNATED',
  'NON_PERSON',
] as const;

export type RmdBeneficiaryType = (typeof RMD_BENEFICIARY_TYPES)[number];

const RMD_BENEFICIARY_TYPE_SET: ReadonlySet<string> = new Set(RMD_BENEFICIARY_TYPES);

/**
 * Post-death distribution ELECTION an inherited-account beneficiary affirmatively
 * makes (SECURE Act). An eligible designated beneficiary may take the
 * life-expectancy stretch OR elect the 10-year rule; the engine must not INVENT
 * this choice — an absent election WITHHOLDS the inherited RMD. This
 * is the SSOT union; `AccountPayload.rmdBeneficiaryElection` re-exports it and the
 * DB-free RMD engine mirrors the literal values locally.
 *
 * A surviving spouse who instead TREATS the account as their OWN is modeled as an
 * OWNER account (not inherited), so the inherited path assumes spouse-remains-
 * beneficiary; that own-IRA rollover is out of scope for this election.
 */
const RMD_BENEFICIARY_ELECTIONS = ['LIFE_EXPECTANCY', 'TEN_YEAR'] as const;

export type RmdBeneficiaryElection = (typeof RMD_BENEFICIARY_ELECTIONS)[number];

const RMD_BENEFICIARY_ELECTION_SET: ReadonlySet<string> = new Set(RMD_BENEFICIARY_ELECTIONS);

/** Documented static year bounds for a stored RMD-related birth/death date. The
 *  upper bound mirrors the Roth fact-validation `[1998, 2200]` tax-year ceiling;
 *  1900 predates any living retirement-account owner. A syntactically valid but
 *  out-of-bounds date (e.g. `9999-12-31`) is a CWE-20 hazard — the migration
 *  DROPS it (never invents a replacement) so the engine withholds. */
const MIN_RMD_DATE_YEAR = 1900;
const MAX_RMD_DATE_YEAR = 2200;

/** The inclusive `YYYY-MM-DD` bounds `isValidRmdIsoDate` accepts, as the same
 *  strings the shared `DatePicker`'s `min` / `max` take. Exported so the account
 *  tax-details editor refuses an out-of-bounds date AT THE CONTROL rather than
 *  accepting it and silently omitting the fact at save time. */
export const MIN_RMD_ISO_DATE = `${String(MIN_RMD_DATE_YEAR)}-01-01`;
export const MAX_RMD_ISO_DATE = `${String(MAX_RMD_DATE_YEAR)}-12-31`;

/** True when `value` is a boolean (the only valid stored form for the RMD flag
 *  facts). Absent / non-boolean → dropped by the migration → the field's
 *  conservative absent-default applies at the engine boundary. */
export function isValidRmdBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** True when `value` is a valid stored ISO `YYYY-MM-DD` calendar date (used for
 *  the spouse-beneficiary birthdate, the inherited-owner death date, and the
 *  inheritor birthdate). Rejects malformed strings and impossible calendar
 *  dates (Feb 30, Apr 31, non-leap Feb 29) via a UTC round-trip, AND implausible
 *  in-range-but-out-of-bounds years outside `[MIN_RMD_DATE_YEAR,
 *  MAX_RMD_DATE_YEAR]` (e.g. `9999-12-31`). Never throws. */
export function isValidRmdIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]); // 1-based
  const day = Number(match[3]);
  if (year < MIN_RMD_DATE_YEAR || year > MAX_RMD_DATE_YEAR) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/** True when `value` is one of the known beneficiary categories. A stored value
 *  outside the vocabulary (corrupt / tampered) is dropped by the migration —
 *  which makes an inherited account's RMD un-computable (the engine
 *  WITHHOLDS and lists the missing fact) rather than silently guessing a rule. */
export function isValidRmdBeneficiaryType(value: unknown): value is RmdBeneficiaryType {
  return typeof value === 'string' && RMD_BENEFICIARY_TYPE_SET.has(value);
}

/** True when `value` is one of the known post-death distribution elections. An
 *  out-of-vocabulary stored value (corrupt / tampered) is dropped by the
 *  migration — which makes an inherited account's RMD un-computable (the
 *  engine WITHHOLDS the missing election) rather than silently guessing between
 *  the life-expectancy stretch and the 10-year rule. */
export function isValidRmdBeneficiaryElection(value: unknown): value is RmdBeneficiaryElection {
  return typeof value === 'string' && RMD_BENEFICIARY_ELECTION_SET.has(value);
}
