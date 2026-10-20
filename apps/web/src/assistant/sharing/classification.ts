/**
 * The field model: how every stored field becomes something a tool may say.
 *
 * This is an allowlist, not a denylist. `lib/diagnostics/redact.ts` explains why
 * a key denylist fails open for this app, and it applies with more force here:
 * every aggregate envelope carries `householdId` and `deviceId`, a household
 * member's payload carries `email` and `lastName` beside the fields the agent
 * needs, and the household's `name` is commonly the family surname. So the view
 * is built field by field from the maps below. A field that has no entry is not
 * emitted, and each map is typed `satisfies Record<KnownKeys<Payload>, ...>`
 * (the `SCENARIO_SETTING_COVERAGE` pattern in `lib/report-scenario-settings.ts`),
 * so a payload field added later fails `pnpm typecheck` until someone classifies it.
 * Nested shapes (anchors, overrides) are built with `shape<T>()`, which holds
 * them to the same rule for the interfaces they describe.
 *
 * What a classification means:
 *  - `never`    the field is not shared in any setting.
 *  - `plain`    an enum, flag, percentage, year, age or count; a string must be one enum-like token.
 *  - `dollars`  a dollar figure; rounded to the nearest $1,000 unless exact figures are on.
 *  - `label`    a name; governed by its category's switch, sanitized, 60 characters.
 *  - `text`     a note or description; governed by the notes switch, sanitized, 500 characters.
 *  - `id`       an opaque reference to another aggregate.
 *  - `date`     a calendar date or timestamp, validated.
 *  - `firstName` shown as the member's first name, or a role label when first names are off.
 *  - `gated`    a subtree that also needs another category's switch (embedded rows).
 */
import type {
  AccountBalancePayload,
  AccountPayload,
  AssetMix,
  CustomDrawdownOrder,
  DiscretionaryGlideOverride,
  DiscretionarySpendingOverride,
  DownturnGuardrailsOverride,
  ExpenseCategoryPayload,
  ExpensePayload,
  ExpensesOverride,
  GlideAnchor,
  HealthCoverageMonthsOverride,
  HouseholdMemberPayload,
  HouseholdPayload,
  IncomeOverride,
  IncomeStreamPayload,
  InflationOverride,
  LifeExpectancyOverride,
  MagiCapDisabled,
  MagiCapOverride,
  MagiCapWindow,
  MemberCoverageMonths,
  QcdEntry,
  RetirementAgeOverride,
  RetirementAgePerMember,
  RetirementAllocationOverride,
  ScenarioOverrides,
  ScenarioPayload,
  ScheduleEnd,
  ScheduleStart,
  SocialSecurityBenefitPayload,
  SocialSecurityOverride,
  WithdrawalStrategy,
} from '../../db/types';
import type { FilingPlanTaxUnit, FilingStatusWindow, TaxFilingPlan } from '../../lib/filing-status';
import type { SharingCategoryId } from './switches';

export type Classification =
  | { readonly kind: 'never'; readonly reason: string }
  | { readonly kind: 'plain' | 'dollars' | 'label' | 'text' | 'id' | 'date' | 'firstName' }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, Classification>> }
  | { readonly kind: 'array'; readonly item: Classification }
  | { readonly kind: 'record'; readonly keys: 'id' | 'year'; readonly value: Classification }
  | { readonly kind: 'gated'; readonly category: SharingCategoryId; readonly shape: Classification };

/** The declared keys of `T`, without the index signature the payload interfaces inherit from `Record<string, unknown>`. */
export type KnownKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : symbol extends K ? never : K]: T[K];
};

/** Every key of any member of a union (a discriminated union's `keyof` is only the shared ones). */
type AllKeys<T> = T extends unknown ? keyof T : never;

const never = (reason: string): Classification => ({ kind: 'never', reason });
const PLAIN: Classification = { kind: 'plain' };
const DOLLARS: Classification = { kind: 'dollars' };
const LABEL: Classification = { kind: 'label' };
const TEXT: Classification = { kind: 'text' };
const ID: Classification = { kind: 'id' };
const DATE: Classification = { kind: 'date' };
const FIRST_NAME: Classification = { kind: 'firstName' };

/** A nested object, held to the keys of `T` (every key of every member when `T` is a union). */
function shape<T>(fields: { [K in AllKeys<T>]-?: Classification }): Classification {
  return { kind: 'object', fields };
}
const list = (item: Classification): Classification => ({ kind: 'array', item });
const byId = (value: Classification): Classification => ({ kind: 'record', keys: 'id', value });
const byYear = (value: Classification): Classification => ({ kind: 'record', keys: 'year', value });
const gated = (category: SharingCategoryId, inner: Classification): Classification => ({ kind: 'gated', category, shape: inner });

