/**
 * Pure (non-React) logic for `IncomeFormPage`: draft/payload conversion,
 * deposit-target eligibility, the scenario-patch delta algebra, and the
 * retirement-facts resolver. Extracted from the page
 * so the page file holds JSX/state only.
 *
 * NOTE: `ExpenseFormPage` has structurally parallel `*ScenarioPatchDelta` /
 * `compute*ScenarioPatchSave` helpers in `expense-form-logic.ts`. They are
 * NOT unified here — they operate on different override fields
 * (income-only rollover/windfall/kind keys vs expense-only glide/
 * hsaQualified keys) and a forced shared abstraction would be premature.
 */
import { jsonEq } from '../lib/json-eq';
import { buildScenarioIncomePatchWrite } from '../lib/scenario-income-patch';
import { parseDecimal } from '../lib/parse-input';
import { resolveScenario, type ScenarioAggregate } from '../lib/scenario-resolution';
import { resolveMemberRetirementDates } from '../lib/retirement-date-math';
import {
  type FormDraft,
  defaultStartFor,
  defaultEndForPartTime,
  validateStart,
  validateEnd,
} from '../lib/income-form-draft';
import type {
  Aggregate,
  AccountPayload,
  AccountTaxTreatment,
  AccountType,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  LifeExpectancyOverride,
  PatchWithClears,
  ScenarioPayload,
} from '../db/types';

export function draftFromPayload(p: IncomeStreamPayload, fallback: FormDraft): FormDraft {
  const currentYear = new Date().getFullYear();
  // tracksInflation === true → toggle on (disable the number input).
  // tracksInflation === false with explicit colaPct → toggle off, use value.
  // Legacy tracksInflation === undefined → toggle off, colaPct ?? 0.
  const pensionTracksInflation = p.tracksInflation === true;
  const partTimeTracksInflation = p.tracksInflation === true;
  return {
    ...fallback,
    name: p.name,
    notes: p.notes ?? '',
    memberId: p.memberId,
    kind: p.kind,
    payoutType: p.payoutType ?? 'annuity',
    monthlyBenefit: p.monthlyBenefit?.toString() ?? '',
    pensionTracksInflation,
    pensionColaPct: (p.colaPct ?? 0).toString(),
    jointAndSurvivorPct: p.jointAndSurvivorPct ?? 50,
    linkedCbpAccountId: p.linkedCbpAccountId ?? '',
    lumpSumAmount: p.lumpSumAmount?.toString() ?? '',
    lumpSumTargetAccountId: p.kind === 'pension' && p.payoutType === 'lumpSum' ? p.targetAccountId ?? '' : '',
    annualAmount: p.annualAmount?.toString() ?? '',
    partTimeTracksInflation,
    partTimeColaPct: (p.colaPct ?? 0).toString(),
    oneOffAmount: p.oneOffAmount?.toString() ?? '',
    oneOffSource: p.source ?? 'inheritance',
    oneOffTargetAccountId: p.kind === 'oneOff' ? p.targetAccountId ?? '' : '',
    start: p.start ?? defaultStartFor(p.kind, currentYear),
    end: p.kind === 'partTime' ? p.end ?? defaultEndForPartTime() : undefined,
    taxable: p.taxable !== false,
  };
}

export interface BuildError {
  __error: string;
}

export function isBuildError(x: IncomeStreamPayload | BuildError): x is BuildError {
  return typeof (x as BuildError).__error === 'string';
}

// ---------------------------------------------------------------------------
// Deposit-target eligibility
// ---------------------------------------------------------------------------

/**
 * Account types that can legally RECEIVE a qualified-plan pension lump-sum
 * rollover. The Cash Balance Pension is the rollover SOURCE, not a
 * destination, and a Roth IRA is a taxable conversion the app does not model —
 * both are excluded. Filtered by type AND treatment so a non-qualified shell
 * (e.g. `OTHER` marked `PRE_TAX`) cannot pose as a rollover destination.
 */
