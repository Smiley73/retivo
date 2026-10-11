/**
 * MAGI-cap override persistence rule (shared lib layer).
 *
 * Pure helpers that turn a draft MAGI-cap ladder + the parent-chain resolved cap
 * into the `magiCap` override fragment a scenario save merges in. Lives in the
 * lib/ (lower domain) layer so BOTH the withdrawal-strategy editor save-helper
 * (`pages/scenario-withdrawal-strategy-save-helpers.ts`) and the Roth conversion
 * comparison page's Apply builder (`lib/roth-betr-apply-helpers.ts`) import it
 * DOWNWARD, instead of that page reaching up into pages/ for a core persistence
 * rule (clean-arch dependency rule).
 */
import type {
  MagiCapDisabled,
  MagiCapOverride,
  MagiCapWindow,
  ScenarioPayload,
} from '../db/types';

type ScenarioOverrides = ScenarioPayload['overrides'];

/**
 * A MAGI-cap window as edited in the UI: identical to the persisted
 * `MagiCapWindow` except the ceiling may be `null` (a fresh window's ceiling is
 * required, but the draft seed carries `null` so the field renders empty until
 * entry). The UI blocks save until every window's ceiling is non-null.
 */
export type DraftMagiCapWindow = Omit<MagiCapWindow, 'magiCeilingAnnualDollars'> & {
  magiCeilingAnnualDollars: number | null;
};

/** Narrow a draft window (ceiling may be null) into a persisted `MagiCapWindow`
 *  (ceiling non-null). Caller validates non-null ceilings before save;
 *  a stray null falls back to 0 defensively (never reached in practice). The
 *  default mode / line are kept on the persisted window — the schedule has no
 *  "absent ⇒ default" coupling (each window owns all its fields). The
 *  `targetRothAccountId` key is omitted when absent to keep the payload clean. */
function toPersistedWindow(w: DraftMagiCapWindow): MagiCapWindow {
  return {
    start: w.start,
    end: w.end,
    magiCeilingAnnualDollars: w.magiCeilingAnnualDollars ?? 0,
    capMode: w.capMode,
    capMagiLine: w.capMagiLine,
    ...(w.targetRothAccountId !== undefined
      ? { targetRothAccountId: w.targetRothAccountId }
      : {}),
  };
}

/** Order-insensitive-free deep equality of two cap-window ladders (the engine
 *  re-sorts; here exact stored equality is what decides inheritance churn). */
function sameMagiCapLadder(
  a: MagiCapOverride['windows'],
  b: MagiCapOverride['windows'],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * MAGI-cap override — child-scenario override + explicit-disable,
 * reshaped to the WINDOW SCHEDULE.
 *
 * Driven by `parentCap` (the parent chain's resolved REAL cap, sentinel coerced
 * away) so it can distinguish "off but parent imposes a cap" (write the
 * sentinel) from "off, no cap anywhere" (omit).
 *
 * Decision matrix:
 * - Cap ON (caller validated every window's ceiling is non-null):
 *   - no local override AND a parent cap exists AND the draft ladder equals the
 *     parent ladder → omit the key (preserve inheritance, no churn).
 *   - otherwise → persist the real `{ windows }` ladder.
 * - Cap OFF:
 *   - a parent cap exists → write the disable sentinel `{ disabled: true }`.
 *   - no parent cap → clear the local override.
 */
export function buildNextMagiCap(args: {
  magiCapEnabled: boolean;
  magiCapWindows: DraftMagiCapWindow[];
  localOverrides: ScenarioOverrides;
  parentCap: MagiCapOverride | undefined;
}):
  | { magiCap: MagiCapOverride }
  | { magiCap: MagiCapDisabled }
  | { magiCap?: undefined }
  | Record<string, never> {
  const { magiCapEnabled, magiCapWindows, localOverrides, parentCap } = args;
  if (magiCapEnabled) {
    const windows = magiCapWindows.map(toPersistedWindow);
    // Cap inherited, no local override, draft ladder still equals the
    // parent ladder → omit so saving an unrelated change doesn't freeze
    // inheritance.
    if (
      localOverrides.magiCap === undefined &&
      parentCap !== undefined &&
      sameMagiCapLadder(windows, parentCap.windows)
    ) {
      return {};
    }
    return { magiCap: { windows } };
  }
  // Cap OFF with a parent cap active → explicit-disable sentinel so the
  // child overrides the inherited cap.
  if (parentCap !== undefined) {
    return { magiCap: { disabled: true } };
  }
  // Cap OFF with no parent cap → clear the local override. When there
  // is no local override, the clear is a no-op; omit the key.
  return localOverrides.magiCap === undefined ? {} : { magiCap: undefined };
}