// ---------- Household ----------

/** The household aggregate is not exposed at all; its name is commonly the family surname. */
export const HOUSEHOLD_CLASSIFICATION = {
  name: never('the household name is commonly the family surname'),
  currency: never('the household aggregate is not exposed'),
  createdAt: never('the household aggregate is not exposed'),
} satisfies Record<KnownKeys<HouseholdPayload>, Classification>;

export const MEMBER_CLASSIFICATION = {
  isPrimary: PLAIN,
  firstName: FIRST_NAME,
  lastName: never('last names are never shared'),
  email: never('email addresses are never shared'),
  birthdate: DATE,
} satisfies Record<KnownKeys<HouseholdMemberPayload>, Classification>;

// ---------- Schedules (shared by expenses, income and overrides) ----------

const SCHEDULE_START = shape<ScheduleStart>({ kind: PLAIN, memberId: PLAIN, years: PLAIN, months: PLAIN, year: PLAIN });
const SCHEDULE_END = shape<ScheduleEnd>({
  kind: PLAIN,
  memberId: PLAIN,
  years: PLAIN,
  months: PLAIN,
  year: PLAIN,
  whose: PLAIN,
  offsetYears: PLAIN,
});
const GLIDE_ANCHOR = shape<GlideAnchor>({ kind: PLAIN, memberId: PLAIN, years: PLAIN, months: PLAIN, year: PLAIN });
const DISCRETIONARY_GLIDE = shape<DiscretionaryGlideOverride>({
  endMultiplierPct: PLAIN,
  glideStart: GLIDE_ANCHOR,
  glideEnd: GLIDE_ANCHOR,
  floor: shape<NonNullable<DiscretionaryGlideOverride['floor']>>({ multiplierPct: PLAIN, anchor: GLIDE_ANCHOR }),
});

// ---------- Accounts ----------

const ASSET_MIX = shape<AssetMix>({ stocksPct: PLAIN, bondsPct: PLAIN, cashPct: PLAIN });

export const ACCOUNT_CLASSIFICATION = {
  name: LABEL,
  type: PLAIN,
  ownershipType: PLAIN,
  taxTreatment: PLAIN,
  ownerId: ID,
  institution: LABEL,
  notes: TEXT,
  planningReturnPct: PLAIN,
  active: PLAIN,
  plannedContributionPreTax: DOLLARS,
  plannedContributionPostTax: DOLLARS,
  contributionGrowthPct: PLAIN,
  assetMix: ASSET_MIX,
  rothIraFirstContributionTaxYear: PLAIN,
  designatedRothFirstParticipationTaxYear: PLAIN,
  rmdInheritedAccount: PLAIN,
  rmdCurrentEmployerPlan: PLAIN,
  rmdFivePercentOwner: PLAIN,
  rmdPlanRequiresDistributionAtStatutoryAge: PLAIN,
  rmdFirstYearDeferralElected: PLAIN,
  rmdSoleSpouseBeneficiary: PLAIN,
  rmdSpouseBeneficiaryBirthdate: DATE,
  rmdBeneficiaryType: PLAIN,
  rmdInheritedOwnerDeathDate: DATE,
  rmdInheritedOwnerDiedOnOrAfterRbd: PLAIN,
  rmdOriginalOwnerBirthdate: DATE,
  rmdBeneficiaryBirthdate: DATE,
  rmdBeneficiaryElection: PLAIN,
} satisfies Record<KnownKeys<AccountPayload>, Classification>;

export const BALANCE_CLASSIFICATION = {
  accountId: ID,
  year: PLAIN,
  lastUpdated: DATE,
  startingBalance: DOLLARS,
  startingBalancePreTax: DOLLARS,
  startingBalancePostTax: DOLLARS,
  contributionsPreTax: DOLLARS,
  contributionsPostTax: DOLLARS,
  companyContributions: DOLLARS,
  companyContributionsPreTax: DOLLARS,
  companyContributionsPostTax: DOLLARS,
  rollover: DOLLARS,
  distributions: DOLLARS,
  endingBalance: DOLLARS,
  endingBalancePreTax: DOLLARS,
  endingBalancePostTax: DOLLARS,
  totalContributions: DOLLARS,
  comment: TEXT,
  rothConversionTaxableAmount: DOLLARS,
  rothConversionNontaxableAmount: DOLLARS,
  rothInPlanRolloverTaxableAmount: DOLLARS,
  rothInPlanRolloverNontaxableAmount: DOLLARS,
} satisfies Record<KnownKeys<AccountBalancePayload>, Classification>;

// ---------- Expenses, income, Social Security ----------