const ROLLOVER_TARGET_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set([
  'RETIREMENT_IRA',
  'RETIREMENT_401K',
  'RETIREMENT_403B',
  'RETIREMENT_457B',
  'RETIREMENT_TSP',
]);

/** Tax treatments a pension rollover destination may carry (pre-tax money). */
const ROLLOVER_TARGET_TREATMENTS: ReadonlySet<AccountTaxTreatment> = new Set([
  'PRE_TAX',
  'MIXED',
]);

/**
 * Account types that can receive a one-off windfall DEPOSIT. External
 * cash realistically lands in a taxable brokerage/cash account — it cannot be
 * added to employer plans / IRAs beyond tiny contribution limits.
 */
const WINDFALL_TARGET_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set([
  'BROKERAGE',
  'SAVINGS',
  'MONEY_MARKET',
  'CD',
]);

/** A pension lump-sum rollover may only target a pre-tax-capable qualified
 *  account. */
export function isEligibleRolloverTarget(account: Aggregate<AccountPayload>): boolean {
  const p = account.payload;
  return (
    ROLLOVER_TARGET_ACCOUNT_TYPES.has(p.type) &&
    ROLLOVER_TARGET_TREATMENTS.has(p.taxTreatment)
  );
}

/** A one-off windfall deposit may only target a taxable account. */
export function isEligibleWindfallTarget(account: Aggregate<AccountPayload>): boolean {
  const p = account.payload;
  return (
    WINDFALL_TARGET_ACCOUNT_TYPES.has(p.type) && p.taxTreatment === 'POST_TAX'
  );
}

