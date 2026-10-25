// Pure account tax-profile logic (Roth / RMD fields): draft, stored-value readers, payload serializer,
// blocker list and completeness classifier. In `lib/` so the report builder can reuse it without the UI layer.

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
import {
  isQualifyingAccount,
  resolveRmdRule,
  type RmdAccountProfileFacts,
  type RmdAccountType,
} from './rmd';
import { RMD_LIFE_EXPECTANCY_TABLES } from './rmd-life-expectancy-tables';

const ROTH_IRA_TYPE: AccountType = 'RETIREMENT_ROTH_IRA';
const PURE_DESIGNATED_ROTH_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'RETIREMENT_ROTH_401K',
  'RETIREMENT_ROTH_403B',
  'RETIREMENT_ROTH_457B',
  'RETIREMENT_ROTH_TSP',
]);
const MIXED_DESIGNATED_ROTH_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'RETIREMENT_401K',
  'RETIREMENT_403B',
  'RETIREMENT_457B',
  'RETIREMENT_TSP',
]);
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
export const EMPLOYER_PLAN_RMD_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'RETIREMENT_401K',
  'RETIREMENT_403B',
  'RETIREMENT_457B',
  'RETIREMENT_TSP',
  'RETIREMENT_CASH_BALANCE',
]);

export function showsRothIraFields(type: AccountType | ''): boolean {
  return type === ROTH_IRA_TYPE;
}

export function showsDesignatedRothFields(
  type: AccountType | '',
  taxTreatment: AccountTaxTreatment | '',
): boolean {
  if (type === '') return false;
  if (PURE_DESIGNATED_ROTH_TYPES.has(type)) return true;
  return taxTreatment === 'MIXED' && MIXED_DESIGNATED_ROTH_TYPES.has(type);
}

export function showsRmdFields(type: AccountType | ''): boolean {
  return type !== '' && RMD_RELEVANT_TYPES.has(type);
}

