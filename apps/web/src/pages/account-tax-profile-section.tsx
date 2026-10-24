/** Account "Tax details" editor section: the React surface over the pure readers, serializers and validators in lib/account-tax-profile.ts, which the exported report reuses without lib/ depending on the UI layer. */
import React, { useEffect, useId, useState } from 'react';
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components';
import type {
  AccountBalancePayload,
  AccountPayload,
  AccountTaxTreatment,
  AccountType,
  Aggregate,
} from '../db/types';
import {
  MAX_RMD_ISO_DATE,
  MIN_RMD_ISO_DATE,
  type RmdBeneficiaryElection,
  type RmdBeneficiaryType,
} from '../db/rmd-fact-validation';
import {
  EMPLOYER_PLAN_RMD_TYPES,
  rmdSaveBlockerMessages,
  rothIraFieldLabel,
  showsDesignatedRothFields,
  showsRmdFields,
  showsRothIraFields,
  type TaxProfileDraft,
} from '../lib/account-tax-profile';
import { Alert } from '../components/Alert';
import { Field } from '../components/Field';
import { Muted } from '../components/Muted';
import { Select } from '../components/Select';
import { DatePicker } from '../components/DatePicker';
import { TextInput } from '../components/TextInput';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { inputNumericClass } from './accounts-page-chrome';
import {
  resolveEffectiveRothStartYear,
  resolveRothStartYear,
  type ResolvedRothStartYear,
} from '../lib/roth-start-year';
import { isQualifyingAccount, spouseMoreThan10YearsYounger } from '../lib/rmd';

const BENEFICIARY_TYPE_OPTIONS: ReadonlyArray<{
  value: RmdBeneficiaryType;
  label: string;
}> = [
  { value: 'SPOUSE', label: 'Their spouse' },
  { value: 'MINOR_CHILD_OF_OWNER', label: 'Their child, still under 21' },
  {
    value: 'DISABLED_OR_CHRONICALLY_ILL',
    label: 'Disabled or chronically ill person',
  },
  {
    value: 'NOT_MORE_THAN_10_YEARS_YOUNGER',
    label: 'Person not more than 10 years younger',
  },
  { value: 'OTHER_DESIGNATED', label: 'Another named person' },
  { value: 'NON_PERSON', label: 'Estate, charity, or trust' },
];

const BENEFICIARY_ELECTION_OPTIONS: ReadonlyArray<{
  value: RmdBeneficiaryElection;
  label: string;
}> = [
  { value: 'LIFE_EXPECTANCY', label: 'Spread withdrawals over their lifetime' },
  { value: 'TEN_YEAR', label: 'Empty the account within ten years' },
];

const TRI_STATE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

export interface AccountTaxProfileSectionProps {
  readonly accountId: string;
  readonly type: AccountType | '';
  readonly taxTreatment: AccountTaxTreatment | '';
  readonly draft: TaxProfileDraft;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly accounts?: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly ownerId?: string;
  readonly hasSpouse: boolean;
  readonly ownerBirthdate?: string;
  readonly spouseBirthdate?: string;
  readonly hasValidationError?: boolean;
  readonly onChange: (next: TaxProfileDraft) => void;
}

function draftYear(value: string): number | undefined {
  const trimmed = value.trim();
  return /^\d{4}$/.test(trimmed) ? Number(trimmed) : undefined;
}

// On an inherited Roth IRA neither engine consults the five-year clock: every dollar comes out tax-free. The date field is still asked for and stored; only the sentences describing what the clock does are corrected.
function clockSummary(resolved: ResolvedRothStartYear, inherited = false): string {
  if (resolved.source === 'explicit') return `Roth start: ${resolved.year} recorded`;
  if (resolved.source === 'balance-history') return `Roth start: ${resolved.year} from balances`;
  if (resolved.source === 'roth-ira-pool') {
    return `Roth start: ${resolved.year} from your Roth IRA pool`;
  }
  return inherited
    ? 'Roth start: not recorded'
    : 'Roth start: no supporting history; five-year rule treated as unmet';
}

