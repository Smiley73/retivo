/**
 * Saved-plan marker for the Roth conversion comparison. After a ranked plan is
 * saved to a scenario the page remembers, per scenario and per device, which
 * plan it was and when, and whether the inputs the search consumed have changed
 * since. Pure functions over the aggregates and the resolved overrides, plus
 * thin `localStorage` access; nothing here touches the DOM or React.
 *
 * The record holds comparison keys only: a signature of the inputs and a hash of
 * the saved ladder, next to the two strings the marker displays (the plan's
 * name and the date). No ceilings, account names or other dollar figures.
 *
 * Two shapes decide staleness:
 *  - the INPUT signature leaves out the scenario rows. Saving bumps the saved
 *    scenario's version, so a signature over scenario versions would read "out
 *    of date" the moment it was written. The resolved overrides (minus
 *    `magiCap`, which the save itself changes) stand in for the scenarios:
 *    they are also what moves when a parent the scenario inherits from is
 *    edited, which the scenario's own row would miss.
 *  - the LADDER hash says the scenario still carries the plan. When the
 *    resolved cap is anything else, the marker is dropped, not shown as stale.
 */
import { isMagiCapDisabled, type MagiCapWindow } from '../../db/types';
import { idVersionSignature } from '../../lib/aggregate-signature';
import { buildSuggestionCapWindows } from '../../lib/roth-betr-apply-helpers';
import { resolveScenario } from '../../lib/scenario-resolution';
import type { RothSuggestionData } from './roth-suggestion-view-model';

/** One key per scenario id; client-local, so it is lost on another device. */
export const SAVED_PLAN_STORAGE_PREFIX = 'retivo.rothSuggestion.savedPlan.';

export interface SavedPlanRecord {
  /** The plan's name as the table shows it. */
  readonly label: string;
  /** Local calendar date of the save, `YYYY-MM-DD`. */
  readonly savedOn: string;
  /** `savedPlanSignature` at the time of the save. */
  readonly signature: string;
  /** `ladderHash` of the saved windows. */
  readonly ladderHash: string;
}

export interface SavedPlanStatus {
  readonly label: string;
  readonly savedOn: string;
  /** True when an input the search consumed changed after the save. */
  readonly stale: boolean;
}

/** FNV-1a 32-bit hash of a string (the pattern in `optimizer-mc-runner.ts`). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** JSON with object keys sorted and `undefined` dropped, so two equal values
 *  hash equal whatever order their keys were written in. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Hash of a cap ladder's windows, independent of key order. */
export function ladderHash(windows: readonly MagiCapWindow[]): string {
  return fnv1a(canonicalJson(windows));
}

/** The scenario's resolved overrides without `magiCap`, plus the cap itself. */
function resolveParts(data: Pick<RothSuggestionData, 'scenarios'>, scenarioId: string) {
  const { magiCap, ...rest } = resolveScenario(scenarioId, [...data.scenarios]);
  return { magiCap, rest };
}

function inputSignature(data: RothSuggestionData, rest: object): string {
  return [
    idVersionSignature(data.members),
    idVersionSignature(data.accounts),
    idVersionSignature(data.balances),
    idVersionSignature(data.ssBenefits),
    idVersionSignature(data.expenses),
    idVersionSignature(data.incomeStreams),
    fnv1a(canonicalJson(rest)),
  ].join('|');
}

/**
 * Content signature of what the search consumed: the id and version of every
 * non-scenario aggregate set it projects from, and a hash of the scenario's
 * resolved overrides with `magiCap` removed. Unchanged by a save of the plan
 * itself (which writes `magiCap` only), changed by an edit to any consumed
 * aggregate or to a parent scenario the scenario inherits from.
 */
export function savedPlanSignature(data: RothSuggestionData, scenarioId: string): string {
  return inputSignature(data, resolveParts(data, scenarioId).rest);
}

function localIsoDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The record to store for a plan just saved to `scenarioId`. */
export function buildSavedPlanRecord(args: {
  readonly data: RothSuggestionData;
  readonly scenarioId: string;
  readonly label: string;
  readonly ladder: readonly MagiCapWindow[];
  readonly now: Date;
}): SavedPlanRecord {
  return {
    label: args.label,
    savedOn: localIsoDate(args.now),
    signature: savedPlanSignature(args.data, args.scenarioId),
    ladderHash: ladderHash(buildSuggestionCapWindows(args.ladder)),
  };
}

/**
 * What the marker shows for a stored record: nothing when the scenario's
 * resolved cap is no longer the saved ladder (edited by hand, or another plan
 * saved), otherwise the plan with whether its inputs have changed since.
 */
export function savedPlanStatus(
  record: SavedPlanRecord | null,
  data: RothSuggestionData,
  scenarioId: string,
): SavedPlanStatus | null {
  if (record === null) return null;
  const { magiCap, rest } = resolveParts(data, scenarioId);
  if (magiCap === undefined || isMagiCapDisabled(magiCap)) return null;
  if (ladderHash(magiCap.windows) !== record.ladderHash) return null;
  return {
    label: record.label,
    savedOn: record.savedOn,
    stale: inputSignature(data, rest) !== record.signature,
  };
}

function storageKey(scenarioId: string): string {
  return `${SAVED_PLAN_STORAGE_PREFIX}${scenarioId}`;
}

function isRecord(value: unknown): value is SavedPlanRecord {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.label === 'string' &&
    typeof v.savedOn === 'string' &&
    typeof v.signature === 'string' &&
    typeof v.ladderHash === 'string'
  );
}

/** The scenario's stored record, or null when absent, unreadable or malformed. */
export function readSavedPlan(scenarioId: string): SavedPlanRecord | null {
  try {
    const raw = window.localStorage.getItem(storageKey(scenarioId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Stores the record; a missing or full `localStorage` leaves the marker for
 *  this session only (the caller keeps it in state). */
export function writeSavedPlan(scenarioId: string, record: SavedPlanRecord): void {
  try {
    window.localStorage.setItem(
      storageKey(scenarioId),
      JSON.stringify({
        label: record.label,
        savedOn: record.savedOn,
        signature: record.signature,
        ladderHash: record.ladderHash,
      }),
    );
  } catch {
    /* localStorage unavailable. */
  }
}
