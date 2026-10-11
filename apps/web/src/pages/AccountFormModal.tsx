/**
 * Account create/edit form, rendered as a modal.
 *
 * Reads household + (for edit mode) the account aggregate from
 * IndexedDB. Create submits via `queueLocalMutation`; an edit-mode save
 * submits via `queueGuardedAccountUpdate`, one
 * IndexedDB transaction that writes the account and queues its mutation
 * together and refuses the write outright when the submitted type differs
 * from the persisted one and the account has real balance history. The
 * "switching to/from MIXED clobbers the pre/post-tax split" warning
 * consults the local `accountBalance` store; client-side validation also
 * enforces the `ACCOUNT_NOT_ZEROED` rule (you can't inactivate while the
 * latest balance is non-zero).
 *
 * Field order: institution (required), name, type, tax treatment, owner.
 * Tax-treatment dropdown is filtered by account type and locks when only
 * one option is legal. The owner dropdown lists every household member
 * plus a "Joint Ownership" option (suppressed for individual-only types).
 * The type picker itself is edit-mode-only balance-history-gated
 * (see the handlers and
 * state below); an account with real history refuses every option but its
 * own persisted type, reachable and selectable by keyboard the whole time.
 *
 * Lives inside the shared `<Modal>` (React Aria — viewport-centered,
 * focus trap, Esc/scrim). The parent (AccountsPage) mounts this only
 * while open, so all the load effects + form state reset cleanly per
 * open. Unsaved edits are guarded via `useDirtyModalClose` (X / Esc /
 * scrim) and `useDirtyDiscardAction` (the error-recovery deep links).
 */
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

/**
 * Groups for the account-type picker. The
 * `{ value, label }` shape only — the per-option
 * `description`/`unavailable` additions are layered on per-render by the
 * `accountTypeGroups` memo below, keyed on the persisted type and the
 * retype-block verdict, neither of which this module-level list can see.
 */
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

/**
 * Help text shown under the Tax treatment field when "Mixed" is selected.
 * Explains the post-tax sub-bucket distinction in plain English: in an
 * employer plan (401k/403b/457b/TSP) the post-tax money is a Roth-designated
 * slice that grows and comes out tax-free, whereas in a regular account the
 * post-tax money is plain after-tax savings whose growth is still taxed. It
 * deliberately does NOT promise the early-withdrawal contributions-first
 * ordering that applies to Roth IRAs only — designated-Roth employer-plan
 * money is taxed by a different (deferred / approximated) rule before 59½.
 */
const MIXED_TAX_TREATMENT_HINT =
  'Mixed means this account holds both pre-tax and post-tax money. In an ' +
  'employer plan (401(k)/403(b)/457(b)/TSP) the post-tax side is a ' +
  'Roth-designated slice — it grows and comes out tax-free. In a regular ' +
  'account the post-tax side is plain after-tax savings, so only your original ' +
  'contributions are tax-free and the growth is still taxed.';

/**
 * Copy for the account-type picker's retype blocking.
 */

/** The `Select` option's own accessible description when its type is blocked
 *  by real balance history — never rendered on the persisted option. */
const RETYPE_OPTION_BLOCKED_DESCRIPTION =
  'This account already has balance history — create a new account instead.';

/** Live-region copy for a pick refused because the account has real
 *  history — whether the option already showed as blocked, or the pick's own
 *  read is what turned the history up. */
const RETYPE_PICK_BLOCKED_MESSAGE =
  'This account already has balance history, so its type can’t be changed. ' +
  'Create a new account for the other type instead.';

/** Live-region copy shared by an open-time and a pick-time read failure —
 *  one verdict, one copy. Claims nothing
 *  about whether the account has history; offers a retry. */
const RETYPE_COULD_NOT_CHECK_MESSAGE =
  'Could not check this account’s balance history, so the type was not changed.';

/** Live-region copy for a Try-again retry that comes back clear — replaces
 *  the could-not-check message rather than silently clearing the region, so
 *  the person who pressed Try again gets some confirmation the check ran. */
const RETYPE_RETRY_CLEAR_MESSAGE =
  'Balance history check complete — no history found. You can choose a type again.';

