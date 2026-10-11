/**
 * RmdBand — render + summary-stat + null-gate + a11y smoke.
 *
 * Covers the card's own derivation surface: the summary tiles
 * (`summarizeRmd`), the conditional shortfall / surplus / QCD-side tiles,
 * the null gate when no RMD rows exist (even when QCD figures are present —
 * the gift itself is a sibling card), the red shortfall bar segment, and the
 * QCD → net-taxable IRA RMD split chart under its own sub-heading. Roth
 * conversions and the QCD gift chart are sibling cards and must NOT render
 * here.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  RmdBand,
  summarizeRmd,
  type RmdBandProps,
} from './balance-projection-page-rmd-band';
import type { RmdChartRow } from '../components/RmdChart';
import type { QcdRmdSplitRow } from '../components/QcdRmdSplitChart';
import { ThemeProvider } from '../contexts/ThemeContext';
import { expectNoA11yViolations } from '../test/a11y';
import { CHART_COLORS } from '../lib/tokens';

function renderBand(
  rows: RmdChartRow[],
  overrides: Partial<Omit<RmdBandProps, 'rows'>> = {},
) {
  return render(
    <ThemeProvider>
      <RmdBand rows={rows} methodLabel="Planned" {...overrides} />
    </ThemeProvider>,
  );
}

/** Open the card's `(i)` info popover by its accessible button name and
 *  return the opened dialog (the methodology prose lives inside it). */
async function openInfo(name: RegExp): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name }));
  return screen.getByRole('dialog', { name });
}

const RMD_INFO = /Required Minimum Distributions/i;

const NO_SHORTFALL: RmdChartRow[] = [
  { year: 2030, rmdMet: 20_000, rmdShortfall: 0, rmdRetained: 0 },
  { year: 2031, rmdMet: 25_000, rmdShortfall: 0, rmdRetained: 0 },
];

const WITH_SHORTFALL: RmdChartRow[] = [
  { year: 2030, rmdMet: 20_000, rmdShortfall: 0, rmdRetained: 0 },
  { year: 2031, rmdMet: 22_000, rmdShortfall: 3_000, rmdRetained: 0 },
];

const SPLIT_ROWS: QcdRmdSplitRow[] = [
  { year: 2030, rmdOffsetDollars: 10_000, netTaxableDollars: 20_000 },
  { year: 2031, rmdOffsetDollars: 8_000, netTaxableDollars: 12_000 },
];

/** Every conditional QCD-side figure present (a QCD that offsets an RMD). */
const QCD_SIDE: Partial<RmdBandProps> = {
  hasQcd: true,
  totalNetTaxableRmd: 32_000,
  totalRmdOffset: 18_000,
  splitRows: SPLIT_ROWS,
};

const SPLIT_HEADING = /IRA required withdrawal in QCD years — covered by QCD vs taxable/i;
const OFFSET_BAR = 'rect[name="Covered by QCD (tax-free)"]';

describe('summarizeRmd', () => {
  it('derives first year, count, peak, shortfall, and surplus', () => {
    expect(summarizeRmd(WITH_SHORTFALL, 12_345)).toEqual({
      firstYear: 2030,
      totalYears: 2,
      peakAnnual: 25_000, // 22_000 + 3_000 for 2031
      totalShortfall: 3_000,
      totalSurplus: 12_345,
      totalNetTaxableRmd: 0,
      totalRmdOffset: 0,
    });
  });

  it('carries the net-taxable-RMD + RMD-offset totals through', () => {
    const s = summarizeRmd(NO_SHORTFALL, 0, 15_000, 8_000);
    expect(s.totalNetTaxableRmd).toBe(15_000);
    expect(s.totalRmdOffset).toBe(8_000);
  });

  it('defaults the optional totals to 0 when omitted', () => {
    const s = summarizeRmd(WITH_SHORTFALL);
    expect(s.totalSurplus).toBe(0);
    expect(s.totalNetTaxableRmd).toBe(0);
    expect(s.totalRmdOffset).toBe(0);
  });

  it('returns a null first year and zeroed figures for empty rows', () => {
    expect(summarizeRmd([])).toEqual({
      firstYear: null,
      totalYears: 0,
      peakAnnual: 0,
      totalShortfall: 0,
      totalSurplus: 0,
      totalNetTaxableRmd: 0,
      totalRmdOffset: 0,
    });
  });
});

