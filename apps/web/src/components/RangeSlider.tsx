/**
 * Shared range-slider input — single source of truth for slider entry.
 *
 * Built on React Aria's `Slider`. The public API
 * is FROZEN (consumers untouched): `id`, `ariaLabel`, `min`/`max`/`step`, `value`,
 * `onChange(next)`, `formatValue`, `formatAriaValue`, `disabled`,
 * `badgeWidth`. React Aria owns the full slider keyboard pattern
 * (Arrow/Home/End/PageUp/PageDown, step snapping) by construction.
 *
 * The left-of-thumb track fill is positioned from the live thumb
 * percentage. That single declaration is genuinely runtime-dynamic
 * (tracks `value`), so it carries a per-line documented
 * `no-restricted-syntax` disable — the sanctioned escape hatch
 * for an irreducible runtime style.
 *
 * Used in scenario configuration modals (Discretionary adjustment, Inflation,
 * Social Security claim assumptions, Life expectancy). Step is honoured
 * for the visible value via `formatValue` — callers pass a formatter
 * that understands the precision (e.g. `v.toFixed(1)` for 0.5 steps).
 */
import React, { useId } from 'react';
import {
  Slider,
  SliderThumb,
  SliderTrack,
} from 'react-aria-components';

export interface RangeSliderProps {
  id?: string;
  ariaLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (next: number) => void;
  /** Visible label to the right of the slider track (e.g. `+25%`,
   *  `3.5%`, `95 years`). Receives the snapped value. */
  formatValue: (value: number) => string;
  /** Spoken description for AT — e.g. `plus 25 percent`. Defaults to
   *  `formatValue(value)` if omitted. */
  formatAriaValue?: (value: number) => string;
  disabled?: boolean;
  /** Minimum width for the value badge. Defaults to `4.5rem` so the
   *  slider track length doesn't jitter as the digit count changes. */
  badgeWidth?: string;
}

const snapToStep = (
  raw: number,
  min: number,
  max: number,
  step: number,
): number => {
  if (!Number.isFinite(raw)) return min;
  const clamped = Math.max(min, Math.min(max, raw));
  const snapped = Math.round((clamped - min) / step) * step + min;
  // Avoid floating-point drift on 0.5-step sliders (e.g. 0.30000…).
  const decimals = step < 1 ? Math.max(0, Math.ceil(-Math.log10(step))) : 0;
  return Number(snapped.toFixed(decimals));
};

const TRACK_CLASS =
  'relative h-1.5 w-full rounded-full bg-line-strong';

// Matches the selected RadioOption indicator: a lime `bg-accent` circle
// with a `bg-accent-ink` inner dot (rather than a bordered surface circle,
// which read as a plain black dot in dark mode). The disabled dim lives on
// the whole `SliderTrack` (below), so the thumb ("ball") and the track
// fill ("line") fade together and always match.
const THUMB_CLASS =
  'top-1/2 flex size-4 items-center justify-center rounded-full bg-accent shadow ' +
  'outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring data-[focus-visible]:ring-offset-2 ' +
  'data-[disabled]:cursor-not-allowed';

export const RangeSlider: React.FC<RangeSliderProps> = ({
  id,
  ariaLabel,
  min,
  max,
  step,
  value,
  onChange,
  formatValue,
  formatAriaValue,
  disabled,
  badgeWidth = '4.5rem',
}) => {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  const display = formatValue(value);
  const ariaText = formatAriaValue ? formatAriaValue(value) : display;
  // Stable accessible NAME = `ariaLabel`; the formatted spoken VALUE is
  // a SEPARATE `aria-describedby` channel (frozen AT contract — a
  // stable label + a spoken value, NOT one merged name string). The
  // value text lives in a visually-hidden sibling OUTSIDE the RA
  // `<Slider>` group on purpose: an in-group `<SliderOutput>` is folded
  // by RA into the thumb's `aria-labelledby` (group ref), which would
  // merge the value back into the NAME — the exact regression this
  // fixes. The value stays visible in the badge below; this hidden
  // span is the AT description only.
  const outputId = useId();
  return (
    <div className="flex min-w-0 items-center gap-4">
      <span id={outputId} className="sr-only">
        {ariaText}
      </span>
      <Slider
        id={id}
        minValue={min}
        maxValue={max}
        step={step}
        value={value}
        isDisabled={disabled}
        onChange={(v) =>
          onChange(snapToStep(v as number, min, max, step))
        }
        className="min-w-0 flex-1"
      >
        <SliderTrack className="relative flex h-5 w-full items-center data-[disabled]:opacity-60">
          <div className={TRACK_CLASS}>
            {/* Runtime-dynamic track-fill width tracks the live thumb
                position — an irreducible runtime style (the React-Aria
                successor to the prior `--range-pct` exception). */}
            <div
              className="absolute h-1.5 rounded-full bg-accent"
              // eslint-disable-next-line no-restricted-syntax -- runtime track-fill width tracks the live slider value (irreducible runtime style: the fill follows the live thumb position)
              style={{ width: `${pct}%` }}
            />
          </div>
          {/* Stable accessible name (`ariaLabel`) on the thumb; the
              formatted spoken value rides the `aria-describedby`
              channel pointed at the visually-hidden value span above —
              the frozen native-build contract (a stable label PLUS a
              spoken value), not a merged name string. */}
          <SliderThumb
            aria-label={ariaLabel}
            aria-describedby={outputId}
            className={`absolute ${THUMB_CLASS}`}
          >
            <span
              aria-hidden
              className="size-1.5 rounded-full bg-accent-ink"
            />
          </SliderThumb>
        </SliderTrack>
      </Slider>
      <span
        className="inline-block text-right font-semibold tabular-nums text-muted"
        aria-hidden="true"
        // eslint-disable-next-line no-restricted-syntax -- runtime badge width measured from the longest formatted value to stop the slider jittering as digits change
        style={{ minWidth: badgeWidth }}
      >
        {display}
      </span>
    </div>
  );
};

export { snapToStep };