const RothYearEditor: React.FC<{
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly resolved: ResolvedRothStartYear;
  readonly inherited?: boolean;
  readonly onChange: (value: string) => void;
}> = ({ id, label, hint, value, resolved, inherited = false, onChange }) => {
  const [editing, setEditing] = useState(value.trim() !== '');
  if (editing || value.trim() !== '') {
    return (
      <Field htmlFor={id} label={label} hint={hint}>
        <TextInput
          id={id}
          inputMode="numeric"
          placeholder="e.g. 2015"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={inputNumericClass}
        />
        {value.trim() === '' && (
          <Muted as="p" className="mt-1 text-sm">{clockSummary(resolved, inherited)}</Muted>
        )}
      </Field>
    );
  }
  const action =
    resolved.source === 'balance-history' || resolved.source === 'roth-ira-pool'
      ? 'Enter a different year'
      : 'Enter a year';
  return (
    <Field htmlFor={`${id}-override`} label={label} hint={hint}>
      <p id={`${id}-derived-value`} className="m-0 text-sm font-medium text-ink">
        {resolved.source === 'balance-history'
          ? `${resolved.year} — inferred from balance history`
          : resolved.source === 'roth-ira-pool'
            ? `${resolved.year} — from another Roth IRA you own`
            : inherited
              ? 'No supporting balance history'
              : 'No supporting balance history — five-year rule treated as unmet'}
      </p>
      <Button
        id={`${id}-override`}
        aria-label={`${action} — ${label}`}
        aria-describedby={`${id}-derived-value ${id}-override-hint`}
        onPress={() => setEditing(true)}
        className="mt-1 text-sm font-medium text-link outline-none underline data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring"
      >
        {action}
      </Button>
    </Field>
  );
};

