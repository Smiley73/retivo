/**
 * Shared editor for an expense's spending glide: real spending can rise
 * or fall over retirement (a fall is the classic go-go → slow-go → no-go
 * decline; a rise models escalating costs such as later-life care).
 * Embedded by the expense form (`ExpenseFormPage`), rendered for any
 * classification (still hidden for one-off frequency). The curve math
 * lives with the per-expense canonical field; this is configuration only.
 *
 * Controlled component: the parent owns the
 * `DiscretionaryGlideOverride | undefined` value and dirty-tracking;
 * this composes 3 `<ScheduleAnchorPicker>` (glide-start / glide-end /
 * floor) + an enable toggle + a floor toggle + end / floor
 * `PercentInput`. `<div role="group">` + `<header>` (not `<fieldset>`).
 *
 * Layout: this editor lives in the expense form's narrow right column,
 * so everything stacks one per row — End-%, then glide-start / glide-end
 * as collapsible `AnchorCard`s, then the hard floor section (toggle +
 * Floor-% + the "Floor starts" `AnchorCard`). The enable toggle dims and
 * disables every control rather than unmounting (no layout jump); the
 * floor controls likewise dim/disable (and the floor card collapses)
 * when the floor is off or can't apply.
 *
 * The enable-toggle-Off behavior is uniform across both modes: Off persists `undefined` in BOTH `canonical`
 * and `scenario-patch` mode. In scenario-patch mode `undefined` no longer
 * means "inherit" — the delta turns an absent-in-built glide into a
 * `null` clear-marker (the resolver drops the key → engine default), so
 * the editor never needs to persist the old value-equivalent neutral
 * object to represent "off".
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

// Mockup: the End/Floor percentage sliders move in 5-point increments.
const PCT_STEP = 5;

interface Props {
  value: DiscretionaryGlideOverride | undefined;
  onChange: (next: DiscretionaryGlideOverride | undefined) => void;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  /**
   * Editor context. The enable-toggle-Off behavior is
   * uniform (Off → `undefined` in both modes), so the editor's value
   * logic no longer branches on `mode`; the prop is retained because
   * callers pass it to document the canonical-vs-scenario-patch context
   * and to leave room for future mode-specific affordances.
   */
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

/**
 * Whether the enable toggle seeds ON. Presence IS enablement in both
 * modes: a cleared glide arrives `undefined` (the scenario
 * patch carries a `null` clear-marker, never the old neutral object), so
 * any present value — even a value-equivalent no-op — seeds the toggle
 * ON. A freshly-enabled glide whose End % is still the default 100 with
 * default anchors is a valid *enabled* glide; seeding it OFF would lose
 * the user's just-saved enablement.
 */
const seededEnabled = (
  v: DiscretionaryGlideOverride | undefined,
): boolean => v !== undefined;

const seed = (
  v: DiscretionaryGlideOverride | undefined,
): Draft => ({
  enabled: seededEnabled(v),
  endPct: v?.endMultiplierPct ?? NEUTRAL_END_PCT,
  // Sensible, resolvable defaults when nothing is set yet (NOT an age-0
  // anchor, which reads as "0" and is invalid): the glide runs from the
  // start of retirement until the expense's own end. Selecting
  // `expenseEnd` glide-end also means the floor can't apply, so the floor
  // seeds off; its anchor defaults to a resolvable kind for when the user
  // moves glide-end earlier and turns the floor on.
  glideStart: v?.glideStart ?? { kind: 'retirementStart' },
  glideEnd: v?.glideEnd ?? { kind: 'expenseEnd' },
  floorOn: v?.floor != null,
  floorPct: v?.floor?.multiplierPct ?? NEUTRAL_FLOOR_PCT,
  floorAnchor: v?.floor?.anchor ?? { kind: 'retirementStart' },
});

/**
 * A floor must resolve strictly after glide-end; a floor strictly after
 * the expense's own end can never apply. So when glide-end is the
 * `expenseEnd` anchor the floor is meaningless — disabled in the UI and
 * dropped from the emitted value. Selecting `expenseEnd` also clears
 * `floorOn` in the same patch (see the glide-end picker's `onChange`),
 * so switching glide-end away later leaves the floor OFF until the user
 * re-toggles it — no silent auto-restore of the prior `floorPct`/
 * `floorAnchor`. `floorPct`/`floorAnchor` draft values are kept
 * (cheap, never re-emitted while `floorOn` is false).
 */