export function buildPayload(
  draft: FormDraft,
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
): IncomeStreamPayload | BuildError {
  if (!draft.name.trim()) return { __error: 'Name is required.' };
  if (!draft.memberId) return { __error: 'Owner is required.' };
  const startErr = validateStart(draft.start);
  if (startErr) return { __error: startErr };

  const base: IncomeStreamPayload = {
    name: draft.name.trim(),
    notes: draft.notes.trim() || undefined,
    memberId: draft.memberId,
    kind: draft.kind,
    start: draft.start,
    taxable: draft.taxable,
  };

  if (draft.kind === 'pension') {
    base.payoutType = draft.payoutType;
    if (draft.payoutType === 'annuity') {
      const monthly = parseDecimal(draft.monthlyBenefit);
      if (monthly <= 0) return { __error: 'Monthly benefit must be greater than 0.' };
      base.monthlyBenefit = monthly;
      // When tracking scenario inflation, omit colaPct entirely
      // (undefined, never 0); when explicit, store the user value.
      if (draft.pensionTracksInflation) {
        base.tracksInflation = true;
        // colaPct deliberately not set (undefined, not 0)
      } else {
        base.tracksInflation = false;
        base.colaPct = parseDecimal(draft.pensionColaPct);
      }
      base.jointAndSurvivorPct = draft.jointAndSurvivorPct;
      if (draft.linkedCbpAccountId) base.linkedCbpAccountId = draft.linkedCbpAccountId;
    } else {
      // Linked-CBP lump-sums derive their amount from the projected
      // CBP balance at the event month (Balance Projection page wiring
      // in `loadPageData`). The user-entered field is hidden in the
      // UI and the payload carries 0 so the income-projection engine's
      // legacy fallback emits no spurious deposit.
      if (!draft.lumpSumTargetAccountId) {
        return { __error: 'Pick a target account for the lump-sum deposit.' };
      }
      // A pension lump-sum is pre-tax money — it may only roll into a
      // pre-tax-capable qualified account. A target that no longer qualifies
      // (e.g. a legacy stream whose saved account is now taxable/Roth) is
      // rejected here rather than silently dropped, so the saved value stays
      // visible for the user to re-pick (edit-flow legacy).
      const lumpTarget = accounts.find((a) => a.id === draft.lumpSumTargetAccountId);
      if (!lumpTarget || !isEligibleRolloverTarget(lumpTarget)) {
        return {
          __error:
            'Pick a pre-tax retirement account (IRA, 401(k), 403(b), 457(b), or TSP) for the rollover. A taxable, Roth, HSA, or cash-balance account cannot receive a tax-free pension rollover.',
        };
      }
      if (draft.linkedCbpAccountId) {
        base.lumpSumAmount = 0;
        base.targetAccountId = draft.lumpSumTargetAccountId;
        base.linkedCbpAccountId = draft.linkedCbpAccountId;
      } else {
        const amount = parseDecimal(draft.lumpSumAmount);
        if (amount <= 0) return { __error: 'Lump sum amount must be greater than 0.' };
        base.lumpSumAmount = amount;
        base.targetAccountId = draft.lumpSumTargetAccountId;
      }
    }
  } else if (draft.kind === 'partTime') {
    const annual = parseDecimal(draft.annualAmount);
    if (annual <= 0) return { __error: 'Annual amount must be greater than 0.' };
    base.annualAmount = annual;
    if (!draft.end) return { __error: 'Set an end for this part-time stream.' };
    const endErr = validateEnd(draft.end);
    if (endErr) return { __error: endErr };
    base.end = draft.end;
    // When tracking scenario inflation, omit colaPct entirely
    // (undefined, never 0); when explicit, store the user value.
    if (draft.partTimeTracksInflation) {
      base.tracksInflation = true;
      // colaPct deliberately not set (undefined, not 0)
    } else {
      base.tracksInflation = false;
      base.colaPct = parseDecimal(draft.partTimeColaPct);
    }
  } else {
    const amount = parseDecimal(draft.oneOffAmount);
    if (amount <= 0) return { __error: 'Amount must be greater than 0.' };
    if (!draft.oneOffTargetAccountId) {
      return { __error: 'Pick the account that receives this windfall.' };
    }
    // A windfall is external cash — it can only land in a taxable
    // brokerage/cash account, not a retirement plan. A now-ineligible saved
    // target (legacy edit) is rejected here, keeping the value visible.
    const windfallTarget = accounts.find((a) => a.id === draft.oneOffTargetAccountId);
    if (!windfallTarget || !isEligibleWindfallTarget(windfallTarget)) {
      return {
        __error:
          'Pick a taxable account (brokerage, savings, money market, or CD) for the windfall. It cannot be added to a retirement or HSA account.',
      };
    }
    base.oneOffAmount = amount;
    base.source = draft.oneOffSource;
    base.targetAccountId = draft.oneOffTargetAccountId;
  }

  return base;
}

/**
 * Per-key delta between the form's built payload and the resolved payload
 * the form opened with (mirrors the expense `scenarioPatchDelta`).
 * Only top-level keys whose value changed are emitted, so the stored patch
 * stays as sparse as the user's actual edits. A kind change carries `kind`
 * plus the new kind's fields. `notes` clears to `''` (an empty string is
 * the field's real value, not a key removal).
 *
 * Clear anything the rebuild dropped: any key present in
 * `opened` but absent in the rebuilt payload emits `null`, the
 * clear-marker. This covers both an emptied in-kind optional (e.g. a
 * pension's `linkedCbpAccountId`) AND an off-kind leftover after a `kind`
 * switch, so the scenario resolves to a clean stream with no stale inert
 * keys. The resolver drops `null`-valued keys after the chain merge.
 */
