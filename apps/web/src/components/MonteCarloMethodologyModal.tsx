/**
 * Success-probability explainer modal: what the number means, what varies and stays fixed across simulated paths, and
 * a plain-English limitations callout. Owns its open state and copy.
 */
import React, { useState } from 'react';
import { Button } from 'react-aria-components';
import { InfoCircleIcon } from './InfoCircleIcon';
import { Modal } from './Modal';

const SECTION_HEADING_CLASS =
  'mt-4 mb-1 text-sm font-semibold text-ink';
const BODY_CLASS = 'text-sm text-muted';
const LIMITATIONS_LIST_CLASS = 'mt-2 ml-5 list-disc text-sm text-muted';

export const MonteCarloMethodologyModal: React.FC = () => {
  const [open, setOpen] = useState(false);

  return (
    <span className="inline-flex items-center">
      <Button
        aria-label="How is success probability calculated?"
        onPress={() => setOpen(true)}
        className="inline-flex cursor-pointer items-center rounded text-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <InfoCircleIcon width={16} height={16} />
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="How success probability is calculated"
        size="3xl"
        scrollBodyLabel="Success probability methodology details"
      >
        <p className={BODY_CLASS}>
          The success probability is the share of 10,000 simulated retirement
          futures in which your portfolio still has money at the end of your
          plan horizon. A score of 85% means 8,500 of those futures ended with
          a positive balance.
        </p>

        <h3 className={SECTION_HEADING_CLASS}>What varies across simulations</h3>
        <p className={BODY_CLASS}>
          Each simulation draws a different sequence of historical monthly
          returns, equity and bond returns are sampled from the same historical
          month so their correlation is preserved. Inflation (CPI) is sampled
          from the same historical record and applied to your living expenses,
          so a run with high equity returns can still pair with high inflation.
        </p>

        <h3 className={SECTION_HEADING_CLASS}>What stays the same across simulations</h3>
        <p className={BODY_CLASS}>
          Most income amounts are pre-computed from your scenario settings and
          stay the same across simulations. Pension, annuity, and part-time
          income each carry a{' '}
          <em>Tracks scenario inflation</em>
          {' '}toggle: when off, the stream grows at the explicit COLA rate you
          set (e.g. 0% for a fixed pension). When on — and for Social Security
          in every scenario — the stream is adjusted to each path&apos;s
          realized inflation, so it varies slightly across simulations when
          that path&apos;s CPI departs from the scenario&apos;s expected rate.
        </p>

        <h3 className={SECTION_HEADING_CLASS}>Limitations</h3>
        <p className={BODY_CLASS}>
          Past market sequences are not a guarantee of future returns. Taxes
          are modeled in each path: the federal income tax, Medicare IRMAA,
          and ACA premium-tax-credit cashflow for that year is funded from the
          portfolio, so it lowers balances and can move the depletion year.
          That tax estimate is a single-pass approximation, not an exact
          filing: it does not re-solve withdrawals and tax together within a
          year, it routes each year's withdrawal by account tax treatment
          (pre-tax, Roth, taxable, cash-like) rather than re-optimizing the
          draw order, it computes each year's required minimum distribution
          (RMD) floor from each owner's own pre-tax (tax-deferred) account
          balances (so an RMD-age household is taxed on the full required
          minimum even when actual draws are lower, while a Roth-only or
          all-taxable household has no RMD floor and sees no phantom required
          income), and it funds the full IRMAA surcharge from the portfolio —
          choices that lean conservative (slightly higher tax). The model also
          does not capture sequence-of-returns risk specific to your drawdown
          order.
        </p>
        <p className={BODY_CLASS}>
          Simulated market histories are not a forecast. Past performance does
          not predict what your accounts will earn.
        </p>
        <p className="mt-3 text-sm font-medium text-ink">
          What this stress test does and does not model
        </p>
        <ul className={LIMITATIONS_LIST_CLASS}>
          <li>
            <strong className="font-semibold">
              Spending guardrails are modeled when you turn them on.
            </strong>{' '}
            With guardrails enabled, spending is cut after a bad stretch and
            restored after a good one inside every simulated path, and the
            success probability shown is the one with guardrails applied. With
            guardrails off, spending never reacts to a downturn.
          </li>
          <li>
            <strong className="font-semibold">
              10,000 paths carry their own sampling error.
            </strong>{' '}
            The success probability is an estimate from a finite sample, so
            re-running the same unchanged plan with a fresh sample typically
            moves it by well under a percentage point. Treat one-point
            differences between plans as noise, not signal.
          </li>
          <li>
            <strong className="font-semibold">
              Medical costs rise faster, but not more erratically.
            </strong>{' '}
            Expenses you flag as medical grow about 2 percentage points a year
            faster than general inflation, in every path. There is no separate
            medical-inflation surprise on top of that: medical costs move in
            lockstep with general inflation here, so the very worst outcomes
            for a medical-heavy household are understated.
          </li>
          <li>
            <strong className="font-semibold">
              The longer-life comparison stretches the plan, it does not rebuild
              it.
            </strong>{' '}
            When you compare against a longer life, the added years match the
            base run only up to the original end of your plan — past that point
            they use fresh market draws. In those added years Social Security
            and other income repeat their last dollar amount with no further
            cost-of-living increase, so their buying power falls, and the plan
            keeps whichever tax return it was already filing rather than working
            out a new one. Together these make the added years an estimate
            rather than an exact re-run: the repeated income buys less over
            time, while keeping the earlier tax return and drawing fresh market
            years can each move the result in either direction.
          </li>
          <li>
            <strong className="font-semibold">
              Clustered history, monthly-average prices.
            </strong>{' '}
            Each simulated future is built from consecutive multi-month
            stretches of real history sampled together, so booms and busts
            cluster into the kind of sustained good and bad streaks markets
            actually have. The underlying Shiller series still uses
            monthly-average prices, which understate true month-to-month swings
            by roughly 10–20%, so this stress test slightly understates downside
            volatility.
          </li>
          <li>
            <strong className="font-semibold">
              Inflation framing trims real returns.
            </strong>{' '}
            Inflation is mean-centered on your scenario rate and combined with
            returns in a way that, after annualizing, slightly reduces the
            modeled real (inflation-adjusted) return — another conservative
            lean.
          </li>
        </ul>
      </Modal>
    </span>
  );
};
