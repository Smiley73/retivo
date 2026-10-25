/** Account create/edit modal; an edit-mode type change is refused when the account has balance history. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useConfirm } from '../components/ConfirmDialog';
import {
  useDirtyDiscardAction,
  useDirtyModalClose,
} from '../components/UnsavedChangesGuard';
import { useSync } from '../sync/SyncContext';
import {
  AccountRetypeBlockedError,
  AccountRetypeCheckFailedError,
  getAggregate,
  listAggregates,
  withBatchedStoreSignals,
} from '../db/store';
import { cryptoUuid } from '../lib/crypto-uuid';
import { accountIncomeReferenceLabels } from '../lib/account-income-links';
import { queueLocalMutation, queueGuardedAccountUpdate } from '../sync/mutation-queue';
import type {
  AccountBalancePayload,
  AccountOwnershipType,
  AccountPayload,
  AccountTaxTreatment,
  AccountType,
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  ScenarioPayload,
} from '../db/types';
import { defaultAssetMixForAccountType } from '../db/types';
import { Modal } from '../components/Modal';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { Alert } from '../components/Alert';
import { Field } from '../components/Field';
import { NotesField } from '../components/NotesField';
import { TextInput } from '../components/TextInput';
import { Select } from '../components/Select';
import { Muted } from '../components/Muted';
import { LoadingState } from '../components/Skeleton';
import { btnPrimaryClass, btnSecondaryClass } from '../components/dialog-chrome';
import { AssetMixFieldGroup, inputClass, inputNumericClass } from './accounts-page-chrome';
import { AccountTaxProfileSection } from './account-tax-profile-section';
import {
  EMPTY_TAX_PROFILE_DRAFT,
  readTaxProfileDraft,
  taxProfileToPayloadFields,
  taxProfileValidationError,
  accountPayloadSizeError,
  rmdSaveBlockerMessages,
  type TaxProfileDraft,
} from '../lib/account-tax-profile';
import { hasRetypeBlockingHistory } from '../lib/account-retype-block';
import { spouseMoreThan10YearsYounger } from '../lib/rmd';
import {
  ACCOUNT_TYPE_LABELS,
  INDIVIDUAL_ONLY_TYPES,
  TAX_TREATMENT_LABELS,
  TAX_TREATMENT_RULES,
} from '../api/types';

interface HouseholdMemberView {
  id: string;
  isPrimary: boolean;
  firstName: string;
  lastName: string;
  birthdate: string;
}

const JOINT_VALUE = '__joint__';

const ACCOUNT_TYPE_GROUP_DEFS: ReadonlyArray<{
  readonly label: string;
  readonly options: { value: AccountType; label: string }[];
}> = [
  {
    label: 'Traditional (pre-tax)',
    options: (
      [
        'RETIREMENT_401K',
        'RETIREMENT_IRA',
        'RETIREMENT_403B',
        'RETIREMENT_457B',
        'RETIREMENT_TSP',
        'RETIREMENT_CASH_BALANCE',
      ] as AccountType[]
    ).map((t) => ({ value: t, label: ACCOUNT_TYPE_LABELS[t] })),
  },
  {
    label: 'Roth',
    options: (
      [
        'RETIREMENT_ROTH_IRA',
        'RETIREMENT_ROTH_401K',
        'RETIREMENT_ROTH_403B',
        'RETIREMENT_ROTH_457B',
        'RETIREMENT_ROTH_TSP',
      ] as AccountType[]
    ).map((t) => ({ value: t, label: ACCOUNT_TYPE_LABELS[t] })),
  },
  {
    label: 'Other',
    options: (
      ['HSA', 'BROKERAGE', 'SAVINGS', 'MONEY_MARKET', 'CD', 'OTHER'] as AccountType[]
    ).map((t) => ({ value: t, label: ACCOUNT_TYPE_LABELS[t] })),
  },
];

// Does not promise the Roth-IRA contributions-first ordering: designated-Roth employer-plan money is taxed by a different rule before 59½.
const MIXED_TAX_TREATMENT_HINT =
  'Mixed means this account holds both pre-tax and post-tax money. In an ' +
  'employer plan (401(k)/403(b)/457(b)/TSP) the post-tax side is a ' +
  'Roth-designated slice — it grows and comes out tax-free. In a regular ' +
  'account the post-tax side is plain after-tax savings, so only your original ' +
  'contributions are tax-free and the growth is still taxed.';

const RETYPE_OPTION_BLOCKED_DESCRIPTION =
  'This account already has balance history — create a new account instead.';

const RETYPE_PICK_BLOCKED_MESSAGE =
  'This account already has balance history, so its type can’t be changed. ' +
  'Create a new account for the other type instead.';

const RETYPE_COULD_NOT_CHECK_MESSAGE =
  'Could not check this account’s balance history, so the type was not changed.';

const RETYPE_RETRY_CLEAR_MESSAGE =
  'Balance history check complete — no history found. You can choose a type again.';

function retypeSaveBlockedMessage(persistedTypeLabel: string): string {
  return (
    'This account already has balance history, so its type can’t be changed. ' +
    `Set the type back to ${persistedTypeLabel} to save your other changes, or ` +
    'create a new account for the other type.'
  );
}

const RETYPE_SAVE_COULD_NOT_CHECK_MESSAGE =
  'Could not check this account’s balance history, so nothing was saved. Please try again.';

const EMPTY_FORM = {
  institution: '',
  name: '',
  type: '' as AccountType | '',
  taxTreatment: '' as AccountTaxTreatment | '',
  ownerValue: '',
  notes: '',
  planningReturnPct: '',
  active: true,
  assetMixStocks: '70.0',
  assetMixBonds: '25.0',
  assetMixCash: '5.0',
};

interface AccountFormModalProps {
  /** The account to edit, or `null` to create a new one. */
  accountId: string | null;
  /** Live ledger rows used only for derived Advanced tax-detail assumptions. */
  balances?: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  /** Active accounts that can share an owner's Roth IRA clock. */
  accounts?: ReadonlyArray<Aggregate<AccountPayload>>;
  /** Called when the modal closes. `saved` is true after a successful save. */
  onClose: (saved: boolean) => void;
}