export const EXPENSE_CATEGORY_CLASSIFICATION = {
  name: LABEL,
  isMedical: PLAIN,
} satisfies Record<KnownKeys<ExpenseCategoryPayload>, Classification>;

export const EXPENSE_CLASSIFICATION = {
  name: LABEL,
  description: TEXT,
  amount: DOLLARS,
  frequency: PLAIN,
  classification: PLAIN,
  categoryId: ID,
  start: SCHEDULE_START,
  end: SCHEDULE_END,
  discretionaryGlide: DISCRETIONARY_GLIDE,
  hsaQualified: PLAIN,
} satisfies Record<KnownKeys<ExpensePayload>, Classification>;

export const INCOME_CLASSIFICATION = {
  name: LABEL,
  notes: TEXT,
  memberId: ID,
  kind: PLAIN,
  start: SCHEDULE_START,
  end: SCHEDULE_END,
  payoutType: PLAIN,
  monthlyBenefit: DOLLARS,
  lumpSumAmount: DOLLARS,
  jointAndSurvivorPct: PLAIN,
  linkedCbpAccountId: ID,
  targetAccountId: ID,
  annualAmount: DOLLARS,
  oneOffAmount: DOLLARS,
  source: PLAIN,
  colaPct: PLAIN,
  tracksInflation: PLAIN,
  taxable: PLAIN,
} satisfies Record<KnownKeys<IncomeStreamPayload>, Classification>;

export const SOCIAL_SECURITY_CLASSIFICATION = {
  householdMemberId: ID,
  pia: DOLLARS,
  piaAsOfDate: DATE,
  notes: TEXT,
} satisfies Record<KnownKeys<SocialSecurityBenefitPayload>, Classification>;

// ---------- Scenario overrides ----------

const AGE_PER_MEMBER = shape<RetirementAgePerMember>({ ageYears: PLAIN, ageMonths: PLAIN });

type PerAccount<K extends keyof ScenarioOverrides> = NonNullable<ScenarioOverrides[K]> extends { perAccount: Record<string, infer V> }
  ? V
  : never;

const ROW_ID = ID;
const EXPENSE_ROW = shape<ExpensePayload & { _localId: string }>({ ...EXPENSE_CLASSIFICATION, _localId: ROW_ID });
const INCOME_ROW = shape<IncomeStreamPayload & { _localId: string }>({ ...INCOME_CLASSIFICATION, _localId: ROW_ID });
const EXPENSE_PATCH = shape<ExpensePayload>(EXPENSE_CLASSIFICATION);
const INCOME_PATCH = shape<IncomeStreamPayload>(INCOME_CLASSIFICATION);

/**
 * The scenario's overrides. Rows embedded in `expenses.added` and `income.added` follow their own
 * category's switch as well as the scenarios switch, and so do the per-account sections.
 */
