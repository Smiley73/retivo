/** Pure helpers for the Scenario contributions override screen. */
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
  /** This scenario's own explicit annual-increase override (percent); undefined inherits, and 0 is flat-nominal. */
  growthPct?: number;
}

export function buildInheritedMap(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
  accounts: Aggregate<AccountPayload>[],
): Map<string, DraftRow> {
  // "Inherited" is what the row would resolve to with no local override entry: resolve the parent, or on the base the account's own baseline.
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
    // Own explicit override only (undefined inherits); an out-of-band stored value is treated as absent so the draft never seeds a corrupt rate.
    const ownGrowth = o?.contributionGrowthPct;
    out.set(id, {
      preTax: o?.plannedContributionPreTax ?? inh.preTax,
      postTax: o?.plannedContributionPostTax ?? inh.postTax,
      growthPct: isValidContributionGrowthPct(ownGrowth) ? ownGrowth : undefined,
    });
  }
  return out;
}

/** What each account inherits if this scenario carried no growth override: the account baseline on a base scenario, the parent chain's resolved growth on a child. Mode 'tracks-inflation' renders "Match inflation (X%)" with the resolved general rate; 'fixed' the inherited explicit rate. */
export function buildInheritedGrowthMap(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
  accounts: Aggregate<AccountPayload>[],
): Map<string, ResolvedContributionGrowth> {
  if (scenario.payload.parentScenarioId !== null) {
    return resolveContributionGrowth(
      scenario.payload.parentScenarioId,
      scenarios,
      accounts,
    );
  }
  // On a base scenario resolve the account baseline directly, since resolving the base's own id would fold in its own override; the tracks-inflation ratePct is the base's resolved general inflation rate.
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