export const AccountFormModal: React.FC<AccountFormModalProps> = ({
  accountId,
  balances = [],
  accounts = [],
  onClose,
}) => {
  const isEdit = accountId !== null;
  const navigate = useNavigate();
  const { householdId } = useAuth();
  const { notifyPending } = useSync();
  const { confirm, dialog } = useConfirm();

  const [form, setForm] = useState(EMPTY_FORM);
  const [taxProfile, setTaxProfile] = useState<TaxProfileDraft>(EMPTY_TAX_PROFILE_DRAFT);
  const taxProfileBaselineRef = useRef<TaxProfileDraft>(EMPTY_TAX_PROFILE_DRAFT);
  const [members, setMembers] = useState<HouseholdMemberView[]>([]);
  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [originalTaxTreatment, setOriginalTaxTreatment] = useState<AccountTaxTreatment | ''>('');
  const [aggregateVersion, setAggregateVersion] = useState(0);
  const formBaselineRef = useRef<typeof EMPTY_FORM>(EMPTY_FORM);
  const [baselineReady, setBaselineReady] = useState(false);
  // Bumped when a save refusal re-seeds the baseline type: a ref write alone does not re-run the accountTypeGroups memo.
  const [baselineTypeRevision, setBaselineTypeRevision] = useState(0);
  // One-way latch: a later clear or could-not-check read never erases a known block (see applyRetypeVerdict).
  const [retypeVerdict, setRetypeVerdict] = useState<
    'clear' | 'blocked' | 'could-not-check' | null
  >(null);
  // Blocks Update while a differing pick's balance read is out; otherwise the old type would be saved with no error.
  const [pendingPick, setPendingPick] = useState<AccountType | null>(null);
  // Synchronous twin of pendingPick: a superseded read compares against the ref because the state write lands next render.
  const pendingPickRef = useRef<AccountType | null>(null);
  // A fresh object per announcement so a repeated blocked pick re-announces; screen readers skip identical text in the same node.
  const [retypeAnnouncement, setRetypeAnnouncement] = useState<{
    nonce: number;
    message: string;
    retryable: boolean;
  } | null>(null);
  // Retry removes its own button on every outcome, which would drop keyboard focus to <body>; focus the trigger instead.
  // Select forwards no ref, so this queries its button.
  const typeTriggerRef = useRef<HTMLDivElement>(null);
  // Guards setState after unmount from the pick-time read (a plain async function, not an effect).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applyRetypeVerdict = (next: 'clear' | 'blocked' | 'could-not-check'): void => {
    setRetypeVerdict((prev) => (prev === 'blocked' ? prev : next));
  };

  const announceRetype = (message: string, retryable: boolean): void => {
    setRetypeAnnouncement((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, message, retryable }));
  };

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const all = (await listAggregates('householdMember')) as Aggregate<HouseholdMemberPayload>[];
        if (!active) return;
        const view = all.map((a) => ({
          id: a.id,
          isPrimary: !!a.payload.isPrimary,
          firstName: a.payload.firstName ?? '',
          lastName: a.payload.lastName ?? '',
          birthdate: a.payload.birthdate ?? '',
        }));
        view.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
        setMembers(view);
        if (!isEdit) {
          const initial = { ...EMPTY_FORM, ownerValue: view[0]?.id ?? '' };
          setForm(initial);
          formBaselineRef.current = initial;
          setTaxProfile(EMPTY_TAX_PROFILE_DRAFT);
          taxProfileBaselineRef.current = EMPTY_TAX_PROFILE_DRAFT;
          setBaselineReady(true);
        }
      } catch {
        if (active) setError({ message: 'Failed to load household members' });
      }
    })();
    return () => {
      active = false;
    };
  }, [isEdit]);

  useEffect(() => {
    if (!isEdit || !accountId) return;
    let active = true;
    (async () => {
      try {
        const a = (await getAggregate('account', accountId)) as Aggregate<AccountPayload> | null;
        if (!active) return;
        if (!a) {
          setError({ message: 'Account not found' });
          return;
        }
        const isJoint = a.payload.ownershipType === 'JOINT';
        const existingMix =
          a.payload.assetMix ?? defaultAssetMixForAccountType(a.payload.type);
        const initial = {
          institution: a.payload.institution,
          name: a.payload.name,
          type: a.payload.type,
          taxTreatment: a.payload.taxTreatment,
          ownerValue: isJoint ? JOINT_VALUE : a.payload.ownerId,
          notes: a.payload.notes ?? '',
          planningReturnPct:
            typeof a.payload.planningReturnPct === 'number'
              ? a.payload.planningReturnPct.toFixed(1)
              : '',
          active: a.payload.active,
          assetMixStocks: existingMix.stocksPct.toFixed(1),
          assetMixBonds: existingMix.bondsPct.toFixed(1),
          assetMixCash: existingMix.cashPct.toFixed(1),
        };
        setForm(initial);
        formBaselineRef.current = initial;
        // Re-validate stored tax facts so a corrupt legacy or imported value renders blank instead of crashing or round-tripping.
        const initialTaxProfile = readTaxProfileDraft(a.payload);
        setTaxProfile(initialTaxProfile);
        taxProfileBaselineRef.current = initialTaxProfile;
        setBaselineReady(true);
        setOriginalTaxTreatment(a.payload.taxTreatment);
        setAggregateVersion(a.version);

        // Read the balance history before setLoading(false) so no option renders ahead of its verdict.
        try {
          const historyRows = (await listAggregates(
            'accountBalance',
          )) as Aggregate<AccountBalancePayload>[];
          if (!active) return;
          applyRetypeVerdict(
            hasRetypeBlockingHistory(accountId, historyRows) ? 'blocked' : 'clear',
          );
        } catch {
          if (!active) return;
          applyRetypeVerdict('could-not-check');
          announceRetype(RETYPE_COULD_NOT_CHECK_MESSAGE, true);
        }
      } catch {
        if (active) setError({ message: 'Failed to load account' });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // applyRetypeVerdict and announceRetype only call functional setState updaters, so they are omitted from the deps.
  }, [accountId, isEdit]);

  const accountTypeGroups = useMemo(() => {
    const persistedType = baselineReady ? formBaselineRef.current.type : '';
    return ACCOUNT_TYPE_GROUP_DEFS.map((group) => ({
      label: group.label,
      options: group.options.map((opt) => {
        const isPersisted = isEdit && opt.value === persistedType;
        const blocked = isEdit && !isPersisted && retypeVerdict === 'blocked';
        return {
          value: opt.value,
          label: opt.label,
          unavailable: blocked,
          description: blocked ? RETYPE_OPTION_BLOCKED_DESCRIPTION : undefined,
        };
      }),
    }));
  }, [baselineReady, retypeVerdict, isEdit, baselineTypeRevision]);

  const isFormDirty = useMemo(() => {
    if (!baselineReady) return false;
    const b = formBaselineRef.current;
    return (
      form.institution !== b.institution ||
      form.name !== b.name ||
      form.type !== b.type ||
      form.taxTreatment !== b.taxTreatment ||
      form.ownerValue !== b.ownerValue ||
      form.notes !== b.notes ||
      form.planningReturnPct !== b.planningReturnPct ||
      form.active !== b.active ||
      form.assetMixStocks !== b.assetMixStocks ||
      form.assetMixBonds !== b.assetMixBonds ||
      form.assetMixCash !== b.assetMixCash ||
      JSON.stringify(taxProfile) !== JSON.stringify(taxProfileBaselineRef.current)
    );
  }, [baselineReady, form, taxProfile]);

  const mixSum = useMemo(() => {
    const s = parseFloat(form.assetMixStocks || '0');
    const b = parseFloat(form.assetMixBonds || '0');
    const c = parseFloat(form.assetMixCash || '0');
    return (Number.isFinite(s) ? s : 0) + (Number.isFinite(b) ? b : 0) + (Number.isFinite(c) ? c : 0);
  }, [form.assetMixStocks, form.assetMixBonds, form.assetMixCash]);
  const isMixValid = Math.abs(mixSum - 100) <= 0.05;
  const isCbp = form.type === 'RETIREMENT_CASH_BALANCE';
  const selectedOwnerId =
    form.ownerValue === JOINT_VALUE
      ? members.find((member) => member.isPrimary)?.id ?? ''
      : form.ownerValue;
  const ownerMember = members.find((member) => member.id === selectedOwnerId);
  const spouseMember = members.find((member) => member.id !== selectedOwnerId);
  const soleSpouseEligible =
    spouseMoreThan10YearsYounger(ownerMember?.birthdate, spouseMember?.birthdate) === true;
  const inheritedBlockers = rmdSaveBlockerMessages(
    taxProfile,
    form.type,
    ownerMember?.birthdate,
  );
  const currentTaxValidationError = taxProfileValidationError(
    taxProfile,
    form.type,
    form.taxTreatment,
  );

  const { guardedClose, immediateClose, confirmModal } = useDirtyModalClose(
    isFormDirty,
    () => onClose(false),
  );
  const { runGuarded, confirmModal: discardConfirmModal } =
    useDirtyDiscardAction(isFormDirty);

  const applyTypeChange = (newType: AccountType): void => {
    const allowed = TAX_TREATMENT_RULES[newType];
    const defaultTreatment = allowed[0];
    const isIndividualOnly = INDIVIDUAL_ONLY_TYPES.includes(newType);
    setForm((f) => {
      const next = {
        ...f,
        type: newType,
        taxTreatment: defaultTreatment,
        ownerValue:
          isIndividualOnly && f.ownerValue === JOINT_VALUE
            ? members.find((m) => m.isPrimary)?.id ?? ''
            : f.ownerValue,
      };
      if (!isEdit) {
        const def = defaultAssetMixForAccountType(newType);
        next.assetMixStocks = def.stocksPct.toFixed(1);
        next.assetMixBonds = def.bondsPct.toFixed(1);
        next.assetMixCash = def.cashPct.toFixed(1);
      }
      return next;
    });
  };

  // Equal-to-persisted picks apply without a read; a differing pick re-reads balances first (another tab may have landed history).
  // pendingPickRef supersedes a stale read.
  const handleTypeChange = (newType: AccountType): void => {
    const persistedType = formBaselineRef.current.type;
    if (!isEdit || accountId === null || newType === persistedType) {
      pendingPickRef.current = null;
      setPendingPick(null);
      setRetypeAnnouncement(null);
      applyTypeChange(newType);
      return;
    }
    const runAccountId = accountId;
    pendingPickRef.current = newType;
    setPendingPick(newType);
    (async () => {
      let outcome: 'clear' | 'blocked' | 'could-not-check';
      try {
        const historyRows = (await listAggregates(
          'accountBalance',
        )) as Aggregate<AccountBalancePayload>[];
        outcome = hasRetypeBlockingHistory(runAccountId, historyRows) ? 'blocked' : 'clear';
      } catch {
        outcome = 'could-not-check';
      }
      if (!mountedRef.current || pendingPickRef.current !== newType) return;
      pendingPickRef.current = null;
      setPendingPick(null);
      if (outcome === 'blocked') {
        applyRetypeVerdict('blocked');
        announceRetype(RETYPE_PICK_BLOCKED_MESSAGE, false);
        return;
      }
      if (outcome === 'could-not-check') {
        applyRetypeVerdict('could-not-check');
        announceRetype(RETYPE_COULD_NOT_CHECK_MESSAGE, true);
        return;
      }
      applyRetypeVerdict('clear');
      setRetypeAnnouncement(null);
      applyTypeChange(newType);
    })();
  };

  // Retry does not re-apply the abandoned pick; every outcome replaces the message and moves focus to the type trigger.
  const retryRetypeCheck = (): void => {
    if (accountId === null) return;
    const runAccountId = accountId;
    (async () => {
      let outcome: 'clear' | 'blocked' | 'could-not-check';
      try {
        const historyRows = (await listAggregates(
          'accountBalance',
        )) as Aggregate<AccountBalancePayload>[];
        outcome = hasRetypeBlockingHistory(runAccountId, historyRows) ? 'blocked' : 'clear';
      } catch {
        outcome = 'could-not-check';
      }
      if (!mountedRef.current) return;
      applyRetypeVerdict(outcome);
      typeTriggerRef.current?.querySelector('button')?.focus();
      if (outcome === 'blocked') {
        announceRetype(RETYPE_PICK_BLOCKED_MESSAGE, false);
      } else if (outcome === 'could-not-check') {
        announceRetype(RETYPE_COULD_NOT_CHECK_MESSAGE, true);
      } else {
        announceRetype(RETYPE_RETRY_CLEAR_MESSAGE, false);
      }
    })();
  };

  const onSave = async (): Promise<void> => {
    if (pendingPickRef.current !== null) return;
    if (
      !form.type ||
      !form.institution ||
      !form.name ||
      !form.ownerValue ||
      !form.taxTreatment ||
      !form.planningReturnPct
    )
      return;
    if (!householdId) return;
    if (inheritedBlockers.length > 0) {
      setError({ message: 'Complete the required inherited-account details before saving.' });
      return;
    }

    if (isEdit && accountId) {
      const balances = (await listAggregates('accountBalance')) as Aggregate<AccountBalancePayload>[];
      const forThis = balances.filter((b) => b.payload.accountId === accountId);

      // The disable guards gate only the active true→false transition, so editing an already-inactive account is not blocked.
      const disabling = formBaselineRef.current.active === true && !form.active;
      if (disabling) {
        // ACCOUNT_INCOME_LINKED: an account an income stream pays from or deposits into cannot be disabled; checked before ACCOUNT_NOT_ZEROED.
        const [income, scenarioRows] = await Promise.all([
          listAggregates('incomeStream') as Promise<Aggregate<IncomeStreamPayload>[]>,
          listAggregates('scenario') as Promise<Aggregate<ScenarioPayload>[]>,
        ]);
        if (accountIncomeReferenceLabels(accountId, income, scenarioRows).length > 0) {
          setError({
            message:
              'Cannot disable an account that an income source is paid from or deposits into. Re-point or remove the income source first.',
            code: 'ACCOUNT_INCOME_LINKED',
          });
          return;
        }

        const latest = forThis.reduce<Aggregate<AccountBalancePayload> | null>((acc, b) => {
          if (!acc || b.payload.year > acc.payload.year) return b;
          return acc;
        }, null);
        if (latest && latest.payload.endingBalance !== 0) {
          setError({
            message:
              'Cannot inactivate an account whose latest balance is non-zero. Add a final entry that zeroes it out first.',
            code: 'ACCOUNT_NOT_ZEROED',
          });
          return;
        }
      }

      if (originalTaxTreatment && form.taxTreatment !== originalTaxTreatment) {
        const involvesMixed =
          originalTaxTreatment === 'MIXED' || form.taxTreatment === 'MIXED';
        if (involvesMixed && forThis.length > 0) {
          const ok =
            form.taxTreatment === 'MIXED'
              ? await confirm(
                  'Switch to Mixed tax treatment?',
                  `Existing balance entries will be allocated to the ${TAX_TREATMENT_LABELS[originalTaxTreatment]} columns; the other side starts at $0. You can re-allocate per year afterwards.`,
                  { confirmLabel: 'Yes, switch', cancelLabel: 'Cancel' },
                )
              : await confirm(
                  `Switch to ${TAX_TREATMENT_LABELS[form.taxTreatment]}?`,
                  'Existing balance entries will lose their separate Pre-Tax / Post-Tax breakdown. The totals will be preserved, but the split is permanently discarded.',
                  { confirmLabel: 'Yes, switch', cancelLabel: 'Cancel' },
                );
          if (!ok) return;
        }
      }
    }

    // Refuse unreadable tax-detail amounts: the serializer would omit them and the engines read an omission as a cautious default.
    const taxDetailError = currentTaxValidationError;
    if (taxDetailError !== null) {
      setError({ message: taxDetailError });
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const isJoint = form.ownerValue === JOINT_VALUE;
      const ownerId = isJoint
        ? members.find((m) => m.isPrimary)?.id ?? ''
        : form.ownerValue;
      const payload: AccountPayload = {
        institution: form.institution,
        name: form.name,
        type: form.type,
        ownershipType: isJoint ? 'JOINT' : ('INDIVIDUAL' as AccountOwnershipType),
        taxTreatment: form.taxTreatment,
        ownerId,
        notes: form.notes ?? '',
        planningReturnPct: parseFloat(form.planningReturnPct),
        active: form.active,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix:
          form.type === 'RETIREMENT_CASH_BALANCE'
            ? defaultAssetMixForAccountType(form.type)
            : {
                stocksPct: parseFloat(form.assetMixStocks),
                bondsPct: parseFloat(form.assetMixBonds),
                cashPct: parseFloat(form.assetMixCash),
              },
        // Blank facts are omitted (absent, not zero) so the engines apply their conservative default.
        ...taxProfileToPayloadFields(
          taxProfile,
          form.type,
          form.taxTreatment,
          soleSpouseEligible,
        ),
      };
      // Refuse a payload over the 64 KB sync cap; it would be permanently unsyncable with no explanation.
      const sizeError = accountPayloadSizeError(payload);
      if (sizeError !== null) {
        setError({ message: sizeError });
        setSubmitting(false);
        return;
      }
      if (isEdit && accountId) {
        // Read the account fresh inside the transaction; a differing type reads its balance rows and refuses the write on history.
        const targetAccountId = accountId;
        const submittedType = form.type;
        try {
          await queueGuardedAccountUpdate({
            householdId,
            aggregateId: targetAccountId,
            expectedVersion: aggregateVersion,
            // assetMix is in the form, so the form's value must win over the persisted one.
            buildPayload: (freshAccount) => ({
              ...payload,
              plannedContributionPreTax:
                freshAccount.payload.plannedContributionPreTax ?? 0,
              plannedContributionPostTax:
                freshAccount.payload.plannedContributionPostTax ?? 0,
            }),
            guard: {
              needsHistoryRead: (freshAccount) => freshAccount.payload.type !== submittedType,
              allow: (freshAccount, balances) => {
                if (freshAccount.payload.type === submittedType) return true;
                return balances !== undefined && !hasRetypeBlockingHistory(targetAccountId, balances);
              },
            },
          });
        } catch (err) {
          if (err instanceof AccountRetypeBlockedError) {
            applyRetypeVerdict('blocked');
            // Re-seed the baseline type from the fresh persisted type: another device can retype the account under an open editor.
            formBaselineRef.current = {
              ...formBaselineRef.current,
              type: err.persistedType,
            };
            setBaselineTypeRevision((n) => n + 1);
            setError({
              message: retypeSaveBlockedMessage(
                ACCOUNT_TYPE_LABELS[err.persistedType],
              ),
            });
            setSubmitting(false);
            return;
          }
          if (err instanceof AccountRetypeCheckFailedError) {
            applyRetypeVerdict('could-not-check');
            setError({ message: RETYPE_SAVE_COULD_NOT_CHECK_MESSAGE });
            setSubmitting(false);
            return;
          }
          throw err;
        }
      } else {
        // The seed id is deterministic so a later real balance updates it; the $0 seed is excluded from return math (isReturnBearingRow).
        const newAccountId = cryptoUuid();
        const todayYear = new Date().getUTCFullYear();
        const isMixed = form.taxTreatment === 'MIXED';
        const seedPayload: AccountBalancePayload = {
          accountId: newAccountId,
          year: todayYear,
          lastUpdated: new Date().toISOString(),
          startingBalance: 0,
          startingBalancePreTax: isMixed ? 0 : null,
          startingBalancePostTax: isMixed ? 0 : null,
          contributionsPreTax: isMixed ? 0 : null,
          contributionsPostTax: isMixed ? 0 : null,
          companyContributions: 0,
          companyContributionsPreTax: isMixed ? 0 : null,
          companyContributionsPostTax: isMixed ? 0 : null,
          rollover: 0,
          distributions: 0,
          endingBalance: 0,
          endingBalancePreTax: isMixed ? 0 : null,
          endingBalancePostTax: isMixed ? 0 : null,
          totalContributions: 0,
          comment: null,
        };

        // withBatchedStoreSignals only coalesces local reactive signals and takes effect only when `batch` is threaded into each queueLocalMutation.
        // Push order comes from queueing the account first. A seed-pair failure after the account write leaves a benign account with no balance.
        let accountWritten = false;
        try {
          await withBatchedStoreSignals(async (batch) => {
            await queueLocalMutation<AccountPayload>(
              {
                type: 'account',
                aggregateId: newAccountId,
                householdId,
                operation: 'create',
                expectedVersion: 0,
                payload,
              },
              batch,
            );
            accountWritten = true;
            await queueLocalMutation<AccountBalancePayload>(
              {
                type: 'accountBalance',
                aggregateId: `bal-${newAccountId}-${todayYear}`,
                householdId,
                operation: 'create',
                expectedVersion: 0,
                payload: seedPayload,
              },
              batch,
            );
          });
        } catch (err) {
          if (accountWritten) {
            notifyPending();
            setError({
              message:
                'Account created — add a balance to see it in your projections.',
            });
            return;
          }
          throw err;
        }
        notifyPending();
        onClose(true);
        return;
      }
      notifyPending();
      onClose(true);
    } catch {
      setError({ message: 'Failed to save account' });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Modal open onClose={() => onClose(false)} title="Edit Account" size="3xl">
        <LoadingState label="Loading account…" variant="form" />
      </Modal>
    );
  }

  const allowedTreatments = form.type ? TAX_TREATMENT_RULES[form.type] : [];
  const isTaxTreatmentLocked = allowedTreatments.length === 1;
  const isIndividualOnly = form.type ? INDIVIDUAL_ONLY_TYPES.includes(form.type) : false;

  const saveDisabled =
    submitting ||
    pendingPick !== null ||
    !form.name ||
    !form.type ||
    !form.institution ||
    !form.ownerValue ||
    !form.taxTreatment ||
    !form.planningReturnPct ||
    (!isCbp && !isMixValid) ||
    inheritedBlockers.length > 0;

  return (
    <Modal
      open
      onClose={guardedClose}
      title={isEdit ? 'Edit Account' : 'Add Account'}
      size="4xl"
      scrollBodyLabel="Account details form"
    >
      <Muted as="p" className="mt-0 mb-4 text-sm">
        {isEdit
          ? 'Update your account details.'
          : 'Configure a new retirement or savings account.'}
      </Muted>

      {error && (
        <Alert tone="error">
          {error.message}
          {error.code === 'ACCOUNT_NOT_ZEROED' && isEdit && accountId && (
            <>
              {' '}
              <Link
                to={`/accounts/${accountId}/balances`}
                className="font-medium underline"
                onClick={(e) => {
                  e.preventDefault();
                  runGuarded(() => navigate(`/accounts/${accountId}/balances`));
                }}
              >
                Open the balance entries for this account
              </Link>{' '}
              to add a final entry that zeroes it out.
            </>
          )}
          {error.code === 'ACCOUNT_INCOME_LINKED' && (
            <>
              {' '}
              <Link
                to="/income"
                className="font-medium underline"
                onClick={(e) => {
                  e.preventDefault();
                  runGuarded(() => navigate('/income'));
                }}
              >
                Go to Income
              </Link>{' '}
              to re-point or remove the income source.
            </>
          )}
        </Alert>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
        noValidate
      >
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <Field htmlFor="name" label="Account name">
            <TextInput
              id="name"
              required
              placeholder="e.g. My 401(k)"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={inputClass}
            />
          </Field>

          <Field htmlFor="institution" label="Institution">
            <TextInput
              id="institution"
              required
              placeholder="e.g. Vanguard, Fidelity"
              value={form.institution}
              onChange={(e) => setForm({ ...form, institution: e.target.value })}
              className={inputClass}
            />
          </Field>

          <Field
            htmlFor="type"
            label="Account type"
            hint={
              form.type !== '' &&
              (form.type === 'RETIREMENT_ROTH_401K' ||
                form.type === 'RETIREMENT_ROTH_403B' ||
                form.type === 'RETIREMENT_ROTH_457B' ||
                form.type === 'RETIREMENT_ROTH_TSP')
                ? "Designated-Roth employer plan — contributions are after-tax. Withdrawing the growth before age 59½ is modeled as taxable, with a 10% penalty except for 457(b). The separate 5-year Roth rule isn't modeled, so a withdrawal in the first few years after opening may be shown as tax-free when it really wouldn't be."
                : undefined
            }
          >
            <div ref={typeTriggerRef}>
              <Select
                id="type"
                ariaLabel="Account type"
                placeholder="Select a type"
                value={form.type}
                onChange={(v) => handleTypeChange(v as AccountType)}
                groups={accountTypeGroups}
              />
            </div>
            {/* role="status" is mounted unconditionally and empty when idle (screen readers skip a region that arrives populated); only the inner node is keyed on nonce so repeats re-announce. */}
            <p role="status" className="mt-1 text-xs text-negative">
              {retypeAnnouncement && (
                <span key={retypeAnnouncement.nonce}>
                  {retypeAnnouncement.message}
                  {retypeAnnouncement.retryable && (
                    <>
                      {' '}
                      <button
                        type="button"
                        className="font-medium underline"
                        onClick={retryRetypeCheck}
                      >
                        Try again
                      </button>
                    </>
                  )}
                </span>
              )}
            </p>
          </Field>

          <Field
            htmlFor="ownerValue"
            label="Owner"
            hint={
              isIndividualOnly
                ? 'This account type cannot be jointly owned.'
                : undefined
            }
          >
            <Select
              id="ownerValue"
              ariaLabel="Owner"
              placeholder="Select an owner"
              value={form.ownerValue}
              onChange={(v) => setForm({ ...form, ownerValue: v })}
              options={[
                ...members.map((m) => ({
                  value: m.id,
                  label: m.isPrimary ? `${m.firstName} (you)` : m.firstName,
                })),
                ...(!isIndividualOnly
                  ? [{ value: JOINT_VALUE, label: 'Joint Ownership' }]
                  : []),
              ]}
            />
          </Field>

          <Field
            htmlFor="taxTreatment"
            label="Tax treatment"
            hint={
              isTaxTreatmentLocked
                ? `Locked to ${TAX_TREATMENT_LABELS[allowedTreatments[0]]} for this account type.`
                : form.taxTreatment === 'MIXED'
                  ? MIXED_TAX_TREATMENT_HINT
                  : undefined
            }
          >
            <Select
              id="taxTreatment"
              ariaLabel="Tax treatment"
              disabled={isTaxTreatmentLocked}
              value={form.taxTreatment}
              onChange={(v) =>
                setForm({ ...form, taxTreatment: v as AccountTaxTreatment })
              }
              options={allowedTreatments.map((tt) => ({
                value: tt,
                label: TAX_TREATMENT_LABELS[tt],
              }))}
            />
          </Field>

          <Field
            htmlFor="planningReturnPct"
            label="Planning Return %"
            hint="Expected annual return used for planning calculations."
          >
            <TextInput
              id="planningReturnPct"
              required
              inputMode="decimal"
              pattern="[0-9]*[.,]?[0-9]*"
              placeholder="e.g. 7.5"
              value={form.planningReturnPct}
              onChange={(e) => setForm({ ...form, planningReturnPct: e.target.value })}
              className={inputNumericClass}
              onBlur={() => {
                // Skip empty so required-field validation can still fire.
                const trimmed = form.planningReturnPct.trim();
                if (trimmed === '') return;
                const n = parseFloat(trimmed.replace(',', '.'));
                if (Number.isFinite(n)) {
                  setForm({ ...form, planningReturnPct: n.toFixed(1) });
                }
              }}
            />
          </Field>
        </div>

        {!isCbp && (
          <AssetMixFieldGroup
            values={{
              assetMixStocks: form.assetMixStocks,
              assetMixBonds: form.assetMixBonds,
              assetMixCash: form.assetMixCash,
            }}
            onFieldChange={(key, raw) => setForm({ ...form, [key]: raw })}
            onFieldBlur={(key) => {
              const n = parseFloat((form[key] || '0').replace(',', '.'));
              if (Number.isFinite(n)) {
                setForm({ ...form, [key]: n.toFixed(1) });
              }
            }}
            mixSum={mixSum}
            isMixValid={isMixValid}
          />
        )}

        {isCbp && (
          <Muted as="p" className="my-2 text-sm">
            Cash Balance Pension accounts use the configured expected return
            deterministically; they don't have a market-based asset allocation.
          </Muted>
        )}

        <AccountTaxProfileSection
          accountId={accountId ?? '__new-account__'}
          type={form.type}
          taxTreatment={form.taxTreatment}
          draft={taxProfile}
          balances={balances}
          accounts={form.active ? accounts : []}
          ownerId={selectedOwnerId}
          hasSpouse={spouseMember !== undefined}
          ownerBirthdate={ownerMember?.birthdate || undefined}
          spouseBirthdate={spouseMember?.birthdate || undefined}
          hasValidationError={currentTaxValidationError !== null}
          onChange={setTaxProfile}
        />

        <NotesField
          id="notes"
          label="Notes"
          rows={4}
          placeholder="Optional notes about this account…"
          value={form.notes}
          onChange={(v) => setForm({ ...form, notes: v })}
        />

        <div className="mb-3 min-w-0">
          <ToggleSwitch
            id="active"
            label="Active"
            checked={form.active}
            onChange={(next) => setForm({ ...form, active: next })}
          />
          <Muted as="p" className="mt-1 text-sm">
            Inactive accounts are still visible in the balances table (muted) but are not editable
            from there. Their data continues to count toward portfolio totals.
          </Muted>
        </div>

        <div className="mt-4 flex justify-start gap-2">
          <button
            type="submit"
            className={btnPrimaryClass}
            disabled={saveDisabled}
          >
            {submitting ? 'Saving…' : isEdit ? 'Update' : 'Create'}
          </button>
          <button
            type="button"
            className={btnSecondaryClass}
            onClick={immediateClose}
            disabled={submitting}
          >
            Cancel
          </button>
        </div>
      </form>
      {confirmModal}
      {discardConfirmModal}
      {dialog}
    </Modal>
  );
};
