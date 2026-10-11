/**
 * Balance Projection page — Monte Carlo outcome card. One tier card in the
 * "Monte Carlo outcomes" 3-up grid (Typical / Pessimistic / Bad-luck),
 * rendered once per scope row (At retirement / At horizon). Mirrors the
 * Graphite Spectrum `.mc` mock: a left full-height tier bar, a scope +
 * tier header, the big mono balance value, and a green/red funding
 * status line.
 *
 * The data is the existing `PlanStressTestVm` percentile fields — this is
 * a presentation re-skin of the numbers the old "At retirement" / "At
 * horizon" `StatGrid` already showed, NOT a new computation. Depletion
 * ages come from the vm's per-tier `*DepletionYear`; the funded/depleted
 * flip routes through the shared `horizonStatus` helper so the card and the stress chart agree.
 */
import React from 'react';
import { formatCurrencyShort } from '../lib/format-currency';
import { CheckIcon } from '../components/icons';

/** Monte Carlo percentile tier. Drives the bar color + tag text. */
export type McTier = 'typical' | 'pessimistic' | 'badluck';

export interface BalanceProjectionMcCardProps {
  /** Scope label, e.g. "At retirement" / "At horizon". */
  readonly scope: string;
  readonly tier: McTier;
  /** Balance for this tier + scope; `null` renders an em dash. */
  readonly value: number | null;
  /**
   * Funding status line. Omitted for the at-retirement row (the at-
   * retirement balance is always positive). When supplied,
   * `funded` true paints the green "✓ Funds the full horizon" line and
   * false paints the red "Depletes — age N" / "Depletes" line.
   */
  readonly status?: {
    readonly funded: boolean;
    /**
     * Age the primary member reaches at depletion, when derivable from
     * the household birth year — renders "Depletes — age N" (the mock).
     * Falls back to `depletionYear` ("Depletes — 2089") when the age is
     * not derivable, and to a bare "Depletes" when neither is known.
     */
    readonly depletionAge?: number | null;
    readonly depletionYear?: number | null;
  };
}

const TIER_LABEL: Record<McTier, string> = {
  typical: 'Typical',
  pessimistic: 'Pessimistic',
  badluck: 'Bad-luck',
};

// Background twin used for the 3px tier bar (`currentColor` would inherit
// ink); the bar is a thin non-text accent so it rides the same token.
const TIER_BAR: Record<McTier, string> = {
  typical: 'bg-positive',
  pessimistic: 'bg-warning',
  badluck: 'bg-negative',
};

// `.mc` mock geometry: 14px radius, 16/18/16/20 padding, overflow-hidden
// so the absolutely-positioned left bar is clipped to the rounded corner.
const CARD_CLASS =
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum `.mc` mock geometry (14px radius / 16px 18px 16px 20px padding); no default-scale token matches the spec'd pixel pads
  'relative overflow-hidden rounded-[14px] border border-line bg-surface-raised pb-4 pl-5 pr-[18px] pt-4 shadow-sm';

// `.mc-bar` mock: 3px-wide left rail. Width is the only arbitrary value.
const BAR_CLASS =
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum `.mc-bar` mock geometry (3px rail width); no default-scale width token matches
  'absolute bottom-0 left-0 top-0 w-[3px]';

// `.mc-v` mock: 22px mono value with -.01em tracking.
const VALUE_CLASS =
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum `.mc-v` mock type scale (22px / -.01em tracking); no default-scale token matches
  'mt-2.5 font-mono text-[22px] font-bold leading-tight tracking-[-0.01em] tabular-nums text-ink';

export const BalanceProjectionMcCard: React.FC<BalanceProjectionMcCardProps> = ({
  scope,
  tier,
  value,
  status,
}) => {
  return (
    <div className={CARD_CLASS}>
      {/* Left 3px full-height tier bar (`.mc-bar`). */}
      <span aria-hidden="true" className={`${BAR_CLASS} ${TIER_BAR[tier]}`} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-muted">
          {scope} · {TIER_LABEL[tier]}
        </span>
      </div>
      <div className={VALUE_CLASS}>
        {value !== null ? formatCurrencyShort(value) : '—'}
      </div>
      {status && value !== null && (
        <div
          className={`mt-2 flex items-center gap-1 text-sm font-semibold ${
            status.funded ? 'text-positive' : 'text-negative'
          }`}
        >
          {status.funded ? (
            <>
              <CheckIcon />
              Funds the full horizon
            </>
          ) : status.depletionAge != null ? (
            `Depletes at age ${status.depletionAge}`
          ) : status.depletionYear != null ? (
            `Depletes in ${status.depletionYear}`
          ) : (
            'Depletes'
          )}
        </div>
      )}
    </div>
  );
};
