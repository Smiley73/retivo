/**
 * Shared range slider on React Aria `Slider`; the left-of-thumb fill is the one runtime-dynamic style and carries a
 * per-line disable.
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
  /** Visible label beside the track; receives the snapped value. */
  formatValue: (value: number) => string;
  /** Spoken value for AT; defaults to `formatValue(value)`. */
  formatAriaValue?: (value: number) => string;
  disabled?: boolean;
  /** Minimum badge width, so the track does not jitter as digits change. Defaults to `4.5rem`. */
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
  // Avoids floating-point drift on 0.5-step sliders.
  const decimals = step < 1 ? Math.max(0, Math.ceil(-Math.log10(step))) : 0;
  return Number(snapped.toFixed(decimals));
};

const TRACK_CLASS =
  'relative h-1.5 w-full rounded-full bg-line-strong';

// The disabled dim sits on the whole `SliderTrack`, so thumb and fill fade together.
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
  // The spoken value is a separate `aria-describedby` channel in a hidden sibling outside the RA
  // group: an in-group `SliderOutput` is folded into the thumb's `aria-labelledby` and would merge
  // the value into the name.
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
            <div
              className="absolute h-1.5 rounded-full bg-accent"
              // eslint-disable-next-line no-restricted-syntax -- runtime track-fill width tracks the live slider value (irreducible runtime style: the fill follows the live thumb position)
              style={{ width: `${pct}%` }}
            />
          </div>
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
