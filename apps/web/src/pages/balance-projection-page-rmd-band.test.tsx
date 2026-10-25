// RmdBand: summary tiles, the conditional shortfall / surplus / QCD-side tiles, the null gate when no RMD rows exist (even with QCD figures: the gift is a sibling card), the red shortfall segment and the QCD → net-taxable IRA RMD split chart.
// Roth conversions and the QCD gift chart are sibling cards and must not render here.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { RmdBand, type RmdBandProps } from './balance-projection-page-rmd-band';
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

const QCD_SIDE: Partial<RmdBandProps> = {
  hasQcd: true,
  totalNetTaxableRmd: 32_000,
  totalRmdOffset: 18_000,
  splitRows: SPLIT_ROWS,
};

const SPLIT_HEADING = /IRA required withdrawal in QCD years — covered by QCD vs taxable/i;
const OFFSET_BAR = 'rect[name="Covered by QCD (tax-free)"]';

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
    // The chart is lazy-loaded; await it.
    await waitFor(() =>
      expect(container.querySelectorAll('rect[name="RMD met"]')).toHaveLength(2),
    );
  });

  it('derives the first year, year count, peak annual requirement and total shortfall', () => {
    renderBand(WITH_SHORTFALL);
    const tile = (label: string) => screen.getByText(label).parentElement!;
    expect(tile('First RMD year')).toHaveTextContent('2030');
    expect(tile('Total RMD years')).toHaveTextContent('2');
    expect(tile('Peak annual RMD')).toHaveTextContent('$25k');
    expect(tile('Total shortfall')).toHaveTextContent('$3k');
  });

  it('renders nothing when there are no RMD rows', () => {
    const { container } = renderBand([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there are no RMD rows even when QCD figures are present', () => {
    // A pre-RMD-age gift: the QCD is a sibling card, and this card has no required withdrawal to describe, so it is absent rather than empty.
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
    // The tile stays inline while its explainer lives behind the card's (i).
    expect(screen.getByText('Total RMD surplus')).toBeInTheDocument();
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
    expect(dialog).toHaveTextContent(/The IRS requires a minimum withdrawal/i);
  });

  it('shows the Net taxable IRA RMD tile + its explainer only when the plan makes a QCD', async () => {
    // Without a QCD the tile and the net-taxable explainer are absent from the (i).
    const { unmount } = renderBand(NO_SHORTFALL, { totalNetTaxableRmd: 15_000 });
    expect(screen.queryByText('Net taxable IRA RMD')).not.toBeInTheDocument();
    const noDialog = await openInfo(RMD_INFO);
    expect(noDialog).not.toHaveTextContent(/Net taxable IRA RMD is the part/i);
    unmount();

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
    expect(screen.getByText('RMD covered by QCD')).toBeInTheDocument();
    expect(screen.getByText('$18k')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: SPLIT_HEADING }),
    ).toBeInTheDocument();
    expect(container.querySelectorAll('#qcd-rmd-split-heading')).toHaveLength(1);
    expect(container.querySelectorAll('#rmd-heading')).toHaveLength(1);
    await waitFor(() => {
      expect(container.querySelectorAll(OFFSET_BAR)).toHaveLength(2);
      expect(container.querySelectorAll('rect[name="Net taxable"]')).toHaveLength(2);
    });
  });

  it('surfaces the split-bar captions in the card (i) when the split chart renders', async () => {
    renderBand(NO_SHORTFALL, QCD_SIDE);
    const dialog = await openInfo(RMD_INFO);
    expect(dialog).toHaveTextContent(/The split bar covers the years you make a QCD/i);
    expect(dialog).toHaveTextContent(/the amber part your QCD covered/i);
    expect(dialog).toHaveTextContent(/The amber part is not always your whole QCD/i);
    expect(dialog).toHaveTextContent(
      /The Qualified Charitable Distributions card below shows the full amount you gave/i,
    );
    expect(dialog).toHaveTextContent(/“RMD covered by QCD”/);
    expect(dialog).not.toHaveTextContent(/your gift/i);
  });

  it('omits the split chart + tile when the QCD never overlaps an RMD year (no split rows, offset 0)', () => {
    // RMD years and a QCD exist but only in pre-RMD years: the net-taxable tile still renders (hasQcd), the split surface does not.
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
});
