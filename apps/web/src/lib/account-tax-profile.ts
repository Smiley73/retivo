/**
 * Pure account tax-profile logic (Roth / RMD UI activation).
 *
 * The draft shape, the untrusted-stored-value readers, the payload serializer, the
 * plain-English blocker list, and the completeness classifier the account editor,
 * the accounts list, and the exported report all share. Kept in `lib/` (not beside
 * the React section) so the report data builder can reuse it without `lib/`
 * depending on the UI layer.
 *
 * Two rules run through the whole surface:
 *
 *  1. **Derived values stay unstored.** A blank field stays blank and is OMITTED
 *     from the saved payload. The engines apply one-sided defaults: an absent
 *     Roth start year uses qualifying annual balance evidence and otherwise
 *     leaves the five-year rule unmet. Absent is a weaker claim than a stored
 *     `0`, and the difference is load-bearing.
 *  2. **Stored values are re-validated before they are read.** The v5/v6 migration
 *     sanitisers only run on below-current payloads, so a current-version row from
 *     an import (or a future build) arrives unsanitised. Everything goes through the
 *     shared validators (`db/roth-fact-validation.ts`, `db/rmd-fact-validation.ts`)
 *     and falls back to blank rather than crashing a consumer or round-tripping a
 *     corrupt value back to storage.
 */
import type { AccountPayload, AccountTaxTreatment, AccountType } from '../db/types';
import {
  isValidRmdBeneficiaryElection,
  isValidRmdBeneficiaryType,
  isValidRmdBoolean,
  isValidRmdIsoDate,
  type RmdBeneficiaryElection,
  type RmdBeneficiaryType,
} from '../db/rmd-fact-validation';
import { isValidRothTaxYear } from '../db/roth-fact-validation';
// The readiness list resolves the ENGINE's own rule so the editor and the
// projection can never disagree about which facts an inherited account requires.
import {
  isQualifyingAccount,
  resolveRmdRule,
  type RmdAccountProfileFacts,
  type RmdAccountType,
} from './rmd';
import { RMD_LIFE_EXPECTANCY_TABLES } from './rmd-life-expectancy-tables';

/** Roth IRA and designated-Roth employer types the section shows Roth fields for. */
const ROTH_IRA_TYPE: AccountType = 'RETIREMENT_ROTH_IRA';
const PURE_DESIGNATED_ROTH_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'RETIREMENT_ROTH_401K',
  'RETIREMENT_ROTH_403B',
  'RETIREMENT_ROTH_457B',
  'RETIREMENT_ROTH_TSP',
]);
/** Employer plans whose MIXED post-tax side is a Roth-designated slice. */
const MIXED_DESIGNATED_ROTH_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'RETIREMENT_401K',
  'RETIREMENT_403B',
  'RETIREMENT_457B',
  'RETIREMENT_TSP',
]);
/** Retirement account types that can be subject to required minimum
 *  distributions — as the owner, or as a beneficiary of an inherited account. */
const RMD_RELEVANT_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'RETIREMENT_401K',
  'RETIREMENT_IRA',
  'RETIREMENT_403B',
  'RETIREMENT_457B',
  'RETIREMENT_TSP',
  'RETIREMENT_CASH_BALANCE',
  'RETIREMENT_ROTH_IRA',
  'RETIREMENT_ROTH_401K',
  'RETIREMENT_ROTH_403B',
  'RETIREMENT_ROTH_457B',
  'RETIREMENT_ROTH_TSP',
]);
/** Employer plans the still-working exception can reach (never IRAs). */
export const EMPLOYER_PLAN_RMD_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'RETIREMENT_401K',
  'RETIREMENT_403B',
  'RETIREMENT_457B',
  'RETIREMENT_TSP',
  'RETIREMENT_CASH_BALANCE',
]);

/** True when the account's Roth-IRA §408A fields apply. */
export function showsRothIraFields(type: AccountType | ''): boolean {
  return type === ROTH_IRA_TYPE;
}

/** True when the account's designated-Roth (employer-plan) fields apply. */
export function showsDesignatedRothFields(
  type: AccountType | '',
  taxTreatment: AccountTaxTreatment | '',
): boolean {
  if (type === '') return false;
  if (PURE_DESIGNATED_ROTH_TYPES.has(type)) return true;
  return taxTreatment === 'MIXED' && MIXED_DESIGNATED_ROTH_TYPES.has(type);
}