function incomeScenarioPatchDelta(
  built: IncomeStreamPayload,
  opened: IncomeStreamPayload,
): PatchWithClears<IncomeStreamPayload> {
  const delta: PatchWithClears<IncomeStreamPayload> = {};
  const keys = new Set<keyof IncomeStreamPayload>([
    ...(Object.keys(built) as (keyof IncomeStreamPayload)[]),
    ...(Object.keys(opened) as (keyof IncomeStreamPayload)[]),
  ]);
  for (const k of keys) {
    if (k === 'notes') {
      const next = built.notes ?? '';
      if (next !== (opened.notes ?? '')) {
        (delta as Record<string, unknown>)[k] = next;
      }
      continue;
    }
    if (!jsonEq(built[k], opened[k])) {
      if (built[k] !== undefined) {
        (delta as Record<string, unknown>)[k] = built[k];
      } else if (opened[k] !== undefined) {
        // The rebuild dropped a key the scenario opened with — emit the
        // `null` clear-marker so the resolver omits it rather than
        // re-inheriting the canonical value.
        (delta as Record<string, unknown>)[k] = null;
      }
    }
  }
  return delta;
}

/**
 * Scenario-patch Save: compute the next `ScenarioPayload` after merging
 * the per-key delta into THIS income's existing patch (never replace —
 * pre-existing patch keys are preserved). Pre-prefix snapshots could
 * store the patch under the raw canonical id, so the merge reads either
 * key and the shared write helper drops both. Pure.
 */
export function computeIncomeScenarioPatchSave(
  scenarioPayload: ScenarioPayload,
  built: IncomeStreamPayload,
  opened: IncomeStreamPayload,
  prefixedId: string,
  rawId: string,
): ScenarioPayload {
  const delta = incomeScenarioPatchDelta(built, opened);
  const allPatches = scenarioPayload.overrides.income?.patches ?? {};
  const existingPatch: PatchWithClears<IncomeStreamPayload> =
    (allPatches[prefixedId] as
      | PatchWithClears<IncomeStreamPayload>
      | undefined) ??
    (allPatches[rawId] as PatchWithClears<IncomeStreamPayload> | undefined) ??
    {};
  const mergedPatch: PatchWithClears<IncomeStreamPayload> = {
    ...existingPatch,
    ...delta,
  };
  return buildScenarioIncomePatchWrite(
    scenarioPayload,
    prefixedId,
    rawId,
    mergedPatch,
  );
}

/**
 * Per-member retirement (year, month0) + the scenario's life-expectancy
 * override, resolved from the form's effective scenario. Feeds the
 * `ScheduleResolveContext` the Save-time schedule validator uses so an
 * owner-relative `retirementStart` / `endOfRetirementYear` / `lifetime`
 * anchor resolves to the same month the projection engine would pick.
 * Returns empties on any failure — the validator treats an unresolved
 * anchor as "don't block" (the engine fail-safes broken anchors).
 */
export function resolveRetirementFacts(
  scenario: Aggregate<ScenarioPayload> | null | undefined,
  scenarios: Aggregate<ScenarioPayload>[],
  members: Aggregate<HouseholdMemberPayload>[],
): {
  retirementByMember: Map<string, { year: number; month0: number }>;
  lifeExpectancy: LifeExpectancyOverride | undefined;
} {
  const retirementByMember = new Map<string, { year: number; month0: number }>();
  let lifeExpectancy: LifeExpectancyOverride | undefined;
  if (!scenario) return { retirementByMember, lifeExpectancy };
  try {
    const resolved = resolveScenario(scenario.id, scenarios as ScenarioAggregate[]);
    lifeExpectancy = resolved.lifeExpectancy;
    const map = resolveMemberRetirementDates(
      resolved.retirementAge,
      members.map((m) => ({
        id: m.id,
        isPrimary: m.payload.isPrimary,
        birthdate: m.payload.birthdate ?? '',
      })),
    );
    for (const [id, iso] of map) {
      if (iso) {
        const d = new Date(iso);
        retirementByMember.set(id, {
          year: d.getUTCFullYear(),
          month0: d.getUTCMonth(),
        });
      }
    }
  } catch {
    // Leave empties — the validator won't block on an unresolved anchor.
  }
  return { retirementByMember, lifeExpectancy };
}