const OVERRIDES_CLASSIFICATION = {
  retirementAge: shape<RetirementAgeOverride>({ primary: AGE_PER_MEMBER, secondary: AGE_PER_MEMBER, sameDateAnchor: PLAIN }),
  socialSecurity: gated(
    'socialSecurity',
    shape<SocialSecurityOverride>({
      primary: AGE_PER_MEMBER,
      secondary: AGE_PER_MEMBER,
      survivor: shape<NonNullable<SocialSecurityOverride['survivor']>>({ primary: AGE_PER_MEMBER, secondary: AGE_PER_MEMBER }),
      benefitReductionPct: PLAIN,
      colaPct: PLAIN,
      colaTracksInflation: PLAIN,
    }),
  ),
  filingStatus: PLAIN,
  taxFilingPlan: shape<TaxFilingPlan>({
    kind: PLAIN,
    statusWindows: list(shape<FilingStatusWindow>({ status: PLAIN, start: SCHEDULE_START, end: SCHEDULE_END })),
    units: list(shape<FilingPlanTaxUnit>({ memberId: PLAIN, filingStatus: PLAIN, householdSize: PLAIN })),
    livedTogether: PLAIN,
  }),
  contributions: shape<{ stopContributionsToday: boolean }>({ stopContributionsToday: PLAIN }),
  lifeExpectancy: shape<LifeExpectancyOverride>({ primary: PLAIN, secondary: PLAIN }),
  inflation: shape<InflationOverride>({ ratePct: PLAIN, categoryRates: byId(PLAIN) }),
  discretionarySpending: shape<DiscretionarySpendingOverride>({ bumpPct: PLAIN, durationYears: PLAIN }),
  downturnGuardrails: shape<DownturnGuardrailsOverride>({
    enabled: PLAIN,
    lowerBandPct: PLAIN,
    upperBandPct: PLAIN,
    stepPct: PLAIN,
    maxRaisePct: PLAIN,
    discretionaryFloorPct: PLAIN,
  }),
  expenses: gated(
    'expenses',
    shape<ExpensesOverride>({
      disabledIds: list(ID),
      added: list(EXPENSE_ROW),
      patches: byId(EXPENSE_PATCH),
      reEnabledIds: list(ID),
    }),
  ),
  income: gated(
    'income',
    shape<IncomeOverride>({
      disabledIds: list(ID),
      added: list(INCOME_ROW),
      patches: byId(INCOME_PATCH),
      reEnabledIds: list(ID),
    }),
  ),
  withdrawalStrategy: shape<WithdrawalStrategy>({ kind: PLAIN }),
  customDrawdownOrder: shape<CustomDrawdownOrder>({ tiers: list(list(ID)), excludedAccountIds: list(ID) }),
  magiCap: shape<MagiCapOverride | MagiCapDisabled>({
    windows: list(
      shape<MagiCapWindow>({
        start: SCHEDULE_START,
        end: SCHEDULE_END,
        magiCeilingAnnualDollars: DOLLARS,
        capMode: PLAIN,
        capMagiLine: PLAIN,
        targetRothAccountId: ID,
      }),
    ),
    disabled: PLAIN,
  }),
  retirementAllocation: shape<RetirementAllocationOverride>({
    growthRatePct: PLAIN,
    incomeRatePct: PLAIN,
    startGrowthPct: PLAIN,
    endGrowthPct: PLAIN,
    endYear: PLAIN,
    glideStartYear: PLAIN,
    incomeOnlyYear: PLAIN,
  }),
  assumedCostBasisFractionOfTaxableWithdrawal: PLAIN,
  magiBootstrapLookbackMinus2: DOLLARS,
  magiBootstrapLookbackMinus1: DOLLARS,
  acaPtcBenchmark: list(
    shape<NonNullable<ScenarioOverrides['acaPtcBenchmark']>[number]>({ taxYear: PLAIN, annualSlcspDollars: DOLLARS }),
  ),
  accountContributions: gated(
    'accounts',
    shape<NonNullable<ScenarioOverrides['accountContributions']>>({
      perAccount: byId(
        shape<PerAccount<'accountContributions'>>({
          plannedContributionPreTax: DOLLARS,
          plannedContributionPostTax: DOLLARS,
          contributionGrowthPct: PLAIN,
        }),
      ),
    }),
  ),
  accountReturns: gated(
    'accounts',
    shape<NonNullable<ScenarioOverrides['accountReturns']>>({
      perAccount: byId(shape<PerAccount<'accountReturns'>>({ planningReturnPct: PLAIN })),
    }),
  ),
  accountAssetMix: gated(
    'accounts',
    shape<NonNullable<ScenarioOverrides['accountAssetMix']>>({ perAccount: byId(ASSET_MIX) }),
  ),
  accountFloors: gated(
    'accounts',
    shape<NonNullable<ScenarioOverrides['accountFloors']>>({
      perAccount: byId(shape<PerAccount<'accountFloors'>>({ floorDollars: DOLLARS, hsaMode: PLAIN })),
    }),
  ),
  hsaQualifiedMedicalExpensePct: PLAIN,
  earlyWithdrawalPenaltyExemptAccountIds: gated('accounts', list(ID)),
  acaMarketplaceOptOutMemberIds: list(ID),
  healthCoverageMonths: shape<HealthCoverageMonthsOverride>({
    perMember: byId(
      byYear(shape<MemberCoverageMonths>({ partBMonths: PLAIN, partDMonths: PLAIN, marketplaceMonths: PLAIN })),
    ),
  }),
  acaFplRegion: PLAIN,
  preRetirementRothConversions: list(
    shape<NonNullable<ScenarioOverrides['preRetirementRothConversions']>[number]>({
      sourceAccountId: ID,
      targetRothAccountId: ID,
      annualAmountDollars: DOLLARS,
      start: SCHEDULE_START,
      end: SCHEDULE_END,
    }),
  ),
  preRetirementRothConversionTaxRatePct: PLAIN,
  preRetirementTaxableIncomeDollars: DOLLARS,
  qualifiedCharitableDistributions: list(
    shape<QcdEntry>({ memberId: ID, sourceAccountId: ID, annualAmountDollars: DOLLARS, start: SCHEDULE_START, end: SCHEDULE_END }),
  ),
} satisfies Record<keyof ScenarioOverrides, Classification>;

export const SCENARIO_CLASSIFICATION = {
  name: LABEL,
  description: TEXT,
  parentScenarioId: ID,
  isPrimary: PLAIN,
  notes: TEXT,
  overrides: shape<ScenarioOverrides>(OVERRIDES_CLASSIFICATION),
} satisfies Record<KnownKeys<ScenarioPayload>, Classification>;