describe('RmdBand', () => {
  it('renders the summary stat row + chart bars for a scenario with RMD years', async () => {
    const { container } = renderBand(NO_SHORTFALL);
    expect(
      screen.getByRole('heading', { name: 'Required Minimum Distributions (Planned)' }),
    ).toBeInTheDocument();
    expect(screen.getByText('First RMD year')).toBeInTheDocument();
    expect(screen.getByText('2030')).toBeInTheDocument();
    expect(screen.getByText('Total RMD years')).toBeInTheDocument();
    expect(screen.getByText('Peak annual RMD')).toBeInTheDocument();
    expect(container.querySelectorAll('#rmd-heading')).toHaveLength(1);
    // Both years render a met segment (chart is lazy-loaded — await it).
    await waitFor(() =>
      expect(container.querySelectorAll('rect[name="RMD met"]')).toHaveLength(2),
    );
  });

  it('renders nothing when there are no RMD rows', () => {
    const { container } = renderBand([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there are no RMD rows even when QCD figures are present', () => {
    // A pre-RMD-age gift: the QCD itself is a sibling card; this card has no
    // required withdrawal to describe, so it is absent rather than empty.
    const { container } = renderBand([], { hasQcd: true, totalNetTaxableRmd: 0 });
    expect(container).toBeEmptyDOMElement();
  });

  it('omits the shortfall stat when total shortfall is zero', () => {
    renderBand(NO_SHORTFALL);
    expect(screen.queryByText('Total shortfall')).not.toBeInTheDocument();
  });

  it('shows the shortfall stat + a red shortfall bar segment when shortfall > 0', async () => {
    const { container } = renderBand(WITH_SHORTFALL);
    expect(screen.getByText('Total shortfall')).toBeInTheDocument();
    const shortfallBars = await waitFor(() => {
      const bars = container.querySelectorAll('rect[name="Shortfall"]');
      expect(bars).toHaveLength(1);
      return bars;
    });
    expect(shortfallBars[0].getAttribute('fill')).toBe(
      CHART_COLORS.light.rmdShortfall,
    );
  });

  it('renders the MC sub-label under the title when given', () => {
    renderBand(NO_SHORTFALL, {
      methodLabel: 'Typical',
      subLabel: 'Based on one example simulated path.',
    });
    expect(
      screen.getByRole('heading', { name: 'Required Minimum Distributions (Typical)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Based on one example simulated path.'),
    ).toBeInTheDocument();
  });

  it('keeps the RMD surplus tile inline; renders its explainer inside the (i) at the 1-cent boundary', async () => {
    renderBand(NO_SHORTFALL, { totalSurplus: 0.01 });
    // Tile stays inline.
    expect(screen.getByText('Total RMD surplus')).toBeInTheDocument();
    // Explainer is not inline — it lives behind the card (i).
    expect(
      screen.queryByText(/Total RMD surplus is the lifetime total/i),
    ).not.toBeInTheDocument();
    const dialog = await openInfo(RMD_INFO);
    expect(dialog).toHaveTextContent(/Total RMD surplus is the lifetime total/i);
  });

  it('omits the RMD surplus explainer from the popover when surplus is 0; tile stays absent (boundary)', async () => {
    renderBand(NO_SHORTFALL, { totalSurplus: 0 });
    expect(screen.queryByText('Total RMD surplus')).not.toBeInTheDocument();
    const dialog = await openInfo(RMD_INFO);
    expect(dialog).not.toHaveTextContent(/Total RMD surplus is the lifetime total/i);
    // The always-on main RMD caption is present in the popover.
    expect(dialog).toHaveTextContent(/The IRS requires a minimum withdrawal/i);
  });

  it('shows the Net taxable IRA RMD tile + its explainer only when the plan makes a QCD', async () => {
    // No QCD → tile absent + the net-taxable explainer absent from the (i).
    const { unmount } = renderBand(NO_SHORTFALL, { totalNetTaxableRmd: 15_000 });
    expect(screen.queryByText('Net taxable IRA RMD')).not.toBeInTheDocument();
    const noDialog = await openInfo(RMD_INFO);
    expect(noDialog).not.toHaveTextContent(/Net taxable IRA RMD is the part/i);
    unmount();

    // QCD present → tile renders with the deflated lifetime figure + explainer.
    renderBand(NO_SHORTFALL, { hasQcd: true, totalNetTaxableRmd: 15_000 });
    expect(screen.getByText('Net taxable IRA RMD')).toBeInTheDocument();
    expect(screen.getByText('$15k')).toBeInTheDocument();
    const dialog = await openInfo(RMD_INFO);
    expect(dialog).toHaveTextContent(
      /Net taxable IRA RMD is the part of your traditional IRA's required minimum/i,
    );
  });

  it('never renders the Roth conversions or QCD gift surfaces (they are sibling cards)', async () => {
    const { container } = renderBand(WITH_SHORTFALL, {
      totalSurplus: 5_000,
      ...QCD_SIDE,
    });
    expect(screen.queryByText('Total Roth converted')).not.toBeInTheDocument();
    expect(screen.queryByText('QCD distributed')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /Roth conversions/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /Charitable distributions/i }),
    ).not.toBeInTheDocument();
    expect(container.querySelectorAll('#roth-conversions-heading')).toHaveLength(0);
    expect(container.querySelectorAll('#qcd-heading')).toHaveLength(0);
    expect(container.querySelectorAll('rect[name="Roth converted"]')).toHaveLength(0);
    expect(
      container.querySelectorAll('rect[name="Charitable distribution (QCD)"]'),
    ).toHaveLength(0);
    const dialog = await openInfo(RMD_INFO);
    expect(dialog).not.toHaveTextContent(/Total Roth converted is the lifetime amount/i);
    expect(dialog).not.toHaveTextContent(/QCD distributed is the lifetime amount/i);
  });

  it('has no a11y violations (all conditional tiles present)', async () => {
    const { container } = renderBand(WITH_SHORTFALL, {
      totalSurplus: 5_000,
      ...QCD_SIDE,
    });
    await expectNoA11yViolations(container);
  });
});

describe('RmdBand — QCD → net-taxable IRA RMD split chart', () => {
  it('renders the split chart + its own heading + the "RMD covered by QCD" tile', async () => {
    const { container } = renderBand(NO_SHORTFALL, QCD_SIDE);
    // The tile renders (gated on totalRmdOffset > 0).
    expect(screen.getByText('RMD covered by QCD')).toBeInTheDocument();
    expect(screen.getByText('$18k')).toBeInTheDocument();
    // The split chart owns its own distinct heading id.
    expect(
      screen.getByRole('heading', { name: SPLIT_HEADING }),
    ).toBeInTheDocument();
    expect(container.querySelectorAll('#qcd-rmd-split-heading')).toHaveLength(1);
    // rmd-heading stays unique (the split bar never re-uses it).
    expect(container.querySelectorAll('#rmd-heading')).toHaveLength(1);
    await waitFor(() => {
      expect(container.querySelectorAll(OFFSET_BAR)).toHaveLength(2);
      expect(container.querySelectorAll('rect[name="Net taxable"]')).toHaveLength(2);
    });
  });

  it('surfaces the split-bar captions in the card (i) when the split chart renders', async () => {
    renderBand(NO_SHORTFALL, QCD_SIDE);
    const dialog = await openInfo(RMD_INFO);
    // The caption states the QCD-years-only scope up front.
    expect(dialog).toHaveTextContent(/The split bar covers the years you make a QCD/i);
    // The offset slice is amber (its own hue) and the connecting note
    // points at the sibling QCD card for the full gift.
    expect(dialog).toHaveTextContent(/the amber part your QCD covered/i);
    expect(dialog).toHaveTextContent(/The amber part is not always your whole QCD/i);
    expect(dialog).toHaveTextContent(
      /The Qualified Charitable Distributions card below shows the full amount you gave/i,
    );
    // The renamed tile is quoted by its new name; "your gift" is gone.
    expect(dialog).toHaveTextContent(/“RMD covered by QCD”/);
    expect(dialog).not.toHaveTextContent(/your gift/i);
  });

  it('omits the split chart + tile when the QCD never overlaps an RMD year (no split rows, offset 0)', () => {
    // RMD years exist and a QCD exists, but only in pre-RMD years: the
    // net-taxable tile still renders (hasQcd), the split surface does not.
    const { container } = renderBand(NO_SHORTFALL, {
      hasQcd: true,
      totalNetTaxableRmd: 45_000,
      totalRmdOffset: 0,
      splitRows: [],
    });
    expect(screen.getByText('Net taxable IRA RMD')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: SPLIT_HEADING }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('RMD covered by QCD')).not.toBeInTheDocument();
    expect(container.querySelectorAll('#qcd-rmd-split-heading')).toHaveLength(0);
  });

  it('omits the split-bar captions from the (i) when the split chart is absent', async () => {
    renderBand(NO_SHORTFALL, { hasQcd: true, totalNetTaxableRmd: 45_000 });
    const dialog = await openInfo(RMD_INFO);
    expect(dialog).not.toHaveTextContent(/The split bar covers/i);
  });

  it('has no a11y violations with the split chart + tile present', async () => {
    const { container } = renderBand(NO_SHORTFALL, QCD_SIDE);
    await expectNoA11yViolations(container);
  });
});
