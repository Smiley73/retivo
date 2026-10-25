/**
 * Controlled editor for an expense's spending glide (rise or fall over retirement): enable toggle, glide start / end
 * and optional floor anchors. Off persists `undefined` in both `canonical` and `scenario-patch` mode.
 */
import React, { useState } from 'react';
import { RangeSlider } from './RangeSlider';
import { ToggleSwitch } from './ToggleSwitch';
import { ScheduleAnchorPicker } from './ScheduleAnchorPicker';
import { Muted } from './Muted';
import {
  PCT_MIN,
  PCT_MAX,
  NEUTRAL_END_PCT,
  NEUTRAL_FLOOR_PCT,
  clampPct,
} from '../lib/expense-glide-format';
import type {
  Aggregate,
  DiscretionaryGlideOverride,
  GlideAnchor,
  HouseholdMemberPayload,
} from '../db/types';

type GlideFieldsMode = 'canonical' | 'scenario-patch';

const PCT_STEP = 5;

interface Props {
  value: DiscretionaryGlideOverride | undefined;
  onChange: (next: DiscretionaryGlideOverride | undefined) => void;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /** Editor context; the value logic does not branch on it. */
  mode: GlideFieldsMode;
}

interface Draft {
  enabled: boolean;
  endPct: number;
  glideStart: GlideAnchor;
  glideEnd: GlideAnchor;
  floorOn: boolean;
  floorPct: number;
  floorAnchor: GlideAnchor;
}

// Presence is enablement: a cleared glide arrives `undefined`, so any present value, even a no-op
// one, seeds the toggle on.
const seededEnabled = (
  v: DiscretionaryGlideOverride | undefined,
): boolean => v !== undefined;

const seed = (
  v: DiscretionaryGlideOverride | undefined,
): Draft => ({
  enabled: seededEnabled(v),
  endPct: v?.endMultiplierPct ?? NEUTRAL_END_PCT,
  // Resolvable defaults: from retirement start until the expense's own end, which also means the
  // floor cannot apply, so it seeds off.
  glideStart: v?.glideStart ?? { kind: 'retirementStart' },
  glideEnd: v?.glideEnd ?? { kind: 'expenseEnd' },
  floorOn: v?.floor != null,
  floorPct: v?.floor?.multiplierPct ?? NEUTRAL_FLOOR_PCT,
  floorAnchor: v?.floor?.anchor ?? { kind: 'retirementStart' },
});

// A floor must resolve after glide-end, so with an `expenseEnd` glide-end it is disabled and
// dropped from the emitted value.
const floorDisabledByGlideEnd = (d: Draft): boolean =>
  d.glideEnd.kind === 'expenseEnd';

const deriveValue = (
  d: Draft,
): DiscretionaryGlideOverride | undefined => {
  if (!d.enabled) {
    return undefined;
  }
  const emitFloor = d.floorOn && !floorDisabledByGlideEnd(d);
  return {
    endMultiplierPct: clampPct(d.endPct),
    glideStart: d.glideStart,
    glideEnd: d.glideEnd,
    ...(emitFloor
      ? { floor: { multiplierPct: clampPct(d.floorPct), anchor: d.floorAnchor } }
      : {}),
  };
};

