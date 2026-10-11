/**
 * Pure helpers for the Scenario contributions override screen,
 * extracted from `ScenarioContributionsPage.tsx` so that page stays small.
 */
import {
  resolveAccountContributionsForScenario,
  resolveContributionGrowth,
  resolveInflationForScenario,
  type ResolvedContributionGrowth,
  type ScenarioAggregate,
} from '../lib/scenario-resolution';
import { isValidContributionGrowthPct } from '../lib/contribution-growth';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';

export interface DraftRow {
  preTax: number;
  postTax: number;
  /** This scenario's OWN explicit annual-increase override (percent).
   *  `undefined` = inherit (the resolved baseline / "Match inflation"); an
   *  explicit number incl. `0` (flat-nominal) overrides. */
  growthPct?: number;
}

export function buildInheritedMap(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
  accounts: Aggregate<AccountPayload>[],
): Map<string, DraftRow> {
  // "Inherited" = what the row would resolve to if THIS scenario had
  // no local override entry for the account. Achieved by resolving the
  // parent (or, on the base, the account's own baseline).
  if (scenario.payload.parentScenarioId === null) {
    const out = new Map<string, DraftRow>();
    for (const a of accounts) {
      out.set(a.id, {
        preTax: a.payload.plannedContributionPreTax,
        postTax: a.payload.plannedContributionPostTax,
      });
    }
    return out;
  }
  const resolved = resolveAccountContributionsForScenario(
    scenario.payload.parentScenarioId,
    scenarios,
    accounts,
  );
  const out = new Map<string, DraftRow>();
  for (const a of accounts) {
    const r = resolved.get(a.id);
    out.set(a.id, {
      preTax: r?.plannedContributionPreTax ?? a.payload.plannedContributionPreTax,
      postTax: r?.plannedContributionPostTax ?? a.payload.plannedContributionPostTax,
    });
  }
  return out;
}

export function buildInitialDrafts(
  scenario: ScenarioAggregate,
  inherited: Map<string, DraftRow>,
): Map<string, DraftRow> {
  const own = scenario.payload.overrides.accountContributions?.perAccount ?? {};
  const out = new Map<string, DraftRow>();
  for (const [id, inh] of inherited) {
    const o = own[id];
    // The draft's growth is THIS scenario's own explicit override only —
    // `undefined` = inherit. An out-of-band stored value is treated as
    // absent (inherit) so the draft never seeds a corrupt rate.
    const ownGrowth = o?.contributionGrowthPct;
    out.set(id, {
      preTax: o?.plannedContributionPreTax ?? inh.preTax,
      postTax: o?.plannedContributionPostTax ?? inh.postTax,
      growthPct: isValidContributionGrowthPct(ownGrowth) ? ownGrowth : undefined,
    });
  }
  return out;
}

/**
 * The growth value each account INHERITS — i.e. what the row resolves to if
 * THIS scenario carried no local growth override. On a base scenario that is
 * the account baseline (or tracks-inflation); on a child it is the parent
 * chain's resolved growth. The `{ mode, ratePct }` drives the scenario
 * placeholder: `'tracks-inflation'` → "Match inflation (X%)" with X = the
 * resolved general inflation rate; `'fixed'` → the inherited explicit rate.
 */
export function buildInheritedGrowthMap(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
  accounts: Aggregate<AccountPayload>[],
): Map<string, ResolvedContributionGrowth> {
  // For a child, resolve the PARENT chain — independent of THIS scenario's
  // own override (mirrors `buildInheritedMap`'s parent-resolve for amounts).
  if (scenario.payload.parentScenarioId !== null) {
    return resolveContributionGrowth(
      scenario.payload.parentScenarioId,
      scenarios,
      accounts,
    );
  }
  // On a base scenario the inherited value is the ACCOUNT baseline, so resolve
  // it directly (resolving the base's own id would fold in its own override).
  // The tracks-inflation `ratePct` is the base scenario's resolved general
  // inflation rate, matching what `resolveContributionGrowth` materialises.
  const inflationRatePct = resolveInflationForScenario(
    scenario.id,
    scenarios,
  ).ratePct;
  const out = new Map<string, ResolvedContributionGrowth>();
  for (const a of accounts) {
    const baseline = a.payload.contributionGrowthPct;
    if (isValidContributionGrowthPct(baseline)) {
      out.set(a.id, { mode: 'fixed', ratePct: baseline });
    } else {
      out.set(a.id, { mode: 'tracks-inflation', ratePct: inflationRatePct });
    }
  }
  return out;
}

export function memberDisplay(m: HouseholdMemberPayload | undefined): string {
  if (!m) return '—';
  return m.firstName?.trim() || 'Member';
}