/** True when the account's RMD-profile fields apply. */
export function showsRmdFields(type: AccountType | ''): boolean {
  return type !== '' && RMD_RELEVANT_TYPES.has(type);
}

/** Plain-string draft of every tax-profile fact. Strings throughout so an
 *  in-progress edit is representable and only complete, valid values are saved. */
export interface TaxProfileDraft {
  readonly rothIraFirstContributionTaxYear: string;
  // No Roth-IRA conversion list here: a conversion is recorded against the year
  // it happened, on that year's row on the Account Balances page. The in-plan
  // rollover list below is a different fact and stays on the account.
  readonly designatedRothFirstParticipationTaxYear: string;
  // No in-plan rollover list here either: like a conversion, a rollover is
  // recorded against the year it happened, on that year's balance row.
  readonly rmdInheritedAccount: boolean;
  readonly rmdCurrentEmployerPlan: boolean;
  readonly rmdFivePercentOwner: string;
  readonly rmdPlanRequiresDistributionAtStatutoryAge: string;
  readonly rmdFirstYearDeferralElected: boolean;
  readonly rmdSoleSpouseBeneficiary: boolean;
  // No spouse-birthdate draft field: the sole-spouse age gap is worked out from
  // the household's own member dates at projection time, so the editor neither
  // asks for nor stores a second copy.
  readonly rmdBeneficiaryType: string;
  readonly rmdInheritedOwnerDeathDate: string;
  readonly rmdInheritedOwnerDiedOnOrAfterRbd: string;
  readonly rmdOriginalOwnerBirthdate: string;
  readonly rmdBeneficiaryBirthdate: string;
  readonly rmdBeneficiaryElection: string;
}

export const EMPTY_TAX_PROFILE_DRAFT: TaxProfileDraft = {
  rothIraFirstContributionTaxYear: '',
  designatedRothFirstParticipationTaxYear: '',
  rmdInheritedAccount: false,
  rmdCurrentEmployerPlan: false,
  rmdFivePercentOwner: '',
  rmdPlanRequiresDistributionAtStatutoryAge: '',
  rmdFirstYearDeferralElected: false,
  rmdSoleSpouseBeneficiary: false,
  rmdBeneficiaryType: '',
  rmdInheritedOwnerDeathDate: '',
  rmdInheritedOwnerDiedOnOrAfterRbd: '',
  rmdOriginalOwnerBirthdate: '',
  rmdBeneficiaryBirthdate: '',
  rmdBeneficiaryElection: '',
};

/** Stored tax year → draft string, blank unless it passes the shared validator. */
function taxYearToDraft(value: unknown): string {
  return isValidRothTaxYear(value) ? String(value) : '';
}

/** Stored ISO date → draft string, blank unless it passes the shared validator
 *  (calendar-valid AND inside the documented `[1900, 2200]` bounds). */
function isoDateToDraft(value: unknown): string {
  return isValidRmdIsoDate(value) ? value : '';
}

/** Stored tri-state boolean → `''` (unknown) / `'yes'` / `'no'`. A non-boolean
 *  stored value reads back as UNKNOWN, which is the conservative default at the
 *  engine boundary (the favourable branch is never granted on a corrupt value). */
function triStateToDraft(value: unknown): string {
  if (!isValidRmdBoolean(value)) return '';
  return value ? 'yes' : 'no';
}

/** Draft tri-state → stored boolean, or `undefined` when left unknown. */
function draftToTriState(value: string): boolean | undefined {
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return undefined;
}

/**
 * Read an account payload into a tax-profile draft, validating EVERY stored value
 * first.
 *
 * The v5/v6 migration sanitisers only run on below-current payloads, so a
 * current-version row written by an import (or by a future version of this app)
 * reaches the editor unsanitised. Anything that fails a shared validator is
 * dropped to blank: the form then renders, the user can supply a real value, and a
 * corrupt value is never round-tripped back into storage.
 */