export const DiscretionaryGlideFields: React.FC<Props> = ({
  value,
  onChange,
  members,
}) => {
  // Seeded once: the parent remounts via `key` on an external reseed, so a [value]-effect would
  // only clobber transient sub-state.
  const [draft, setDraft] = useState<Draft>(() => seed(value));

  const apply = (patch: Partial<Draft>): void => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onChange(deriveValue(next));
  };

  // Selecting `expenseEnd` already cleared `floorOn`, so switching back leaves the floor off.
  const floorDisabled = floorDisabledByGlideEnd(draft);
  const floorOpen = draft.floorOn && !floorDisabled;

  // `> 100` rises, making the plateau a ceiling; otherwise it is a floor.
  const rising = draft.endPct > NEUTRAL_END_PCT;
  const plateauLabel = rising ? 'Ceiling' : 'Floor';
  // The plateau domain flips by direction: 0 → End % for a decline, End % → PCT_MAX for a rise.
  const plateauMin = rising ? draft.endPct : PCT_MIN;
  const plateauMax = rising ? PCT_MAX : draft.endPct;
  const plateauValue = Math.max(plateauMin, Math.min(plateauMax, draft.floorPct));

  return (
    // A labelled `<div role="group">`, not `<fieldset>`, which has a first-paint flex sizing quirk.
    <div
      role="group"
      aria-labelledby="glide-group-label"
      className="mb-3 flex min-w-0 flex-1 flex-col gap-2 rounded-xl border border-line p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <header
          id="glide-group-label"
          className="m-0 text-sm font-semibold text-ink"
        >
          Spending glide
        </header>
        <ToggleSwitch
          ariaLabel="Enable spending glide"
          checked={draft.enabled}
          onChange={(enabled) => apply({ enabled })}
        />
      </div>
      <Muted as="p" className="mb-1 mt-0 text-sm">
        A <strong>spending glide</strong> lets this expense&apos;s real cost
        rise or fall over retirement — lower later (e.g. less travel), or
        climbing (e.g. care costs). Amounts are in today&apos;s dollars (after
        inflation); a rising glide stacks on top of the category&apos;s
        inflation, so don&apos;t also raise the category rate for the same cost.
      </Muted>

      {draft.enabled && (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <div className="mb-3 min-w-0 max-w-sm">
            <label
              htmlFor="glide-end-pct"
              className="mb-1 block text-sm font-medium text-ink"
            >
              End percentage
            </label>
            <RangeSlider
              id="glide-end-pct"
              ariaLabel="End percentage"
              min={PCT_MIN}
              max={PCT_MAX}
              step={PCT_STEP}
              value={draft.endPct}
              onChange={(v) => {
                const endPct = clampPct(v);
                // Re-clamp the plateau to the valid side of the new end, including a crossing of
                // 100 that flips floor and ceiling.
                const floorPct =
                  endPct > NEUTRAL_END_PCT
                    ? Math.max(draft.floorPct, endPct)
                    : Math.min(draft.floorPct, endPct);
                apply({ endPct, floorPct });
              }}
              formatValue={(v) => `${v}%`}
            />
            <Muted as="p" className="mt-1 text-sm">
              of today&apos;s spend at the glide end
            </Muted>
          </div>

          <div className="flex flex-col gap-3">
            <ScheduleAnchorPicker
              value={draft.glideStart}
              onChange={(a) => apply({ glideStart: a })}
              members={members}
              relativeKind
              label="Glide starts"
            />

            <ScheduleAnchorPicker
              value={draft.glideEnd}
              onChange={(a) =>
                // Selecting `expenseEnd` makes the floor inapplicable; clear `floorOn` in the same
                // patch so a later switch does not re-emit it.
                apply(
                  a.kind === 'expenseEnd'
                    ? { glideEnd: a, floorOn: false }
                    : { glideEnd: a },
                )
              }
              members={members}
              relativeKind
              expenseEndKind
              label="Glide ends"
            />
          </div>

          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-ink">
                {rising ? 'Hard ceiling (cap)' : 'Hard floor (no-go years)'}
              </span>
              <ToggleSwitch
                ariaLabel={rising ? 'Hard ceiling (cap)' : 'Hard floor (no-go years)'}
                checked={floorOpen}
                disabled={floorDisabled}
                onChange={(floorOn) =>
                  // Turning a rising glide's ceiling on seeds it to End % when the stored value is
                  // below it.
                  apply(
                    floorOn && rising && draft.floorPct < draft.endPct
                      ? { floorOn, floorPct: draft.endPct }
                      : { floorOn },
                  )
                }
              />
            </div>
            {floorDisabled && (
              <Muted as="p" className="-mt-1 text-sm">
                The {rising ? 'ceiling' : 'floor'} doesn&apos;t apply when the
                glide ends with the expense; it would start after the expense
                already ended.
              </Muted>
            )}

            <div
              className={
                floorOpen
                  ? 'mb-1 min-w-0 max-w-sm'
                  : 'pointer-events-none mb-1 min-w-0 max-w-sm opacity-60'
              }
            >
              <label
                htmlFor="glide-floor-pct"
                className="mb-1 block text-sm font-medium text-ink"
              >
                {plateauLabel} percentage
              </label>
              <RangeSlider
                id="glide-floor-pct"
                ariaLabel={`${plateauLabel} percentage`}
                disabled={!floorOpen}
                min={plateauMin}
                max={plateauMax}
                step={PCT_STEP}
                value={plateauValue}
                onChange={(v) =>
                  apply({
                    floorPct: Math.max(plateauMin, Math.min(plateauMax, clampPct(v))),
                  })
                }
                formatValue={(v) => `${v}%`}
              />
            </div>
            <ScheduleAnchorPicker
              value={draft.floorAnchor}
              onChange={(a) => apply({ floorAnchor: a })}
              members={members}
              relativeKind
              disabled={!floorOpen}
              label={`${plateauLabel} starts`}
            />
          </div>
        </div>
      )}
    </div>
  );
};