/** Save-time refusal, blocked — the editor's existing `error` Alert slot. */
function retypeSaveBlockedMessage(persistedTypeLabel: string): string {
  return (
    'This account already has balance history, so its type can’t be changed. ' +
    `Set the type back to ${persistedTypeLabel} to save your other changes, or ` +
    'create a new account for the other type.'
  );
}

/** Save-time refusal, could not check — distinct from the pick-time copy so
 *  pressing Update is never silently nothing. */
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
  // The account's Roth / required-withdrawal tax facts, held as a separate
  // all-strings draft so a partially-typed value never becomes a stored number.
  const [taxProfile, setTaxProfile] = useState<TaxProfileDraft>(EMPTY_TAX_PROFILE_DRAFT);
  const taxProfileBaselineRef = useRef<TaxProfileDraft>(EMPTY_TAX_PROFILE_DRAFT);
  const [members, setMembers] = useState<HouseholdMemberView[]>([]);
  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [originalTaxTreatment, setOriginalTaxTreatment] = useState<AccountTaxTreatment | ''>('');
  const [aggregateVersion, setAggregateVersion] = useState(0);
  // Snapshot of the form taken once it's hydrated. See "Form controls"
  // in docs/ui-conventions.md.
  const formBaselineRef = useRef<typeof EMPTY_FORM>(EMPTY_FORM);
  const [baselineReady, setBaselineReady] = useState(false);
  // Bumped whenever a save refusal re-seeds `formBaselineRef.current.type`
  // with the account's fresh persisted type (see the `AccountRetypeBlockedError`
  // catch below). A ref mutation alone doesn't re-render, and even a render
  // triggered by some OTHER state write doesn't re-run a `useMemo` whose own
  // dependencies didn't change — `accountTypeGroups` needs its own signal that
  // the value it reads out of the ref has moved, not just that the component
  // rendered again.
  const [baselineTypeRevision, setBaselineTypeRevision] = useState(0);
  // The editor's one latched verdict over
  // this account's balance history: absent until the open-time read resolves
  // (the loading gate covers that window), then replaced by any LATER read
  // that finds a block the earlier one missed (pick-time or save-time). The
  // latch is one-way toward 'blocked': a later clear/could-not-check read
  // never erases a block already known. See `applyRetypeVerdict`.
  const [retypeVerdict, setRetypeVerdict] = useState<
    'clear' | 'blocked' | 'could-not-check' | null
  >(null);
  // The type <Select>'s pick that a differing-type pick's balance read is
  // still out for — `null` once nothing is in flight. Blocks Update
  // (`saveDisabled`) and the Enter-in-a-text-field submit path: without
  // it a person could pick, press Update before the read resolves, and have
  // the OLD type written while the modal closes with no error at all.
  const [pendingPick, setPendingPick] = useState<AccountType | null>(null);
  // The same value, readable synchronously inside an in-flight read's
  // continuation. A pick is superseded the moment the user picks again, but
  // the state write that says so only lands on the next render — this ref is
  // what a resolving read compares itself to (the supersession check).
  const pendingPickRef = useRef<AccountType | null>(null);
  // The polite live-region announcement beside
  // the type field. A fresh object (not just new text) on every announcement,
  // including a REPEAT of the same blocked option, because many screen
  // readers do not re-announce identical text written into the same node;
  // the render below keys the region's node on `nonce` so React remounts it.
  const [retypeAnnouncement, setRetypeAnnouncement] = useState<{
    nonce: number;
    message: string;
    retryable: boolean;
  } | null>(null);
  // Wraps just the type `<Select>` (never the live region) so a retry's
  // resolution can hand focus back to the trigger — the retry `<button>` it
  // was pressed on is itself removed from the DOM on every outcome (a fresh
  // `retypeAnnouncement` node), which would otherwise drop a keyboard/
  // screen-reader user to `<body>` with no notice. `Select` forwards no
  // ref of its own, so this queries
  // the one `<button>` it renders — safe only because the query runs after
  // the retry control (the region's OWN `<button>`, outside this wrapper)
  // is already gone.
  const typeTriggerRef = useRef<HTMLDivElement>(null);
  // Guards a stray setState after unmount from an in-flight retype read (an
  // effect gets this from its cleanup's `active` flag; the
  // pick-time read below is a plain async function, not an effect).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Move `retypeVerdict` toward `next`, never away from an established
   * `'blocked'` (one-way latch — "a failed read must never erase a
   * block already known", precedence blocked > could-not-check > clear).
   * Every other transition fully replaces the verdict, including
   * could-not-check → clear, which is what a successful retry relies on.
   */
  const applyRetypeVerdict = (next: 'clear' | 'blocked' | 'could-not-check'): void => {
    setRetypeVerdict((prev) => (prev === 'blocked' ? prev : next));
  };

  /** Replace the live-region announcement with a fresh node. */
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
        // Every stored tax fact is re-validated on the way in, so a legacy or
        // hand-imported payload with an out-of-shape value renders blank instead of
        // crashing the editor or round-tripping the corrupt value back to storage.
        const initialTaxProfile = readTaxProfileDraft(a.payload);
        setTaxProfile(initialTaxProfile);
        taxProfileBaselineRef.current = initialTaxProfile;
        setBaselineReady(true);
        setOriginalTaxTreatment(a.payload.taxTreatment);
        setAggregateVersion(a.version);

        // The open-time balance read, resolved
        // BEFORE `setLoading(false)` lifts the gate that replaces the whole
        // form with `LoadingState`: no option may render ahead of its
        // verdict. Kept separate from the account read above — only
        // THIS read's failure is could-not-check; a failed account read
        // stays today's "Failed to load account".
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
    // `applyRetypeVerdict` / `announceRetype` are stable-enough setState
    // wrappers (functional updaters only) — omitted, like every other such
    // helper this component reads inside an effect without listing.
  }, [accountId, isEdit]);

  // Per-render (memoised) type-picker
  // groups: each differing option carries `Select`'s unavailable treatment +
  // its own accessible description ONLY while this account is known
  // `'blocked'` (the three-verdict copy owns 'could-not-check' — the
  // options themselves stay ordinary while it's merely unknown). The
  // persisted option is marked on neither. Depends on `baselineReady` and
  // `retypeVerdict`, never `formBaselineRef` alone — a ref does not
  // re-render (see the field declarations above) — and also on
  // `baselineTypeRevision`, so a save refusal that corrects the ref's `type`
  // to the account's fresh persisted type (while `retypeVerdict` was already
  // `'blocked'` and so wouldn't itself change) still forces this memo to
  // re-read it, instead of continuing to mark options against the stale
  // open-time type.
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
      // The tax-facts draft is part of the dirty state, so the unsaved-changes
      // guard also protects a tax-detail edit from being discarded silently.
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

  // X / Esc / scrim prompt when dirty; explicit Cancel uses immediateClose.
  const { guardedClose, immediateClose, confirmModal } = useDirtyModalClose(
    isFormDirty,
    () => onClose(false),
  );
  // The error-recovery deep links navigate to another page, which would
  // discard the draft — route them through the same Stay/Leave prompt.
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
      // For new accounts, re-suggest assetMix from the new type's
      // default. For edit, leave the user's existing mix alone (a type
      // change does not overwrite an already-set mix).
      if (!isEdit) {
        const def = defaultAssetMixForAccountType(newType);
        next.assetMixStocks = def.stocksPct.toFixed(1);
        next.assetMixBonds = def.bondsPct.toFixed(1);
        next.assetMixCash = def.cashPct.toFixed(1);
      }
      return next;
    });
  };

  /**
   * The type `<Select>`'s onChange.
   * `Select` forwards every selection unconditionally; this editor alone
   * applies or refuses one.
   *
   * A pick equal to the PERSISTED type (never the live draft — flipping away
   * and back grants nothing) applies immediately with no read: it is the one
   * option never blocked, and re-picking it is the exit from a state where a
   * sync pull landed history after the person had already picked another
   * type. Create mode takes no read at all.
   *
   * A differing pick in edit mode runs a fresh balance read before anything
   * reaches the draft — closing the same-device window the open-time read
   * leaves open (another tab landing a qualifying row with no cross-tab
   * signal). The read is superseded the moment the user picks again:
   * `pendingPickRef` is the synchronous truth an in-flight run compares
   * itself against, because the state write that supersedes it only lands on
   * the next render.
   */
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
      // Superseded: the user picked again while this read was out. Applies
      // and refuses nothing — the later pick's own read is authoritative.
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

  /**
   * The retry — re-runs the pick-time-shaped read for whatever type the
   * type `<Select>` is CURRENTLY on, and replaces the verdict with what it
   * finds. Deliberately does NOT re-apply the abandoned pick: the person
   * picks again once the account is known clear.
   *
   * Every outcome replaces the message rather than silently clearing it —
   * pressing Try again and hearing nothing back is its own dead end — and
   * every outcome also removes the retry `<button>` the person just
   * activated (a fresh `retypeAnnouncement` node), so focus moves to the
   * type trigger rather than falling to `<body>`.
   */
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
    // A differing pick's balance read can
    // still be out; until it settles, `form.type` still holds the value the
    // editor is already accepting, so a submit slipping through here would
    // queue the WRONG type and close the modal with no error at all. The
    // disabled Update button covers the click path; this guard covers every
    // other submit path (Enter in a text field). The ref, not the state, is
    // the synchronous truth (see pendingPickRef).
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

      // The disable guards (ACCOUNT_INCOME_LINKED, ACCOUNT_NOT_ZEROED)
      // gate the active true→false *transition* only — saving an account
      // that was already inactive (e.g. editing its notes) must not be
      // blocked. `formBaselineRef.current.active` is the hydrated
      // baseline; `!form.active` alone over-blocks every save of an
      // already-inactive account.
      const disabling = formBaselineRef.current.active === true && !form.active;
      if (disabling) {
        // ACCOUNT_INCOME_LINKED — an account an income stream is paid
        // from (linkedCbpAccountId) or deposits into (targetAccountId)
        // cannot be disabled; it would orphan the stream. Structural
        // scan over canonical + scenario-embedded income.
        // Checked before ACCOUNT_NOT_ZEROED so the more
        // feature-relevant /income remediation surfaces first when an
        // account is both non-zero and income-linked.
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

        // ACCOUNT_NOT_ZEROED — surface as a remediable error with a deep link.
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

      // Tax-treatment switch confirm (only when balances exist + MIXED is involved).
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

    // Refuse a save whose tax-detail amount / year cannot be read, BEFORE the
    // serializer silently omits it. An omitted fact reads to the engines as
    // "nothing recorded" and quietly earns a cautious default, so a user who typed
    // `20,000` in a dollar field would otherwise be told nothing while the figure
    // vanished (or, pre-fix, was stored as $20).
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
        // Only facts the chosen account TYPE can carry are emitted, so
        // changing an account's type never leaves orphan Roth or inherited-account
        // facts behind, and a blank field is OMITTED (absent, not zero) so the
        // engines apply their conservative default rather than a recorded $0.
        ...taxProfileToPayloadFields(
          taxProfile,
          form.type,
          form.taxTreatment,
          soleSpouseEligible,
        ),
      };
      // Refuse a save the sync push could never accept. The tax-details
      // editor can hold up to 200 conversion lots + 200 rollover lots alongside a
      // free-text notes field, which together can exceed the 64 KB per-payload sync
      // cap — a locally-valid save that would then be permanently unsyncable with
      // no explanation. Checked here, BEFORE any local write.
      const sizeError = accountPayloadSizeError(payload);
      if (sizeError !== null) {
        setError({ message: sizeError });
        setSubmitting(false);
        return;
      }
      if (isEdit && accountId) {
        // One transactional write, opened
        // AFTER the confirms above: the account row is read FRESH inside the
        // transaction (never the snapshot captured at open) and compared
        // against the submitted type; a differing type reads that account's
        // balance rows in the same transaction and refuses the write outright
        // when they qualify as history. An equal type
        // takes no balance read at all — renaming an account with years of
        // history is untouched.
        const targetAccountId = accountId;
        const submittedType = form.type;
        try {
          await queueGuardedAccountUpdate({
            householdId,
            aggregateId: targetAccountId,
            expectedVersion: aggregateVersion,
            // Carry forward fields the edit-form doesn't surface (planned
            // contributions) from the FRESH persisted row; `assetMix` IS in
            // the form and the user-entered values must win — pre-fix this
            // overwrote the form's edit with the existing value, silently
            // dropping every asset-mix change.
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
            // The transaction refused against its FRESH persisted type, not
            // `formBaselineRef`'s open-time snapshot — another device can
            // retype this account out from under an open editor (the
            // accepted cross-device window). Re-seed the baseline's type
            // with it so the picker's own guard and option marking (both
            // keyed on `formBaselineRef.current.type`) track what the
            // transaction actually saw: the message below names it, the
            // now-unavailable options re-mark around it, and re-picking it
            // is the in-modal recovery — the exit `handleTypeChange`
            // already grants a pick equal to the persisted type, now that
            // the persisted type is current instead of stale.
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
        // New account: auto-seed a current-year $0 balance so the account is
        // "Shape 1" everywhere — it projects, renders, and is a valid
        // Roth-conversion target with no hand-entered balance. The seed
        // id is DETERMINISTIC (`bal-${accountId}-${year}`, the same id
        // AccountBalancesPage derives), so a later real current-year balance
        // save looks the seed up and UPDATES it (no duplicate). The seed
        // payload mirrors the balances form's empty shape exactly: all numeric
        // fields 0, splits `0` for MIXED / `null` otherwise. The $0 seed
        // is excluded from time-weighted-return math on every surface
        // (`isReturnBearingRow`, balance-calc.ts) so it never fabricates a
        // return.
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

        // Two distinct mechanisms, NOT conflated:
        // (a) `withBatchedStoreSignals` coalesces the local reactive-read
        //     signals only — it has NO push-ordering or transaction semantics,
        //     and it only takes effect when `batch` is threaded into each
        //     `queueLocalMutation` (forwarded to `putAggregate`). A bare wrap
        //     that ignores `batch` would be inert.
        // (b) The parent-before-dependent PUSH order comes from the sequential
        //     queue → monotonic timestamp: the account is queued first ⟹ lower
        //     timestamp ⟹ pushed first.
        //
        // Enumerate the failure points (no silent swallow):
        //   - account-pair half-write (the account's own `putAggregate` then
        //     `queueMutation`): nothing persisted ⟹ total failure.
        //   - seed-pair half-write AFTER the account write succeeded: the
        //     account exists, the seed does not. This is the only reachable
        //     partial failure for a fresh-UUID create (the dangerous
        //     balance-without-account is unreachable — the account create uses
        //     a fresh id with `expectedVersion: 0`, so it cannot CONFLICT). It
        //     is benign: it equals a new account with no balance yet (renders
        //     on planned rate, unprojected) and the
        //     deterministic seed id means a later real balance re-seeds cleanly.
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
            // Partial success: the account is saved, the $0 seed is not. Do
            // NOT show the generic total-failure message or close with a
            // failure — the account was created and a later balance entry
            // re-seeds it. Surface the benign partial-success guidance.
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
    // A differing pick's balance read is still out — saving now would submit
    // whatever value the editor is currently accepting, dropping the pick
    // still in flight. See the guard at the top of onSave.
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
        {/* 2-col `form-grid`: Account name | Institution, Type | Owner,
            Tax treatment | Planning Return %. */}
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
            {/* Polite live region beside the
                field (never through the `hint` prop above, which nothing
                associates with the control, and never in its place). The
                `role="status"` element is mounted UNCONDITIONALLY, empty
                when idle: inserting a live region and its text in the same
                commit is the case screen readers handle least reliably — a
                region that arrives already populated is commonly skipped
                (NVDA/JAWS announce mutations inside a region that was
                already present). Only the inner node is keyed on `nonce`,
                so a screen reader that already registered the outer region
                still hears every replacement, including a REPEAT of the
                same blocked pick — many screen readers do not re-announce
                identical text written into the same node. */}
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
                // Normalize to one decimal place so the field never shows
                // "7" and "7.0" interchangeably across the app. Skip when
                // empty so required-field validation can still fire.
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

        {/* Left-aligned, primary action first — AGENTS modal rule. The
            primary is `type="submit"` so Enter inside a text field still
            submits the form. */}
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
