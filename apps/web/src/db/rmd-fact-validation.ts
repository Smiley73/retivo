// Shared stored-RMD-fact validators (ISO-date bound, beneficiary vocabulary) used by both the account v5-to-v6 migration
// and the runtime RMD-engine boundary, which re-validates because a current-version row bypasses migrations.

// Beneficiary category for an inherited account, selecting the SECURE Act post-death rule (10-year, life-expectancy
// stretch for an eligible designated beneficiary, or 5-year/ghost-life for a non-designated one).
// `AccountPayload.rmdBeneficiaryType` re-exports the type; the DB-free RMD engine mirrors the literals locally.
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

// Post-death election of an inherited-account beneficiary (SECURE Act): an eligible designated beneficiary takes the
// life-expectancy stretch or elects the 10-year rule. The engine never invents it, so an absent election withholds.
// `AccountPayload.rmdBeneficiaryElection` re-exports the type. A surviving spouse who treats the account as their own
// is modeled as an owner account, not inherited.
const RMD_BENEFICIARY_ELECTIONS = ['LIFE_EXPECTANCY', 'TEN_YEAR'] as const;

export type RmdBeneficiaryElection = (typeof RMD_BENEFICIARY_ELECTIONS)[number];

const RMD_BENEFICIARY_ELECTION_SET: ReadonlySet<string> = new Set(RMD_BENEFICIARY_ELECTIONS);

// Static year bounds for a stored RMD birth/death date; the upper bound mirrors the Roth `[1998, 2200]` ceiling and
// 1900 predates any living owner. A valid-looking date outside them (e.g. `9999-12-31`) is a CWE-20 hazard: the
// migration drops it so the engine withholds.
const MIN_RMD_DATE_YEAR = 1900;
const MAX_RMD_DATE_YEAR = 2200;

/**
 * The inclusive `YYYY-MM-DD` bounds `isValidRmdIsoDate` accepts, as the shared `DatePicker`'s `min`/`max`, so the
 * account editor refuses an out-of-bounds date at the control instead of silently omitting the fact at save.
 */
export const MIN_RMD_ISO_DATE = `${String(MIN_RMD_DATE_YEAR)}-01-01`;
export const MAX_RMD_ISO_DATE = `${String(MAX_RMD_DATE_YEAR)}-12-31`;

/**
 * True for a boolean, the only valid stored form of the RMD flag facts; otherwise the migration drops it and the
 * engine's conservative default applies.
 */
export function isValidRmdBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * True for a valid stored ISO `YYYY-MM-DD` date (spouse-beneficiary birthdate, inherited-owner death date, inheritor
 * birthdate): rejects malformed strings, impossible dates (Feb 30, non-leap Feb 29, via a UTC round-trip) and years
 * outside `[MIN_RMD_DATE_YEAR, MAX_RMD_DATE_YEAR]`. Never throws.
 */
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

/**
 * True for a known beneficiary category; an out-of-vocabulary value (corrupt or tampered) is dropped by the migration,
 * so the engine withholds the inherited RMD and lists the missing fact rather than guess a rule.
 */
export function isValidRmdBeneficiaryType(value: unknown): value is RmdBeneficiaryType {
  return typeof value === 'string' && RMD_BENEFICIARY_TYPE_SET.has(value);
}

/**
 * True for a known post-death election; an out-of-vocabulary value is dropped, so the engine withholds rather than
 * guess between the stretch and the 10-year rule.
 */
export function isValidRmdBeneficiaryElection(value: unknown): value is RmdBeneficiaryElection {
  return typeof value === 'string' && RMD_BENEFICIARY_ELECTION_SET.has(value);
}
