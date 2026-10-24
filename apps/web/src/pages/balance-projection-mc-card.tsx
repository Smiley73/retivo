/** One Monte Carlo tier card (Typical / Pessimistic / Bad-luck) per scope row: tier bar, scope and tier header, mono balance and funding status. The funded/depleted flip uses the shared horizonStatus helper so the card and the stress chart agree. */
import React from 'react';
import { formatCurrencyShort } from '../lib/format-currency';
import { CheckIcon } from '../components/icons';

export type McTier = 'typical' | 'pessimistic' | 'badluck';

export interface BalanceProjectionMcCardProps {
  readonly scope: string;
  readonly tier: McTier;
  readonly value: number | null;
  /** Omitted for the at-retirement row (always positive); `funded` true paints the green line, false the red "Depletes" line. */
  readonly status?: {
    readonly funded: boolean;
    /** Primary member's age at depletion when derivable from the birth year; falls back to depletionYear, then a bare "Depletes". */
    readonly depletionAge?: number | null;
    readonly depletionYear?: number | null;
  };
}

const TIER_LABEL: Record<McTier, string> = {
  typical: 'Typical',
  pessimistic: 'Pessimistic',
  badluck: 'Bad-luck',
};

// A background twin of the text color for the 3px tier bar (currentColor would inherit ink).
const TIER_BAR: Record<McTier, string> = {
  typical: 'bg-positive',
  pessimistic: 'bg-warning',
  badluck: 'bg-negative',
};

const CARD_CLASS =
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum `.mc` mock geometry (14px radius / 16px 18px 16px 20px padding); no default-scale token matches the spec'd pixel pads
  'relative overflow-hidden rounded-[14px] border border-line bg-surface-raised pb-4 pl-5 pr-[18px] pt-4 shadow-sm';

const BAR_CLASS =
  // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum `.mc-bar` mock geometry (3px rail width); no default-scale width token matches
  'absolute bottom-0 left-0 top-0 w-[3px]';

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