/** Strings throughout, so an in-progress edit is representable and only complete valid values are saved. */
export interface TaxProfileDraft {
  readonly rothIraFirstContributionTaxYear: string;
  readonly designatedRothFirstParticipationTaxYear: string;
  readonly rmdInheritedAccount: boolean;
  readonly rmdCurrentEmployerPlan: boolean;
  readonly rmdFivePercentOwner: string;
  readonly rmdPlanRequiresDistributionAtStatutoryAge: string;
  readonly rmdFirstYearDeferralElected: boolean;
  readonly rmdSoleSpouseBeneficiary: boolean;
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

function taxYearToDraft(value: unknown): string {
  return isValidRothTaxYear(value) ? String(value) : '';
}

function isoDateToDraft(value: unknown): string {
  return isValidRmdIsoDate(value) ? value : '';
}

// An unreadable stored value reads back as unknown, so the favourable branch is never granted on a corrupt value.
function triStateToDraft(value: unknown): string {
  if (!isValidRmdBoolean(value)) return '';
  return value ? 'yes' : 'no';
}

function draftToTriState(value: string): boolean | undefined {
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return undefined;
}

/**
 * Reads an account payload into a draft. Every stored value is re-validated: the
 * v5/v6 sanitisers only run on below-current payloads, so an imported or
 * future-build row arrives unsanitised. A value that fails a shared validator
 * becomes blank, so a corrupt value is never round-tripped into storage.
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

function parseTaxYear(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number.parseInt(trimmed, 10);
  return isValidRothTaxYear(n) ? n : undefined;
}

function parseIsoDate(raw: string): string | undefined {
  const trimmed = raw.trim();
  return isValidRmdIsoDate(trimmed) ? trimmed : undefined;
}

/**
 * Serializes a draft into the sparse optional `AccountPayload` tax fields. A
 * blank or invalid field is omitted, not stored as `0`: the engines apply one-sided
 * conservative defaults, and absent is a weaker claim than a stored value. Only
 * fields the account type can carry are emitted, so a retyped account keeps no
 * orphan Roth or inherited-beneficiary facts.
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
      // The beneficiary is the account's household owner: a legacy copied date is read as a
      // fallback but never written back, so the household date takes over on the next save.
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
      // Only the designation is stored; the spouse's birthdate comes from the household record.
      if (draft.rmdSoleSpouseBeneficiary && soleSpouseEligible) {
        out.rmdSoleSpouseBeneficiary = true;
      }
    }
  }
  return out as Partial<AccountPayload>;
}

const TAX_PROFILE_FIELD_LABELS = {
  rothIraFirstContributionTaxYear: 'Year of your first Roth IRA contribution',
  designatedRothFirstParticipationTaxYear: 'Year Roth contributions to this plan began',
} as const;

// The inherited-account variant: the year belongs to the original owner, not the person filling the form.
const INHERITED_ROTH_IRA_FIELD_LABELS = {
  rothIraFirstContributionTaxYear: 'Year the original owner first contributed to a Roth IRA',
} as const;

/** The Roth-IRA year label, shared with the save refusal so it quotes what the user sees. */
export function rothIraFieldLabel(
  field: keyof typeof INHERITED_ROTH_IRA_FIELD_LABELS,
  inherited: boolean,
): string {
  return inherited
    ? INHERITED_ROTH_IRA_FIELD_LABELS[field]
    : TAX_PROFILE_FIELD_LABELS[field];
}

function unreadableTaxYear(raw: string): boolean {
  return raw.trim() !== '' && parseTaxYear(raw) === undefined;
}

/**
 * Plain-English refusal when a tax-detail year cannot be read, else `null`.
 * Checked before anything is written, so a mistyped year is corrected rather
 * than silently omitted, which the engines would read as "nothing recorded".
 * Only the two year fields are free text; dates come from the `DatePicker` and
 * the rest are closed lists.
 */
export function taxProfileValidationError(
  draft: TaxProfileDraft,
  type: AccountType | '',
  taxTreatment: AccountTaxTreatment | '',
): string | null {
  const problems: string[] = [];
  if (showsRothIraFields(type)) {
    // The inherited variant is labelled for the original owner, so the refusal quotes it.
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

// Keys are the `RmdRuleResolution.missingFacts` strings the engine emits; an unrecognised reason falls through to its raw key.
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

// The first beneficiary year, where every post-death rule's required facts are first exercised.
// Clamped to the engine's minimum year; an unresolvable death date is itself a blocker.
function blockerProbeTaxYear(deathDate: string | undefined): number {
  const deathYear = deathDate === undefined ? undefined : Number(deathDate.slice(0, 4));
  if (deathYear === undefined || !Number.isFinite(deathYear)) return 2024;
  return Math.max(2024, deathYear + 1);
}

/**
 * Missing or unsupported inherited-account facts that block the required-withdrawal
 * estimate, in plain English. Derived from the engine's own `resolveRmdRule` for
 * the first beneficiary year, so the editor and the projection cannot disagree.
 * Owner accounts have conservative defaults and never block.
 */
export function rmdBlockerMessages(
  draft: TaxProfileDraft,
  /** Decides whether inherited rules apply at all (an inherited brokerage account owes none). */
  type: AccountType | '' = 'RETIREMENT_IRA',
  /** The beneficiary's household birthdate; a legacy per-account date is the fallback. */
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
    // The inherited branch runs before the living-owner qualification test.
    taxTreatment: 'PRE_TAX',
    ages: {},
    taxYear: blockerProbeTaxYear(facts.inheritedOwnerDeathDate),
    tables: RMD_LIFE_EXPECTANCY_TABLES,
  });
  if (resolution.kind !== 'withheld') return [];
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
 * Inherited-account blockers for an editor save. It validates the state the
 * serializer will produce, which omits the hidden legacy birthdate copy, so
 * that copy cannot make a save look valid just before the save removes it.
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
 * Plaintext byte budget for one account payload. The API rejects a pushed
 * payload over 64 KB, and what travels is the encrypted envelope (AES-GCM plus
 * base64, about 4/3) with its metadata, so 40 KB of plaintext fits. Checked
 * before the local save, or an oversized account would be locally valid yet
 * unsyncable for good.
 */
const MAX_ACCOUNT_PAYLOAD_PLAINTEXT_BYTES = 40 * 1024;

/** Plain-English error when the serialized payload exceeds the sync budget, else `null`. */
export function accountPayloadSizeError(payload: unknown): string | null {
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(payload) ?? '').length;
  } catch {
    // A payload that cannot be serialized could never sync either.
    return 'These account details cannot be saved. Please shorten the notes.';
  }
  if (bytes <= MAX_ACCOUNT_PAYLOAD_PLAINTEXT_BYTES) return null;
  const overKb = Math.ceil((bytes - MAX_ACCOUNT_PAYLOAD_PLAINTEXT_BYTES) / 1024);
  return `These account details are too large to save and sync (about ${overKb} KB over the limit). Please shorten the notes.`;
}

/**
 * Tax-detail completeness for the accounts list: `notApplicable` (no Roth or RMD
 * facts), `blocked` (an inherited account lacks a required fact, so its estimate
 * is withheld), `partial` (blank facts fall back to a cautious default), `complete`.
 */
export type TaxProfileCompleteness = 'notApplicable' | 'complete' | 'partial' | 'blocked';

/** Reads through `readTaxProfileDraft`, so a corrupt value counts as missing. */
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
  // Neither Roth basis total is listed: both engines derive it from balance history.
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
    // The two still-working questions are the only owner-account RMD facts that can be
    // genuinely unanswered: unanswered, the deferral is denied and the plan is treated
    // as distributing at the statutory age. An IRA never gets them, so nothing is unanswered there.
    required.push(draft.rmdFivePercentOwner, draft.rmdPlanRequiresDistributionAtStatutoryAge);
  }
  return required.some((value) => value === '') ? 'partial' : 'complete';
}