/** The "Advanced tax details" disclosure; renders nothing for types without Roth or required-withdrawal facts. */
export const AccountTaxProfileSection: React.FC<AccountTaxProfileSectionProps> = ({
  accountId,
  type,
  taxTreatment,
  draft,
  balances,
  accounts = [],
  ownerId = '',
  hasSpouse,
  ownerBirthdate,
  spouseBirthdate,
  hasValidationError = false,
  onChange,
}) => {
  const showRothIra = showsRothIraFields(type);
  const showDesignated = showsDesignatedRothFields(type, taxTreatment);
  const showRmd = showsRmdFields(type);
  const set = (patch: Partial<TaxProfileDraft>): void => onChange({ ...draft, ...patch });
  const blockers = rmdSaveBlockerMessages(draft, type, ownerBirthdate);
  const isEmployerPlan = type !== '' && EMPLOYER_PLAN_RMD_TYPES.has(type);
  const ownerRmdApplies =
    type !== '' && taxTreatment !== '' && isQualifyingAccount(type, taxTreatment);
  const soleSpouseEligible =
    hasSpouse && spouseMoreThan10YearsYounger(ownerBirthdate, spouseBirthdate) === true;
  const rothStartInput = {
    accountId,
    type,
    taxTreatment,
    explicitYear: draftYear(
      showRothIra
        ? draft.rothIraFirstContributionTaxYear
        : draft.designatedRothFirstParticipationTaxYear,
    ),
    balances,
  };
  const rothStart = showRothIra
    ? resolveEffectiveRothStartYear({
        ...rothStartInput,
        ownerId,
        inherited: draft.rmdInheritedAccount,
        accounts,
      })
    : resolveRothStartYear(rothStartInput);
  const actionRequired = blockers.length > 0 || hasValidationError;
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (actionRequired) setExpanded(true);
  }, [actionRequired]);
  const summaryId = useId();
  if (!showRothIra && !showDesignated && !showRmd) return null;
  // On an inherited Roth IRA the first-contribution year belongs to the original owner and never merges with the beneficiary's own Roth IRA, so the field must ask for that year; no copy here may characterise the clock, since every dollar is qualified.
  const inheritedRothIra = showRothIra && draft.rmdInheritedAccount;
  const summary = [
    ...(showRothIra || showDesignated ? [clockSummary(rothStart, inheritedRothIra)] : []),
    ...(showRmd
      ? draft.rmdInheritedAccount
        ? [blockers.length > 0 ? `${blockers.length} inherited details needed` : 'inherited rule ready']
        : !ownerRmdApplies
          ? ['no owner RMDs']
          : [
              draft.rmdSoleSpouseBeneficiary && soleSpouseEligible
                ? 'joint-life RMD table'
                : 'standard owner RMD rules',
            ]
      : []),
  ].join(' · ');

  return (
    <Disclosure
      isExpanded={expanded || blockers.length > 0}
      onExpandedChange={setExpanded}
      className="group mt-4 min-w-0 rounded-xl border border-line"
    >
      <Heading className="m-0">
        <Button
          slot="trigger"
          isDisabled={blockers.length > 0}
          aria-label="Advanced tax details"
          aria-describedby={summaryId}
          className="flex w-full items-center justify-between gap-2 rounded-xl px-4 py-3 text-left outline-none hover:bg-ink/5 data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring"
        >
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold text-ink">Advanced tax details</span>
            <span id={summaryId} className="truncate text-sm text-muted">{summary}</span>
          </span>
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            className="h-5 w-5 shrink-0 text-muted transition-transform group-data-[expanded]:rotate-180"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 7.5 10 12.5 15 7.5" />
          </svg>
        </Button>
      </Heading>
      <DisclosurePanel className="px-4 pb-4">
        <Muted as="p" className="mt-0 mb-3 text-sm">
          {inheritedRothIra ? (
            <>
              Optional, and only used for this account. Withdrawals from an inherited Roth IRA
              are assumed fully tax-free, so the start-year figure below does not change its
              projection.
            </>
          ) : (
            <>
              Optional, and only used for this account.{' '}
              {(showRothIra || showDesignated) && (
                <>
                  A blank Roth start year uses qualifying balance history when available;
                  otherwise the five-year rule is treated as unmet.{' '}
                </>
              )}
              These cautious defaults can overstate tax, never understate it.
            </>
          )}
        </Muted>

      {showRothIra && (
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <RothYearEditor
            id="rothIraFirstContributionTaxYear"
            label={rothIraFieldLabel('rothIraFirstContributionTaxYear', inheritedRothIra)}
            hint={
              inheritedRothIra
                ? 'Use the original owner’s year, not your own. Left blank, qualifying history for this inherited account supplies the earliest supported year.'
                : 'Starts the five-year clock that makes growth tax-free across the Roth IRAs you own. Left blank, qualifying history from that shared pool supplies the earliest supported year; with no evidence, the clock is treated as unmet.'
            }
            value={draft.rothIraFirstContributionTaxYear}
            resolved={rothStart}
            inherited={inheritedRothIra}
            onChange={(rothIraFirstContributionTaxYear) =>
              set({ rothIraFirstContributionTaxYear })
            }
          />
        </div>
      )}

      {showRothIra && !inheritedRothIra && (
        <Muted as="p" className="mt-3 text-sm">
          Money converted into this Roth IRA is recorded on this account’s yearly
          balances, on the row for the year each conversion happened — beside that
          year’s contributions and rollover. Each conversion year has its own
          five-year clock, which is why it is recorded year by year.
        </Muted>
      )}

      {showDesignated && (
        <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <RothYearEditor
            id="designatedRothFirstParticipationTaxYear"
            label="Year Roth contributions to this plan began"
            hint="If you rolled an older Roth plan into this one, use that plan's earlier start year."
            value={draft.designatedRothFirstParticipationTaxYear}
            resolved={rothStart}
            onChange={(designatedRothFirstParticipationTaxYear) =>
              set({ designatedRothFirstParticipationTaxYear })
            }
          />
        </div>
      )}

      {showDesignated && (
        <Muted as="p" className="mt-3 text-sm">
          Money moved from this plan’s pre-tax side into its Roth side is recorded
          on this account’s yearly balances, on the row for the year each move
          happened. Each year has its own five-year clock, which is why it is
          recorded year by year.
        </Muted>
      )}

      {showRmd && (
        <div className="mt-4 min-w-0">
          <ToggleSwitch
            id="rmdInheritedAccount"
            label="I inherited this account"
            checked={draft.rmdInheritedAccount}
            onChange={(rmdInheritedAccount) => set({ rmdInheritedAccount })}
          />
          <Muted as="p" className="mt-1 text-sm">
            Inherited accounts follow different withdrawal rules than accounts you opened yourself.
          </Muted>
        </div>
      )}

      {showRmd && !draft.rmdInheritedAccount && ownerRmdApplies && (
        <div className="mt-3 min-w-0">
          {isEmployerPlan && (
            <>
              <ToggleSwitch
                id="rmdCurrentEmployerPlan"
                label="This is my current employer's plan"
                checked={draft.rmdCurrentEmployerPlan}
                onChange={(rmdCurrentEmployerPlan) => set({ rmdCurrentEmployerPlan })}
              />
              <Muted as="p" className="mt-1 mb-3 text-sm">
                Still working for the employer can let you postpone required withdrawals from this
                plan — but only if the next two answers allow it. Left unanswered, the postponement
                is not applied.
              </Muted>
              {draft.rmdCurrentEmployerPlan && (
                <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 sm:items-end">
                  <Field
                    htmlFor="rmdFivePercentOwner"
                    label="Do I own more than 5% of this employer?"
                  >
                    <Select
                      id="rmdFivePercentOwner"
                      ariaLabel="Do I own more than 5% of this employer?"
                      placeholder="Not answered"
                      value={draft.rmdFivePercentOwner}
                      onChange={(rmdFivePercentOwner) => set({ rmdFivePercentOwner })}
                      options={[...TRI_STATE_OPTIONS]}
                    />
                  </Field>
                  <Field
                    htmlFor="rmdPlanRequiresDistributionAtStatutoryAge"
                    label="Does the plan require withdrawals at the statutory age anyway?"
                  >
                    <Select
                      id="rmdPlanRequiresDistributionAtStatutoryAge"
                      ariaLabel="Does the plan require withdrawals at the statutory age anyway?"
                      placeholder="Not answered"
                      value={draft.rmdPlanRequiresDistributionAtStatutoryAge}
                      onChange={(rmdPlanRequiresDistributionAtStatutoryAge) =>
                        set({ rmdPlanRequiresDistributionAtStatutoryAge })
                      }
                      options={[...TRI_STATE_OPTIONS]}
                    />
                  </Field>
                </div>
              )}
            </>
          )}
          <div className="mt-3 min-w-0">
            <ToggleSwitch
              id="rmdFirstYearDeferralElected"
              label="Postpone my first required withdrawal to April 1 of the next year"
              checked={draft.rmdFirstYearDeferralElected}
              onChange={(rmdFirstYearDeferralElected) => set({ rmdFirstYearDeferralElected })}
            />
            <Muted as="p" className="mt-1 text-sm">
              Allowed for the first year only. It means two required withdrawals land in the
              following year, which can raise that year's tax and Medicare premiums.
            </Muted>
          </div>
          {hasSpouse && (
            <div className="mt-3 min-w-0">
              <ToggleSwitch
                id="rmdSoleSpouseBeneficiary"
                label="My spouse is the only beneficiary of this account"
                checked={draft.rmdSoleSpouseBeneficiary && soleSpouseEligible}
                disabled={!soleSpouseEligible}
                ariaDescribedBy="rmdSoleSpouseBeneficiary-help"
                onChange={(rmdSoleSpouseBeneficiary) => set({ rmdSoleSpouseBeneficiary })}
              />
              <Muted id="rmdSoleSpouseBeneficiary-help" as="p" className="mt-1 text-sm">
                {soleSpouseEligible
                  ? 'Your household dates show your spouse is more than 10 years younger, so this can use the joint-life table.'
                  : ownerBirthdate && spouseBirthdate
                    ? 'The joint-life table is available only when your spouse is more than 10 years younger. Standard owner rules will be used.'
                    : 'Add both dates of birth in Household to use this option. Standard owner rules will be used.'}
              </Muted>
            </div>
          )}
        </div>
      )}

      {showRmd && draft.rmdInheritedAccount && (
        <div className="mt-3 min-w-0">
          {/* A field carrying a hint takes its own full-width row (sm:col-span-2) so it doesn't make its neighbour's control drop. */}
          <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <Field
              htmlFor="rmdBeneficiaryType"
              label="Your relationship to the original owner"
            >
              <Select
                id="rmdBeneficiaryType"
                ariaLabel="Your relationship to the original owner"
                placeholder="Select a relationship"
                value={draft.rmdBeneficiaryType}
                onChange={(rmdBeneficiaryType) => set({ rmdBeneficiaryType })}
                options={BENEFICIARY_TYPE_OPTIONS.map((o) => ({ ...o }))}
              />
            </Field>
            <Field htmlFor="rmdInheritedOwnerDeathDate" label="Original owner's date of death">
              <DatePicker
                id="rmdInheritedOwnerDeathDate"
                value={draft.rmdInheritedOwnerDeathDate}
                min={MIN_RMD_ISO_DATE}
                max={MAX_RMD_ISO_DATE}
                onChange={(rmdInheritedOwnerDeathDate) => set({ rmdInheritedOwnerDeathDate })}
              />
            </Field>
            <Field
              className="sm:col-span-2"
              htmlFor="rmdInheritedOwnerDiedOnOrAfterRbd"
              label="Had the original owner reached their RMD start date?"
              hint="Their RMD (required minimum distribution) start date is April 1 after the year they turned 73 or 75. Answer for the original owner, not whoever inherited the account."
            >
              <Select
                id="rmdInheritedOwnerDiedOnOrAfterRbd"
                ariaLabel="Had the original owner reached their RMD start date?"
                placeholder="Not answered"
                value={draft.rmdInheritedOwnerDiedOnOrAfterRbd}
                onChange={(rmdInheritedOwnerDiedOnOrAfterRbd) =>
                  set({ rmdInheritedOwnerDiedOnOrAfterRbd })
                }
                options={[...TRI_STATE_OPTIONS]}
              />
            </Field>
            <Field htmlFor="rmdOriginalOwnerBirthdate" label="Original owner's date of birth">
              <DatePicker
                id="rmdOriginalOwnerBirthdate"
                value={draft.rmdOriginalOwnerBirthdate}
                min={MIN_RMD_ISO_DATE}
                max={MAX_RMD_ISO_DATE}
                onChange={(rmdOriginalOwnerBirthdate) => set({ rmdOriginalOwnerBirthdate })}
              />
            </Field>
            {draft.rmdBeneficiaryType !== 'NON_PERSON' && (
              <Field
                htmlFor="rmdBeneficiaryElection"
                label="How withdrawals were chosen to be taken"
              >
                <Select
                  id="rmdBeneficiaryElection"
                  ariaLabel="How withdrawals were chosen to be taken"
                  placeholder="Not chosen"
                  value={draft.rmdBeneficiaryElection}
                  onChange={(rmdBeneficiaryElection) => set({ rmdBeneficiaryElection })}
                  options={BENEFICIARY_ELECTION_OPTIONS.map((o) => ({ ...o }))}
                />
              </Field>
            )}
          </div>
          {blockers.length > 0 && (
            <Alert tone="error">
              <p className="font-medium">
                This account cannot be saved while any of these inherited-account issues apply:
              </p>
              <ul className="mt-1 list-disc pl-5">
                {blockers.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </Alert>
          )}
        </div>
      )}
      </DisclosurePanel>
    </Disclosure>
  );
};