export function readTaxProfileDraft(payload: AccountPayload): TaxProfileDraft {
  return {
    rothIraFirstContributionTaxYear: taxYearToDraft(payload.rothIraFirstContributionTaxYear),
    designatedRothFirstParticipationTaxYear: taxYearToDraft(
      payload.designatedRothFirstParticipationTaxYear,
    ),
    rmdInheritedAccount: payload.rmdInheritedAccount === true,
    rmdCurrentEmployerPlan: payload.rmdCurrentEmployerPlan === true,
    rmdFivePercentOwner: triStateToDraft(payload.rmdFivePercentOwner),
    rmdPlanRequiresDistributionAtStatutoryAge: triStateToDraft(
      payload.rmdPlanRequiresDistributionAtStatutoryAge,
    ),
    rmdFirstYearDeferralElected: payload.rmdFirstYearDeferralElected === true,
    rmdSoleSpouseBeneficiary: payload.rmdSoleSpouseBeneficiary === true,
    rmdBeneficiaryType: isValidRmdBeneficiaryType(payload.rmdBeneficiaryType)
      ? payload.rmdBeneficiaryType
      : '',
    rmdInheritedOwnerDeathDate: isoDateToDraft(payload.rmdInheritedOwnerDeathDate),
    rmdInheritedOwnerDiedOnOrAfterRbd: triStateToDraft(
      payload.rmdInheritedOwnerDiedOnOrAfterRbd,
    ),
    rmdOriginalOwnerBirthdate: isoDateToDraft(payload.rmdOriginalOwnerBirthdate),
    rmdBeneficiaryBirthdate: isoDateToDraft(payload.rmdBeneficiaryBirthdate),
    rmdBeneficiaryElection: isValidRmdBeneficiaryElection(payload.rmdBeneficiaryElection)
      ? payload.rmdBeneficiaryElection
      : '',
  };
}

/** Parse a draft tax-year string against the shared `[1998, 2200]` validator. */
function parseTaxYear(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number.parseInt(trimmed, 10);
  return isValidRothTaxYear(n) ? n : undefined;
}

/** Parse a draft ISO date against the shared calendar + bounds validator. */
function parseIsoDate(raw: string): string | undefined {
  const trimmed = raw.trim();
  return isValidRmdIsoDate(trimmed) ? trimmed : undefined;
}

/**
 * Serialize a draft into the sparse-optional `AccountPayload` tax-fact fields.
 *
 * Only fields the account TYPE can meaningfully carry are emitted, so switching a
 * Roth IRA to a brokerage account does not leave orphan Roth facts behind, and an
 * owner account never keeps stale inherited-beneficiary facts. Every emitted value
 * has passed the same validator the engines apply; anything blank or invalid is
 * omitted, which is what makes the engines' conservative defaults apply.
 */
export function taxProfileToPayloadFields(
  draft: TaxProfileDraft,
  type: AccountType | '',
  taxTreatment: AccountTaxTreatment | '',
  /** Household birthdates independently prove Table II eligibility. */
  soleSpouseEligible = false,
): Partial<AccountPayload> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown): void => {
    if (value !== undefined) out[key] = value;
  };
  if (showsRothIraFields(type)) {
    put('rothIraFirstContributionTaxYear', parseTaxYear(draft.rothIraFirstContributionTaxYear));
  }
  if (showsDesignatedRothFields(type, taxTreatment)) {
    put(
      'designatedRothFirstParticipationTaxYear',
      parseTaxYear(draft.designatedRothFirstParticipationTaxYear),
    );
  }
  if (showsRmdFields(type)) {
    if (draft.rmdInheritedAccount) {
      out.rmdInheritedAccount = true;
      put('rmdBeneficiaryType', draft.rmdBeneficiaryType === '' ? undefined : draft.rmdBeneficiaryType);
      put('rmdInheritedOwnerDeathDate', parseIsoDate(draft.rmdInheritedOwnerDeathDate));
      put(
        'rmdInheritedOwnerDiedOnOrAfterRbd',
        draftToTriState(draft.rmdInheritedOwnerDiedOnOrAfterRbd),
      );
      put('rmdOriginalOwnerBirthdate', parseIsoDate(draft.rmdOriginalOwnerBirthdate));
      // The beneficiary is the account's household owner. A legacy copied date
      // may still be read as a fallback when no household date exists, but the
      // editor never writes that hidden duplicate back. This lets the canonical
      // household date take over permanently on the next save.
      put(
        'rmdBeneficiaryElection',
        draft.rmdBeneficiaryElection === '' ? undefined : draft.rmdBeneficiaryElection,
      );
    } else if (type !== '' && isQualifyingAccount(type, taxTreatment || 'POST_TAX')) {
      if (EMPLOYER_PLAN_RMD_TYPES.has(type as AccountType)) {
        if (draft.rmdCurrentEmployerPlan) out.rmdCurrentEmployerPlan = true;
        put('rmdFivePercentOwner', draftToTriState(draft.rmdFivePercentOwner));
        put(
          'rmdPlanRequiresDistributionAtStatutoryAge',
          draftToTriState(draft.rmdPlanRequiresDistributionAtStatutoryAge),
        );
      }
      if (draft.rmdFirstYearDeferralElected) out.rmdFirstYearDeferralElected = true;
      // Only the DESIGNATION is stored. The spouse's birthdate is read from the
      // household record at projection time, so it is deliberately NOT copied
      // onto the account — one date, one place, no drift.
      if (draft.rmdSoleSpouseBeneficiary && soleSpouseEligible) {
        out.rmdSoleSpouseBeneficiary = true;
      }
    }
  }
  return out as Partial<AccountPayload>;
}

