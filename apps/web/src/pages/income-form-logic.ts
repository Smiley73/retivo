/** Pure logic for IncomeFormPage: draft/payload conversion, deposit-target eligibility, the scenario-patch delta algebra and the retirement-facts resolver. Kept parallel to, not unified with, the expense helpers (different override fields). */
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

// Pension rollover destinations: CBP is the source and a Roth IRA is a taxable conversion the app does not model.
// Filtered by type and treatment so a non-qualified shell (OTHER marked PRE_TAX) cannot pose as a destination.
const ROLLOVER_TARGET_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set([
  'RETIREMENT_IRA',
  'RETIREMENT_401K',
  'RETIREMENT_403B',
  'RETIREMENT_457B',
  'RETIREMENT_TSP',
]);

const ROLLOVER_TARGET_TREATMENTS: ReadonlySet<AccountTaxTreatment> = new Set([
  'PRE_TAX',
  'MIXED',
]);

// Windfall cash lands in a taxable brokerage or cash account, not employer plans or IRAs.
const WINDFALL_TARGET_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set([
  'BROKERAGE',
  'SAVINGS',
  'MONEY_MARKET',
  'CD',
]);

export function isEligibleRolloverTarget(account: Aggregate<AccountPayload>): boolean {
  const p = account.payload;
  return (
    ROLLOVER_TARGET_ACCOUNT_TYPES.has(p.type) &&
    ROLLOVER_TARGET_TREATMENTS.has(p.taxTreatment)
  );
}

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
      // Tracking scenario inflation omits colaPct (undefined, never 0).
      if (draft.pensionTracksInflation) {
        base.tracksInflation = true;
      } else {
        base.tracksInflation = false;
        base.colaPct = parseDecimal(draft.pensionColaPct);
      }
      base.jointAndSurvivorPct = draft.jointAndSurvivorPct;
      if (draft.linkedCbpAccountId) base.linkedCbpAccountId = draft.linkedCbpAccountId;
    } else {
      // Linked-CBP lump sums derive the amount from the CBP balance at the event month (loadPageData); the payload carries 0 so the legacy fallback emits no spurious deposit.
      if (!draft.lumpSumTargetAccountId) {
        return { __error: 'Pick a target account for the lump-sum deposit.' };
      }
      // A target that no longer qualifies (legacy edit) is rejected rather than silently dropped, so the saved value stays visible for re-pick.
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
    if (draft.partTimeTracksInflation) {
      base.tracksInflation = true;
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

// Per-key delta against the resolved payload the form opened with, so the stored patch stays sparse. A key present in opened but absent in the rebuild emits null (the clear-marker), covering emptied optionals and off-kind leftovers after a kind switch.
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
        (delta as Record<string, unknown>)[k] = null;
      }
    }
  }
  return delta;
}

/** Merges the per-key delta into this income's existing patch, never replacing it; pre-prefix snapshots could store the patch under the raw canonical id, so either key is read and both are dropped. */
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

/** Per-member retirement (year, month0) and the scenario's life-expectancy override for the Save-time schedule validator; returns empties on failure, and an unresolved anchor never blocks. */
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
  }
  return { retirementByMember, lifeExpectancy };
}