const floorDisabledByGlideEnd = (d: Draft): boolean =>
  d.glideEnd.kind === 'expenseEnd';

const deriveValue = (
  d: Draft,
): DiscretionaryGlideOverride | undefined => {
  if (!d.enabled) {
    // Off persists `undefined` in both modes. In scenario-patch
    // mode the delta turns absent-in-built into a `null` clear-marker, so
    // the editor no longer needs to emit a value-equivalent neutral object
    // to mean "off".
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
  // Seeded once — the parent gates rendering behind its own load, so
  // `value` is stable from mount (matches ScheduleAnchorPicker's
  // controlled-but-locally-seeded pattern). An external reseed (the
  // scenario-patch Reset) remounts this editor via a changing `key` in
  // the parent, so a [value]-effect re-seed (which would clobber
  // transient sub-state like a toggled-off floor's anchor) is not used.
  const [draft, setDraft] = useState<Draft>(() => seed(value));

  const apply = (patch: Partial<Draft>): void => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onChange(deriveValue(next));
  };

  // `expenseEnd` glide-end ⇒ the floor can never apply; disable the
  // floor toggle. Selecting `expenseEnd` already cleared `floorOn`
  // (glide-end picker `onChange`), so switching back to a resolvable
  // kind leaves the floor OFF — no silent auto-restore.
  const floorDisabled = floorDisabledByGlideEnd(draft);
  // The floor's detail fields show only when the floor is genuinely on.
  const floorOpen = draft.floorOn && !floorDisabled;

  // Direction by `sign(end − 100)`: `> 100` rises (the plateau is a
  // *ceiling*), otherwise the plateau is a *floor*. Drives the relabel
  // and the plateau slider's flipped domain.
  const rising = draft.endPct > NEUTRAL_END_PCT;
  const plateauLabel = rising ? 'Ceiling' : 'Floor';
  // Plateau slider domain flips by direction: 0 → End % for a decline
  // (floor below the end), End % → PCT_MAX for a rise (ceiling above the
  // end). The value clamps to the valid sub-range either way.
  const plateauMin = rising ? draft.endPct : PCT_MIN;
  const plateauMax = rising ? PCT_MAX : draft.endPct;
  const plateauValue = Math.max(plateauMin, Math.min(plateauMax, draft.floorPct));

  return (
    // WAI-ARIA labelled group (the preserved `<div role="group">` +
    // `<header>` pattern, NOT a `<fieldset>`: native fieldset has a
    // first-paint flex sizing quirk).
    <div
      role="group"
      aria-labelledby="glide-group-label"
      className="mb-3 flex min-w-0 flex-1 flex-col gap-2 rounded-xl border border-line p-4"
    >
      {/* Mockup header row: title left, enable switch right (bare switch,
          no visible label — the title labels the box). */}
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

      {/* Reveal: the config appears only when the glide is enabled
          (mockup `data-reveal="#glide-config"`). The mockup divides the
          config from the header with a top hairline. */}
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
                // Re-clamp the plateau to the now-valid side by direction,
                // including a boundary crossing across 100 that flips
                // floor↔ceiling: a rising glide needs a ceiling
                // `≥ end` (clamp up), a declining one a floor `≤ end`
                // (clamp down). An inherited floor never persists as an
                // invalid ceiling, and vice-versa.
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

          {/* Glide start / end as collapsible anchor cards, stacked one
              per row (this editor lives in the form's narrow right column,
              so a side-by-side grid would squeeze the open picker). */}
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
                // Selecting `expenseEnd` glide-end ⇒ the floor can never
                // apply (a floor must resolve strictly after glide-end; a
                // floor strictly after the expense's own end never does).
                // Clear `floorOn` in the SAME patch so switching glide-end
                // away later does not silently re-emit the stale floor
                // (no auto-restore of prior floor values).
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

          {/* Hard floor / ceiling — a full-width section (not a ⅓-width
              grid cell) so the anchor card has room when it expands. The
              toggle + percentage always render and dim/disable when the
              plateau is off or can't apply, so the layout doesn't jump.
              Label flips Floor↔Ceiling by glide direction. */}
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
                  // Turning the plateau ON for a rising glide seeds the
                  // ceiling to End % (the minimal valid ceiling) when
                  // the stored value is below it; a declining glide keeps
                  // its floor ≤ End %.
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
                // Domain flips by direction: a declining glide's floor
                // runs 0 → End % (it can't exceed the end); a rising
                // glide's ceiling runs End % → 200 (it can't be below it).
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