/**
 * Plain-English label per editable year field, mirroring the editor's own labels
 * (same convention as {@link RMD_BLOCKER_LABELS} below), so a save refusal names
 * the field the user is looking at rather than a storage key.
 */
const TAX_PROFILE_FIELD_LABELS = {
  rothIraFirstContributionTaxYear: 'Year of your first Roth IRA contribution',
  designatedRothFirstParticipationTaxYear: 'Year Roth contributions to this plan began',
} as const;

/**
 * INHERITED-account variant of the Roth-IRA year label, whose value belongs to
 * the ORIGINAL owner rather than the person filling the form.
 *
 * The year recorded here is the ORIGINAL owner's first contribution year — the
 * account never merges with anything the beneficiary opened themselves. The plain
 * "your first Roth IRA contribution" wording asked for the wrong person's year.
 */
const INHERITED_ROTH_IRA_FIELD_LABELS = {
  rothIraFirstContributionTaxYear: 'Year the original owner first contributed to a Roth IRA',
} as const;

/** The Roth-IRA field label to show (and to name in a save refusal), picking the
 *  inherited-account variant when the account was inherited. Shared by the editor
 *  and {@link taxProfileValidationError} so the refusal always quotes the label the
 *  user is actually looking at. */
export function rothIraFieldLabel(
  field: keyof typeof INHERITED_ROTH_IRA_FIELD_LABELS,
  inherited: boolean,
): string {
  return inherited
    ? INHERITED_ROTH_IRA_FIELD_LABELS[field]
    : TAX_PROFILE_FIELD_LABELS[field];
}

/** True when the field holds something the user typed that cannot be read as a
 *  tax year inside the supported range. Blank is fine. */
function unreadableTaxYear(raw: string): boolean {
  return raw.trim() !== '' && parseTaxYear(raw) === undefined;
}

/**
 * Plain-English refusal when a tax-detail year cannot be read, else `null`.
 * Checked on save BEFORE anything is written, so a mistyped figure is corrected
 * instead of being silently omitted from the stored payload — an omission the
 * engines then read as "nothing recorded" and quietly apply a cautious default
 * to, with the user believing they had recorded it.
 *
 * Scoped to the two year fields because they are the only free-text ones the
 * editor still asks for: the dates all come from the shared `DatePicker`,
 * bounded by `MIN_RMD_ISO_DATE` / `MAX_RMD_ISO_DATE`, so its value is either a
 * valid in-range `YYYY-MM-DD` or empty and there is nothing to reject; the
 * tri-state and category fields are closed `<Select>` lists. The two Roth-basis
 * DOLLAR TOTALS this used to also spare from refusal are gone from the payload
 * outright (schema v7) — there is no longer a stored value to omit or
 * refuse on save.
 */
