// MAGI-cap override persistence: turns a draft cap ladder and the parent chain's resolved cap into the `magiCap` fragment a
// scenario save merges. In `lib/` so the editor save helper and the Roth conversion Apply builder import it downward.

import type {
  MagiCapDisabled,
  MagiCapOverride,
  MagiCapWindow,
  ScenarioPayload,
} from '../db/types';

type ScenarioOverrides = ScenarioPayload['overrides'];

/** A window as edited in the UI: the ceiling may be `null` until entered; the UI blocks save until every ceiling is set. */
export type DraftMagiCapWindow = Omit<MagiCapWindow, 'magiCeilingAnnualDollars'> & {
  magiCeilingAnnualDollars: number | null;
};

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

function sameMagiCapLadder(
  a: MagiCapOverride['windows'],
  b: MagiCapOverride['windows'],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The `magiCap` fragment for a save. Cap on: omit the key when no local override
 * exists and the draft equals the parent ladder (preserving inheritance), else
 * persist `{ windows }`. Cap off: write `{ disabled: true }` when a parent cap
 * exists, else clear the local override. `parentCap` is the real resolved cap
 * (sentinel coerced away), to tell "off but the parent imposes one" from "off".
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
    if (
      localOverrides.magiCap === undefined &&
      parentCap !== undefined &&
      sameMagiCapLadder(windows, parentCap.windows)
    ) {
      return {};
    }
    return { magiCap: { windows } };
  }
  if (parentCap !== undefined) {
    return { magiCap: { disabled: true } };
  }
  return localOverrides.magiCap === undefined ? {} : { magiCap: undefined };
}