export function taxProfileValidationError(
  draft: TaxProfileDraft,
  type: AccountType | '',
  taxTreatment: AccountTaxTreatment | '',
): string | null {
  const problems: string[] = [];
  if (showsRothIraFields(type)) {
    // An inherited Roth IRA's year field is labelled for the ORIGINAL owner, so
    // the refusal must quote that variant (the editor shows it).
    if (unreadableTaxYear(draft.rothIraFirstContributionTaxYear)) {
      problems.push(
        `“${rothIraFieldLabel('rothIraFirstContributionTaxYear', draft.rmdInheritedAccount)}”`,
      );
    }
  }
  if (showsDesignatedRothFields(type, taxTreatment)) {
    if (unreadableTaxYear(draft.designatedRothFirstParticipationTaxYear)) {
      problems.push(`“${TAX_PROFILE_FIELD_LABELS.designatedRothFirstParticipationTaxYear}”`);
    }
  }
  if (problems.length === 0) return null;
  return (
    `Please check ${problems.join(', ')}. ` +
    'Enter years as four digits (for example 2019).'
  );
}

/**
 * Plain-English label per WITHHOLD reason the RMD engine can report, so the
 * readiness list tells the user what to enter (or what the model cannot do)
 * rather than echoing an engine field name. Keys are the exact
 * `RmdRuleResolution.missingFacts` strings `resolveRmdRule` /
 * `validateRmdProfileFacts` emit — that is the contract this list follows, so an
 * unrecognised reason falls through to its raw key instead of being dropped
 * silently.
 */
const RMD_BLOCKER_LABELS: Readonly<Record<string, string>> = {
  beneficiaryType: 'Who inherited this account',
  inheritedOwnerDeathDate: "The original owner's date of death",
  inheritedOwnerDiedOnOrAfterRbd:
    'Whether the original owner had reached their RMD start date',
  beneficiaryBirthdate: 'The date of birth of whoever inherited it',
  beneficiaryElection:
    'Whether withdrawals spread over a lifetime or empty within ten years',
  originalOwnerBirthdate: "The original owner's date of birth",
  preSecureActDeathRulesUnsupported:
    'Deaths before 2020 follow older rules this planner does not model, so no required withdrawal is estimated for this account',
  nonPersonGhostLifeScheduleUnsupported:
    'An estate, charity or trust beneficiary of an owner who died after their RMD start date follows a schedule this planner does not model yet',
  tenYearElectionInvalidWhenOwnerDiedOnOrAfterRbd:
    'The ten-year choice is not available when the original owner had already reached their RMD start date — pick lifetime withdrawals instead',
  minorChildBeneficiaryNotMinorAtDeath:
    'This beneficiary was already 21 when the owner died, so they are not the owner’s minor child — pick another category',
  taxYearBeforeOwnerDeath: "The original owner's date of death",
  deathYearIsOwnersFinalRmdYear: "The original owner's date of death",
};

/** The probe tax year for the engine resolution below: the FIRST beneficiary
 *  year (the year after the owner's death), which is the year every post-death
 *  rule's required facts are first exercised. Clamped to the engine's minimum
 *  supported tax year; an unresolvable death date is itself a blocker, so the
 *  fallback year only has to be supported. */
function blockerProbeTaxYear(deathDate: string | undefined): number {
  const deathYear = deathDate === undefined ? undefined : Number(deathDate.slice(0, 4));
  if (deathYear === undefined || !Number.isFinite(deathYear)) return 2024;
  return Math.max(2024, deathYear + 1);
}

/**
 * Missing / unsupported inherited-account facts that BLOCK this account's
 * required-withdrawal estimate, in plain English.
 *
 * Derived from the ENGINE'S OWN resolution (`resolveRmdRule`, which itself starts
 * from `validateRmdProfileFacts`), resolved for the first beneficiary year — not
 * from a second, looser predicate maintained beside it. An earlier looser
 * predicate disagreed with the engine in BOTH directions: the editor
 * demanded a birthdate and an election from an estate/charity (`NON_PERSON`) and from a plain named beneficiary
 * (`OTHER_DESIGNATED`) that neither rule needs, while never surfacing the real
 * engine blockers (a missing original-owner birthdate when the owner died on/after
 * their required beginning date, a pre-2020 death, a ten-year election that is
 * invalid for an on/after-RBD death, a "minor child" who was already 21).
 *
 * Owner (non-inherited) accounts have no required facts — every absent fact has a
 * conservative default — so they never block.
 */
export function rmdBlockerMessages(
  draft: TaxProfileDraft,
  /** The account type, which decides whether inherited RMD rules apply at all
   *  (an inherited brokerage account owes no required withdrawal). Absent → a
   *  traditional IRA, the most common inherited retirement account. */
  type: AccountType | '' = 'RETIREMENT_IRA',
  /** The beneficiary's canonical household birthdate. The account owner is the
   *  beneficiary for an inherited account, so the editor does not ask for a
   *  duplicate date. A legacy per-account date remains a valid fallback. */
  householdBeneficiaryBirthdate?: string,
): readonly string[] {
  if (!draft.rmdInheritedAccount) return [];
  if (type !== '' && !showsRmdFields(type)) return [];
  const facts: RmdAccountProfileFacts = {
    inheritedAccount: true,
    beneficiaryType: (draft.rmdBeneficiaryType || undefined) as RmdBeneficiaryType | undefined,
    inheritedOwnerDeathDate: parseIsoDate(draft.rmdInheritedOwnerDeathDate),
    inheritedOwnerDiedOnOrAfterRbd: draftToTriState(draft.rmdInheritedOwnerDiedOnOrAfterRbd),
    beneficiaryBirthdate:
      parseIsoDate(householdBeneficiaryBirthdate ?? '') ??
      parseIsoDate(draft.rmdBeneficiaryBirthdate),
    originalOwnerBirthdate: parseIsoDate(draft.rmdOriginalOwnerBirthdate),
    beneficiaryElection: (draft.rmdBeneficiaryElection || undefined) as
      | RmdBeneficiaryElection
      | undefined,
  };
  const resolution = resolveRmdRule({
    facts,
    accountType: (type === '' ? 'RETIREMENT_IRA' : type) as RmdAccountType,
    // An inherited account's rule never depends on the tax treatment (the
    // inherited branch runs before the living-owner qualification test).
    taxTreatment: 'PRE_TAX',
    ages: {},
    taxYear: blockerProbeTaxYear(facts.inheritedOwnerDeathDate),
    tables: RMD_LIFE_EXPECTANCY_TABLES,
  });
  if (resolution.kind !== 'withheld') return [];
  // De-duplicate: two engine reasons can map to the same plain-English ask.
  const seen = new Set<string>();
  const messages: string[] = [];
  for (const reason of resolution.missingFacts) {
    const message = RMD_BLOCKER_LABELS[reason] ?? reason;
    if (seen.has(message)) continue;
    seen.add(message);
    messages.push(message);
  }
  return messages;
}

/**
 * Inherited-account blockers for an editor save. Unlike the runtime reader,
 * this validates the exact state the serializer will produce: the hidden legacy
 * beneficiary-birthdate copy is deliberately omitted, so it cannot make a save
 * look valid immediately before that same save removes its only date.
 */
export function rmdSaveBlockerMessages(
  draft: TaxProfileDraft,
  type: AccountType | '' = 'RETIREMENT_IRA',
  householdBeneficiaryBirthdate?: string,
): readonly string[] {
  return rmdBlockerMessages(
    { ...draft, rmdBeneficiaryBirthdate: '' },
    type,
    householdBeneficiaryBirthdate,
  ).map((message) =>
    message === RMD_BLOCKER_LABELS.beneficiaryBirthdate
      ? "The account owner's date of birth on the Household screen"
      : message,
  );
}

/**
 * The plaintext byte budget for one account payload.
 *
 * Sync pushes ONE aggregate payload per mutation and the API rejects any payload
 * over 64 KB (`MUTATION_PAYLOAD_TOO_LARGE`). What travels is the
 * ENCRYPTED envelope, so the plaintext budget has to leave room for AES-GCM
 * ciphertext + base64 expansion (≈ 4/3) plus the envelope's own metadata. 40 KB of
 * plaintext keeps the encrypted payload comfortably under the cap.
 *
 * Without this check the tax-details editor could store a locally-valid account
 * (200 conversion lots + 200 rollover lots + an unbounded notes field) that the
 * server then refuses forever, leaving the account permanently unsyncable with no
 * explanation. Checking BEFORE the local save turns that into an actionable
 * validation error.
 */
export const MAX_ACCOUNT_PAYLOAD_PLAINTEXT_BYTES = 40 * 1024;

/**
 * Plain-English error when an account payload would exceed the sync budget, else
 * `null`. Measures the SERIALIZED payload (the exact shape the sync queue pushes),
 * so trimming notes or lots visibly moves the number.
 */
export function accountPayloadSizeError(payload: unknown): string | null {
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(payload) ?? '').length;
  } catch {
    // A payload that cannot even be serialized could never sync either.
    return 'These account details cannot be saved. Please shorten the notes.';
  }
  if (bytes <= MAX_ACCOUNT_PAYLOAD_PLAINTEXT_BYTES) return null;
  const overKb = Math.ceil((bytes - MAX_ACCOUNT_PAYLOAD_PLAINTEXT_BYTES) / 1024);
  return `These account details are too large to save and sync (about ${overKb} KB over the limit). Please shorten the notes.`;
}

/**
 * How complete an account's tax details are, for the accounts list.
 *
 *  - `notApplicable` — the account type carries no Roth / required-withdrawal facts.
 *  - `blocked` — an inherited account is missing a fact the rules REQUIRE, so its
 *    required-withdrawal estimate is withheld until the user supplies it.
 *  - `partial` — some relevant facts are still blank, so the projection is using a
 *    cautious default for those (it can overstate tax, never understate it).
 *  - `complete` — every fact this account type needs is recorded.
 */
export type TaxProfileCompleteness = 'notApplicable' | 'complete' | 'partial' | 'blocked';

/** Classify one stored account payload's tax-detail completeness. Every stored
 *  value goes through `readTaxProfileDraft` first, so a corrupt value counts as
 *  MISSING rather than silently passing as recorded. */
export function taxProfileCompleteness(
  payload: AccountPayload,
  householdBeneficiaryBirthdate?: string,
): TaxProfileCompleteness {
  const type = payload.type;
  const taxTreatment = payload.taxTreatment;
  const showRothIra = showsRothIraFields(type);
  const showDesignated = showsDesignatedRothFields(type, taxTreatment);
  const showRmd = showsRmdFields(type);
  if (!showRothIra && !showDesignated && !showRmd) return 'notApplicable';
  const draft = readTaxProfileDraft(payload);
  if (rmdBlockerMessages(draft, type, householdBeneficiaryBirthdate).length > 0) {
    return 'blocked';
  }
  // Neither Roth basis total is listed: the app no longer asks for one, and both
  // engines derive it from recorded balance history instead. Both first-year
  // anchors stay, on every account type including an inherited Roth IRA.
  const required: string[] = [];
  if (showRothIra) {
    required.push(draft.rothIraFirstContributionTaxYear);
  }
  if (showDesignated) {
    required.push(draft.designatedRothFirstParticipationTaxYear);
  }
  if (
    showRmd &&
    !draft.rmdInheritedAccount &&
    isQualifyingAccount(type, taxTreatment) &&
    EMPLOYER_PLAN_RMD_TYPES.has(type)
  ) {
    // The two still-working questions are the only RMD facts an OWNER account can
    // leave in a genuinely cautious state: unanswered, the §401(a)(9)(C) deferral is
    // denied and the plan is treated as distributing at the statutory age. Without
    // them in `required`, a brand-new employer plan with nothing entered at all
    // reported `complete` — telling the user there was nothing left to record while
    // the projection was in fact using a cautious default. (An IRA is correctly
    // absent here: the still-working exception never reaches an IRA, so those
    // questions are not asked and nothing is left unanswered.)
    required.push(draft.rmdFivePercentOwner, draft.rmdPlanRequiresDistributionAtStatutoryAge);
  }
  // The sole-spouse designation needs no companion field here: the spouse's
  // birthdate comes from the household record, not this editor, so there is
  // nothing the user could fill in on this account to complete it.
  return required.some((value) => value === '') ? 'partial' : 'complete';
}
