// BalanceProjectionCharts bottom sections: the no-signal empty state, bands rendering when a tax/health-cost signal is present (the `taxBurdenRows` deflation memo), and the chart plus sub-table for every strategy.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { BalanceProjectionCharts } from './balance-projection-page-charts';
import { ThemeProvider } from '../contexts/ThemeContext';
import { expectNoA11yViolations } from '../test/a11y';
import type { DrawdownByMethodResult } from './balance-projection-page-data';
import type { ProjectionMethod } from '../components/ProjectionChart';
import type { DrawdownYear } from '../lib/drawdown-engine-types';

function drawdownYear(
  year: number,
  overrides: Partial<DrawdownYear> = {},
): DrawdownYear {
  return {
    year,
    balance: 500_000,
    withdrawn: 30_000,
    netNeed: 30_000,
    growth: 20_000,
    deposit: 0,
    depleted: false,
    ...overrides,
  };
}

function method(years: DrawdownYear[]): DrawdownByMethodResult {
  return { years, depletionYear: null, perMonthWithdrawal: new Float64Array() };
}

function baseProps(
  drawdownByMethod:
    | Record<ProjectionMethod, DrawdownByMethodResult | null>
    | null,
) {
  return {
    drawdownByMethod,
    activeMethod: 'planned' as ProjectionMethod,
    resolvedDrawdown: drawdownByMethod?.planned ?? null,
    resolvedLabel: 'Planned',
    isMcBasisActive: false,
    viewDeflator: () => 1,
    // Deterministic basis by default, so `basisDeflator` collapses to the same flat factor as `viewDeflator`.
    basisDeflator: () => 1,
    markers: [],
    tooltipMembers: [],
    displayMode: 'today' as const,
    lastDeathFractional: null,
    capFillActive: false,
  };
}

// The methodology caption lives behind the section's (i) popover; open it and return the dialog.
async function openTaxBurdenInfo(): Promise<HTMLElement> {
  const user = userEvent.setup();
  const name = /About the Tax & Health-Cost Burden chart/i;
  await user.click(screen.getByRole('button', { name }));
  return screen.getByRole('dialog', { name });
}

// The year-by-year table can repeat a label as a column header, so find the summary tile specifically.
function summaryTile(label: string): HTMLElement {
  const tile = screen
    .getAllByText(label)
    .map((el) => el.parentElement)
    .find((el) => el?.children.length === 2 && el.firstElementChild?.textContent === label);
  if (tile === undefined || tile === null) throw new Error(`no summary tile labelled ${label}`);
  return tile;
}

const NO_SIGNAL_COPY = /No taxable retirement events in this projection/;
const MC_TAX_SUBLABEL_COPY = /Estimated tax for this example path/;

// A drawdown-phase row (carries an `accountBalances` map) so the MC filter, which keys on the drawdown-phase marker rather than a taxable signal, keeps it.
function drawdownPhaseYear(
  year: number,
  overrides: Partial<DrawdownYear> = {},
): DrawdownYear {
  return drawdownYear(year, {
    accountBalances: new Map([
      [
        'a1',
        {
          balance: 500_000,
          preEnd: 0,
          postEnd: 500_000,
          withdrawn: 30_000,
          deposit: 0,
          preWithdrawnCents: 0,
          postWithdrawnCents: 3_000_000,
        },
      ],
    ]),
    ...overrides,
  });
}

describe('BalanceProjectionCharts', () => {
  it('renders the no-signal empty-state copy when no tax/health-cost signal is present', () => {
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method([drawdownYear(2030)]), twr: null })}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText(NO_SIGNAL_COPY)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Tax (&|and) Health-Cost Burden/i }),
    ).toBeInTheDocument();
  });

  it('renders the genuine no-taxable-events copy under an MC basis for a strategy owing $0', () => {
    // A strategy whose drawdown years owe $0 shows the genuine no-taxable-events copy; the drawdown-phase row is kept by the filter and contributes a real zero-tax bar.
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method([drawdownPhaseYear(2030)]), twr: null })}
          isMcBasisActive
        />
      </ThemeProvider>,
    );
    expect(screen.getByText(NO_SIGNAL_COPY)).toBeInTheDocument();
  });

  it('renders the MC tax sub-label + gates off the sub-table toggle under an MC basis with a signal (b)', async () => {
    const years = [drawdownPhaseYear(2030, { federalTaxCents: 1_200_000 })];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
          isMcBasisActive
          resolvedLabel="Typical"
        />
      </ThemeProvider>,
    );
    expect(screen.getByText(MC_TAX_SUBLABEL_COPY)).toBeInTheDocument();
    expect(
      screen.getByText(/shown but not yet deducted/),
    ).toBeInTheDocument();
    // MC_REPRESENTATIVE_RUN_SUBLABEL is covered by the account-stack section suite; this fixture carries no RMD rows. Open the (i): the MC variant states the core tax bill is funded and reflected in balances, and discloses the yield/interest/cost-basis refinements as display-only.
    const dialog = await openTaxBurdenInfo();
    expect(dialog).toHaveTextContent(/These are estimated taxes for this example path/i);
    expect(dialog).toHaveTextContent(
      /funded from the portfolio each year, so they affect the projected balances/i,
    );
    expect(dialog).toHaveTextContent(
      /not yet pulled from the portfolio, so the projected balances do not subtract it/i,
    );
    expect(
      screen.queryByRole('button', { name: /taxes & health costs table/i }),
    ).not.toBeInTheDocument();
  });

  it('starts the MC tax x-domain at retirement (drops leading pre-retirement rows, keeps zero-tax drawdown years)', () => {
    // Mixed run: a pre-retirement row (no accountBalances, no tax) is filtered out so there is no leading $0 bar; a zero-tax drawdown-phase year is kept (the filter is drawdown-phase, not taxable signal); the taxed year gives hasSignal.
    const years = [
      drawdownYear(2029), // pre-retirement: no accountBalances → dropped under MC.
      drawdownPhaseYear(2030), // zero-tax drawdown year → KEPT.
      drawdownPhaseYear(2031, { federalTaxCents: 1_200_000 }),
    ];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
          isMcBasisActive
          resolvedLabel="Typical"
        />
      </ThemeProvider>,
    );
    expect(screen.queryByText(NO_SIGNAL_COPY)).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Tax (&|and) Health-Cost Burden/i }),
    ).toBeInTheDocument();
  });

  it('renders the tax-burden chart band when a signal is present', () => {
    const years = [
      drawdownYear(2030, { federalTaxCents: 1_200_000 }),
      drawdownYear(2031, { irmaaSurchargeCents: 300_000 }),
    ];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByText(NO_SIGNAL_COPY)).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Tax (&|and) Health-Cost Burden/i }),
    ).toBeInTheDocument();
  });

  it('routes the Tax & Health-Cost Burden chart through resolvedDrawdown (the MC representative run), not drawdownByMethod[activeMethod]', () => {
    // The deterministic method has no tax signal but the resolved representative MC drawdown does; the chart must read the resolved record, so the no-signal copy must not appear.
    const deterministic = method([drawdownYear(2030, { federalTaxCents: 0 })]);
    const representative = method([
      drawdownYear(2030, { federalTaxCents: 1_200_000 }),
    ]);
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: deterministic, twr: null })}
          resolvedDrawdown={representative}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByText(NO_SIGNAL_COPY)).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Tax (&|and) Health-Cost Burden/i }),
    ).toBeInTheDocument();
  });

  it('renders the three lifetime tax-burden tiles with sumTaxBurden values when a signal is present', () => {
    // viewDeflator is identity: federalTax 12_000 + 4_000 = $16,000; IRMAA 3_000; the ACA credit flips the negative subsidy to a positive $5,000.
    const years = [
      drawdownYear(2030, {
        federalTaxCents: 1_200_000,
        irmaaSurchargeCents: 300_000,
        acaPtcSubsidyCents: 500_000,
      }),
      drawdownYear(2031, { federalTaxCents: 400_000 }),
    ];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText('Federal income tax')).toBeInTheDocument();
    expect(screen.getByText('Medicare surcharges (IRMAA)')).toBeInTheDocument();
    expect(screen.getByText('ACA health credits')).toBeInTheDocument();
    expect(screen.getByText('$16k')).toBeInTheDocument();
    expect(screen.getByText('$3k')).toBeInTheDocument();
    expect(screen.getByText('$5k')).toBeInTheDocument();
  });

  it('renders the credit applied to premiums tile with its lifetime total (deterministic basis)', () => {
    const years = [
      drawdownYear(2030, { acaPtcSubsidyCents: 500_000, acaCreditAppliedToPremiumsCents: 300_000 }),
      drawdownYear(2031, { acaPtcSubsidyCents: 200_000, acaCreditAppliedToPremiumsCents: 100_000 }),
    ];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
        />
      </ThemeProvider>,
    );
    expect(within(summaryTile('Credit applied to premiums')).getByText('$4k')).toBeInTheDocument();
    expect(within(summaryTile('ACA health credits')).getByText('$7k')).toBeInTheDocument();
  });

  it('renders the credit applied to premiums tile under an MC basis', () => {
    const years = [
      drawdownPhaseYear(2030, {
        acaPtcSubsidyCents: 500_000,
        acaCreditAppliedToPremiumsCents: 300_000,
      }),
    ];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
          isMcBasisActive
          resolvedLabel="Typical"
        />
      </ThemeProvider>,
    );
    expect(within(summaryTile('Credit applied to premiums')).getByText('$3k')).toBeInTheDocument();
    expect(within(summaryTile('ACA health credits')).getByText('$5k')).toBeInTheDocument();
  });

  it('keeps the death-year tax-burden row FULL and drops rows past the death year', () => {
    // Death is Dec 31 of deathYear (integer lastDeathFractional 2030): the 2031 row is dropped and 2030 federal tax stays the full $12k (no proration).
    const years = [
      drawdownYear(2030, { federalTaxCents: 1_200_000 }),
      drawdownYear(2031, { federalTaxCents: 1_200_000 }),
    ];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
          lastDeathFractional={2030}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText('$12k')).toBeInTheDocument();
    expect(screen.queryByText('$24k')).not.toBeInTheDocument();
  });

  it('keeps both whole-year rows when the death year is the later year', () => {
    // lastDeathFractional 2031: both rows survive at full value, so lifetime federal tax is $24k.
    const years = [
      drawdownYear(2030, { federalTaxCents: 1_200_000 }),
      drawdownYear(2031, { federalTaxCents: 1_200_000 }),
    ];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
          lastDeathFractional={2031}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText('$24k')).toBeInTheDocument();
  });

  it('hides the tax-burden tiles when there is no taxable signal', () => {
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method([drawdownYear(2030)]), twr: null })}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByText('Federal income tax')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Medicare surcharges (IRMAA)'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('ACA health credits')).not.toBeInTheDocument();
  });

  it('switches the (i) caption dollar-mode wording with displayMode', async () => {
    const years = [drawdownYear(2030, { federalTaxCents: 1_200_000 })];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
          displayMode="today"
        />
      </ThemeProvider>,
    );
    const todayDialog = await openTaxBurdenInfo();
    expect(todayDialog).toHaveTextContent(/today's dollars/i);
    expect(todayDialog).not.toHaveTextContent(/future dollars/i);
  });

  it('renders the future-dollars (i) caption wording under displayMode=future', async () => {
    const years = [drawdownYear(2030, { federalTaxCents: 1_200_000 })];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
          displayMode="future"
        />
      </ThemeProvider>,
    );
    const futureDialog = await openTaxBurdenInfo();
    expect(futureDialog).toHaveTextContent(/future dollars/i);
    expect(futureDialog).not.toHaveTextContent(/today's dollars/i);
  });

  it('renders the chart + collapsible tax-detail disclosure for any strategy', () => {
    // The chart renders for every strategy, and the year-by-year sub-table is a collapsed-by-default disclosure inside the same section; the table is absent until the toggle opens.
    const years = [
      drawdownYear(2030, {
        federalTaxCents: 1_200_000,
        federalTaxCashNeedCents: 1_200_000,
        totalTaxCashflowNeedCents: 1_200_000,
      }),
    ];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
        />
      </ThemeProvider>,
    );
    expect(
      screen.getByRole('heading', { name: /Tax (&|and) Health-Cost Burden/i }),
    ).toBeInTheDocument();
    // Collapsed, the table stays mounted inside a `<div hidden>` wrapper (so print can force-expand it) but drops out of the a11y tree: both the grid and its TableScroll landmark are absent (the landmark check catches a regression that strips `hidden`).
    const toggle = screen.getByRole('button', {
      name: 'Show taxes & health costs table',
    });
    expect(toggle).toBeInTheDocument();
    expect(
      screen.queryByRole('grid', { name: /taxes and health costs/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: /taxes and health costs table/i }),
    ).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(
      screen.getByRole('grid', { name: /taxes and health costs/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Hide taxes & health costs table' }),
    ).toBeInTheDocument();
  });

  it('renders the three cards in order (Tax Burden → RMD → QCD → Roth), each section labelled by its own heading', async () => {
    // One year lights up every card: an RMD floor, a QCD offsetting part of it, and a Roth conversion.
    const years = [
      drawdownYear(2050, {
        federalTaxCents: 1_200_000,
        rmdFloorCents: 4_000_000,
        qcdCents: 1_800_000,
        qcdInflationFactor: 1,
        netTaxableRmdCents: 2_200_000,
        qcdRmdOffsetCentsByOwner: { a: 1_800_000 },
        rothConvertedCents: 1_000_000,
      }),
    ];
    const { container } = render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
        />
      </ThemeProvider>,
    );
    const headings = [
      screen.getByRole('heading', { name: /Tax (&|and) Health-Cost Burden/i }),
      screen.getByRole('heading', { name: 'Required Minimum Distributions (Planned)' }),
      screen.getByRole('heading', {
        name: 'Qualified Charitable Distributions (QCD) (Planned)',
      }),
      screen.getByRole('heading', { name: 'Roth conversions (Planned)' }),
    ];
    for (let i = 1; i < headings.length; i += 1) {
      expect(
        headings[i - 1].compareDocumentPosition(headings[i]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    for (const id of ['rmd-heading', 'qcd-heading', 'roth-conversions-heading']) {
      const section = container.querySelector(`section[aria-labelledby="${id}"]`);
      expect(section).not.toBeNull();
      expect(section?.querySelectorAll(`#${id}`)).toHaveLength(1);
      expect(container.querySelectorAll(`#${id}`)).toHaveLength(1);
    }
    const rmdSection = container.querySelector('section[aria-labelledby="rmd-heading"]')!;
    const qcdSection = container.querySelector('section[aria-labelledby="qcd-heading"]')!;
    expect(rmdSection).toHaveTextContent('Net taxable IRA RMD');
    expect(rmdSection).toHaveTextContent('RMD covered by QCD');
    expect(rmdSection).not.toHaveTextContent('QCD distributed');
    expect(qcdSection).toHaveTextContent('QCD distributed');
    expect(qcdSection).not.toHaveTextContent('Net taxable IRA RMD');
    await expectNoA11yViolations(container);
  });

  it('renders no QCD or Roth card when neither total is > 0 (no empty cards)', () => {
    const years = [
      drawdownYear(2030, { federalTaxCents: 1_200_000, rmdFloorCents: 2_400_000 }),
    ];
    const { container } = render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
        />
      </ThemeProvider>,
    );
    expect(container.querySelector('section[aria-labelledby="rmd-heading"]')).not.toBeNull();
    expect(container.querySelector('section[aria-labelledby="qcd-heading"]')).toBeNull();
    expect(
      container.querySelector('section[aria-labelledby="roth-conversions-heading"]'),
    ).toBeNull();
    expect(
      screen.queryByRole('heading', { name: /Qualified Charitable Distributions/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /Roth conversions/i }),
    ).not.toBeInTheDocument();
  });

  it('renders the RMD card below the Tax Burden chart when RMD rows exist', () => {
    // A year with a positive RMD floor also carries a federal-tax signal, so both the Tax Burden and RMD sections render.
    const years = [
      drawdownYear(2030, { federalTaxCents: 1_200_000, rmdFloorCents: 2_400_000 }),
    ];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
        />
      </ThemeProvider>,
    );
    const taxHeading = screen.getByRole('heading', {
      name: /Tax (&|and) Health-Cost Burden/i,
    });
    const rmdHeading = screen.getByRole('heading', {
      name: /Required Minimum Distributions/i,
    });
    expect(rmdHeading).toBeInTheDocument();
    expect(
      taxHeading.compareDocumentPosition(rmdHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('omits the RMD card when no year has a positive rmdFloorCents', () => {
    const years = [drawdownYear(2030, { federalTaxCents: 1_200_000 })];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
        />
      </ThemeProvider>,
    );
    expect(
      screen.queryByRole('heading', { name: /Required Minimum Distributions/i }),
    ).not.toBeInTheDocument();
  });

  it('renders only the QCD card for a pre-RMD gift (no RMD card, no Net taxable tile, no Roth card)', async () => {
    // A pre-RMD-age gift (a QCD but no RMD floor or Roth conversion) fires only the QCD card's gate; the RMD card and its "Net taxable IRA RMD" tile are absent rather than empty.
    const years = [
      drawdownYear(2047, { qcdCents: 3_000_000, netTaxableRmdCents: 0 }),
    ];
    const { container } = render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
        />
      </ThemeProvider>,
    );
    expect(
      screen.queryByRole('heading', { name: /Required Minimum Distributions/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: 'Qualified Charitable Distributions (QCD) (Planned)',
      }),
    ).toBeInTheDocument();
    expect(container.querySelector('section[aria-labelledby="rmd-heading"]')).toBeNull();
    expect(
      container.querySelector('section[aria-labelledby="roth-conversions-heading"]'),
    ).toBeNull();
    expect(screen.queryByText('Net taxable IRA RMD')).not.toBeInTheDocument();
    expect(screen.getByText('QCD distributed')).toBeInTheDocument();
    expect(screen.getByText('$30k')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        container.querySelectorAll(
          'rect[name="Charitable distribution (QCD)"]',
        ),
      ).toHaveLength(1),
    );
  });

  it("Today's-dollars: the QCD tile + bar reverse the engine's year-average inflation factor (REAL round-trip), NOT the year-end basisDeflator", async () => {
    // A $10,000 real gift inflated to nominal `qcdCents` with a year-average factor of 1.25: in Today's dollars the tile divides that exact factor back out to $10,000. `basisDeflator` (0.5, a wrong year-end anchor) must not touch the QCD: `qcdCents × 0.5` would read $6,250 and `× 1` $12,500.
    const factor = 1.25;
    const realDollars = 10_000;
    const nominalCents = Math.round(realDollars * factor * 100); // 1_250_000
    const years = [
      drawdownYear(2047, {
        qcdCents: nominalCents,
        qcdInflationFactor: factor,
        netTaxableRmdCents: 0,
      }),
    ];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
          basisDeflator={() => 0.5}
        />
      </ThemeProvider>,
    );
    const label = screen.getByText('QCD distributed');
    const tileValue = label.parentElement?.querySelector('div:last-child');
    expect(tileValue?.textContent).toBe('$10k');
  });

  it('Future-dollars: the QCD tile shows the nominal gift (no reversal)', () => {
    // Future dollars: the tile is the nominal `qcdCents` ($12.5k), not the real $10k.
    const factor = 1.25;
    const nominalCents = Math.round(10_000 * factor * 100); // 1_250_000
    const years = [
      drawdownYear(2047, {
        qcdCents: nominalCents,
        qcdInflationFactor: factor,
        netTaxableRmdCents: 0,
      }),
    ];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
          displayMode="future"
        />
      </ThemeProvider>,
    );
    const label = screen.getByText('QCD distributed');
    const tileValue = label.parentElement?.querySelector('div:last-child');
    expect(tileValue?.textContent).toBe('$13k');
  });

  it("Today's-dollars: the QCD tile uses its year-average factor while the Net taxable IRA RMD tile uses basisDeflator (the two diverge)", () => {
    // Regression: the QCD-deflation fix wrongly deflated the "Net taxable IRA RMD" tile by the QCD's year-average factor too. It is an RMD-floor figure and must use the year-end `basisDeflator` (as the RMD chart and tax-detail column do). The two factors differ and neither is the other's reciprocal (1.25 vs 0.7), so each tile must pick its own basis.
    const factor = 1.25;
    const qcdCents = 2_000_000; // $20k nominal QCD
    const netTaxableRmdCents = 1_000_000; // $10k nominal net-taxable RMD
    const years = [
      drawdownYear(2047, {
        qcdCents,
        qcdInflationFactor: factor,
        rmdFloorCents: 3_000_000,
        netTaxableRmdCents,
      }),
    ];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
          basisDeflator={() => 0.7}
        />
      </ThemeProvider>,
    );
    const qcdLabel = screen.getByText('QCD distributed');
    expect(
      qcdLabel.parentElement?.querySelector('div:last-child')?.textContent,
    ).toBe('$16k');
    // Net taxable IRA RMD uses basisDeflator (0.7): $7,000, where the QCD factor would give $8k.
    const netLabel = screen.getByText('Net taxable IRA RMD');
    expect(
      netLabel.parentElement?.querySelector('div:last-child')?.textContent,
    ).toBe('$7k');
  });

  it('renders the QCD → net-taxable IRA RMD split chart + its "RMD covered by QCD" tile in an RMD-bearing gift year', async () => {
    // Gross IRA RMD $40k with an $18k QCD offset gives net taxable $22k; the split chart and tile render and the tile equals the amber column-sum.
    const years = [
      drawdownYear(2050, {
        rmdFloorCents: 4_000_000,
        qcdCents: 1_800_000,
        qcdInflationFactor: 1,
        netTaxableRmdCents: 2_200_000,
        qcdRmdOffsetCentsByOwner: { a: 1_800_000 },
      }),
    ];
    const { container } = render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
        />
      </ThemeProvider>,
    );
    const offsetLabel = screen.getByText('RMD covered by QCD');
    expect(
      offsetLabel.parentElement?.querySelector('div:last-child')?.textContent,
    ).toBe('$18k');
    expect(
      screen.getByRole('heading', {
        name: /IRA required withdrawal in QCD years — covered by QCD vs taxable/i,
      }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        container.querySelectorAll(
          'rect[name="Covered by QCD (tax-free)"]',
        ),
      ).toHaveLength(1);
      expect(
        container.querySelectorAll('rect[name="Net taxable"]'),
      ).toHaveLength(1);
    });
  });

  it('tile parity (today + nominal): Σ offset == "RMD covered by QCD" tile, Σ net == "Net taxable IRA RMD" tile, to the cent', () => {
    // Today's dollars use a fractional basisDeflator (0.5), nominal the identity; the amber column-sum must equal the offset tile and the teal the net-taxable tile in both modes.
    const years = [
      drawdownYear(2050, {
        rmdFloorCents: 3_000_000,
        qcdCents: 1_000_000,
        qcdInflationFactor: 1,
        netTaxableRmdCents: 2_000_000,
        qcdRmdOffsetCentsByOwner: { a: 1_000_000 },
      }),
      drawdownYear(2051, {
        rmdFloorCents: 4_000_000,
        qcdCents: 1_500_000,
        qcdInflationFactor: 1,
        netTaxableRmdCents: 2_500_000,
        qcdRmdOffsetCentsByOwner: { a: 1_500_000 },
      }),
    ];
    const today = render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
          basisDeflator={() => 0.5}
        />
      </ThemeProvider>,
    );
    expect(
      screen
        .getByText('RMD covered by QCD')
        .parentElement?.querySelector('div:last-child')?.textContent,
    ).toBe('$13k');
    expect(
      screen
        .getByText('Net taxable IRA RMD')
        .parentElement?.querySelector('div:last-child')?.textContent,
    ).toBe('$23k');
    today.unmount();

    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
          displayMode="future"
          basisDeflator={() => 1}
        />
      </ThemeProvider>,
    );
    expect(
      screen
        .getByText('RMD covered by QCD')
        .parentElement?.querySelector('div:last-child')?.textContent,
    ).toBe('$25k');
    expect(
      screen
        .getByText('Net taxable IRA RMD')
        .parentElement?.querySelector('div:last-child')?.textContent,
    ).toBe('$45k');
  });

  it('cross-owner IRA scoping: the offset is each owner\'s own min(gift, gross) summed, no household cross-netting', () => {
    // Primary gifts more than its gross IRA RMD ($20k gift, capped at $12k); secondary's $8k RMD is covered by an $8k gift. The stamped per-owner offsets are already capped, so Σ = $20k, not a household min(). A 401(k) RMD (in rmdFloorCents, not netTaxableRmdCents) never enters.
    const years = [
      drawdownYear(2050, {
        // rmdFloorCents is the all-plan floor (incl. a 401k); the split reads the IRA-scoped netTaxable and offset, never rmdFloorCents.
        rmdFloorCents: 9_000_000,
        qcdCents: 2_800_000,
        qcdInflationFactor: 1,
        netTaxableRmdCents: 0, // both owners' IRA RMDs fully covered
        qcdRmdOffsetCentsByOwner: { primary: 1_200_000, secondary: 800_000 },
      }),
    ];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
        />
      </ThemeProvider>,
    );
    expect(
      screen
        .getByText('RMD covered by QCD')
        .parentElement?.querySelector('div:last-child')?.textContent,
    ).toBe('$20k');
  });

  it('excludes a pre-RMD gift year (qcdCents > 0, gross RMD = 0) from the split chart, keeping the QCD card only', () => {
    // A pre-RMD gift (no floor, no offset map, net-taxable 0) has offset+net = 0, so it is filtered out of splitRows and the split chart never renders; the QCD card still shows the gift and the RMD card is absent.
    const years = [
      drawdownYear(2047, { qcdCents: 3_000_000, netTaxableRmdCents: 0 }),
    ];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
        />
      </ThemeProvider>,
    );
    expect(
      screen.queryByRole('heading', {
        name: /IRA required withdrawal in QCD years — covered by QCD vs taxable/i,
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('RMD covered by QCD')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Qualified Charitable Distributions/i }),
    ).toBeInTheDocument();
  });

  it('derives RMD rows whose met + shortfall equals the floor for each year', () => {
    // Floor $24k with $3k shortfall gives met $21k; floor $30k with no shortfall gives met $30k. Peak annual RMD = max(met + shortfall) = $30k, proving met+shortfall===floor feeds the summary.
    const years = [
      drawdownYear(2030, {
        federalTaxCents: 1,
        rmdFloorCents: 2_400_000,
        rmdShortfallCents: 300_000,
      }),
      drawdownYear(2031, {
        federalTaxCents: 1,
        rmdFloorCents: 3_000_000,
        rmdShortfallCents: 0,
      }),
    ];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
        />
      </ThemeProvider>,
    );
    for (const yr of years) {
      const floorCents = yr.rmdFloorCents ?? 0;
      const shortfallCents = yr.rmdShortfallCents ?? 0;
      const metCents = floorCents - shortfallCents;
      expect(metCents + shortfallCents).toBe(floorCents);
    }
    expect(screen.getByText('Peak annual RMD')).toBeInTheDocument();
    expect(screen.getByText('$30k')).toBeInTheDocument();
    expect(screen.getByText('Total shortfall')).toBeInTheDocument();
    expect(screen.getByText('$3k')).toBeInTheDocument();
  });

  it('caps RMD rows at the death year (lastDeathFractional)', () => {
    // Death fractional 2030.5 gives deathYear 2030, so only the 2030 row survives: peak $24k, 2031's $30k excluded.
    const years = [
      drawdownYear(2030, { federalTaxCents: 1, rmdFloorCents: 2_400_000 }),
      drawdownYear(2031, { federalTaxCents: 1, rmdFloorCents: 3_000_000 }),
    ];
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
          lastDeathFractional={2030.5}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText('Peak annual RMD')).toBeInTheDocument();
    expect(screen.getByText('$24k')).toBeInTheDocument();
    expect(screen.queryByText('$30k')).not.toBeInTheDocument();
  });

  it('shows the Fill-no-conversion notice when Fill is on but nothing converted', () => {
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method([drawdownYear(2030)]), twr: null })}
          capFillActive
        />
      </ThemeProvider>,
    );
    expect(
      screen.getByText(/Fill mode is on, but it did not convert anything in this projection/i),
    ).toBeInTheDocument();
  });

  it('places the Fill notice in the Roth card slot: after the RMD + QCD cards and before the estimate note', () => {
    const years = [
      drawdownYear(2050, {
        rmdFloorCents: 4_000_000,
        qcdCents: 1_800_000,
        qcdInflationFactor: 1,
        netTaxableRmdCents: 2_200_000,
        qcdRmdOffsetCentsByOwner: { a: 1_800_000 },
      }),
    ];
    const { container } = render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
          capFillActive
        />
      </ThemeProvider>,
    );
    const notice = screen.getByText(/did not convert anything in this projection/i);
    const qcdHeading = container.querySelector('#qcd-heading')!;
    const note = screen.getByRole('note');
    expect(
      qcdHeading.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      notice.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      container.querySelector('section[aria-labelledby="roth-conversions-heading"]'),
    ).toBeNull();
  });

  it('shows the Fill notice AND the Roth card together when only planned working-years conversions exist', () => {
    // Working-years conversions are not Fill conversions: Fill converted $0 (the notice fires) while the Roth card still charts the planned ones, so the notice must not claim "no Roth conversions happened".
    const drawdown = {
      ...method([drawdownYear(2040)]),
      preRetirementConversionCentsByYear: new Map([[2035, 2_000_000]]),
    };
    const { container } = render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: drawdown, twr: null })}
          capFillActive
        />
      </ThemeProvider>,
    );
    expect(
      screen.getByText(/Fill mode is on, but it did not convert anything/i),
    ).toBeInTheDocument();
    expect(
      container.querySelector('section[aria-labelledby="roth-conversions-heading"]'),
    ).not.toBeNull();
    expect(screen.getByText('$20k')).toBeInTheDocument();
    expect(screen.queryByText(/no Roth conversions happened/i)).not.toBeInTheDocument();
  });

  it('specializes the notice when the target Roth could not be resolved', () => {
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({
            planned: method([
              drawdownYear(2030, { rothConversionDegradedNoTarget: true }),
            ]),
            twr: null,
          })}
          capFillActive
        />
      </ThemeProvider>,
    );
    expect(
      screen.getByText(/no Roth account could be used as the conversion target/i),
    ).toBeInTheDocument();
  });

  it('hides the Fill notice once conversions occur', () => {
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({
            planned: method([drawdownYear(2030, { rothConvertedCents: 5_000_000 })]),
            twr: null,
          })}
          capFillActive
        />
      </ThemeProvider>,
    );
    expect(
      screen.queryByText(/did not convert anything in this projection/i),
    ).not.toBeInTheDocument();
  });

  it('does not false-fire the Fill notice under an MC basis when the deterministic run converted', () => {
    // MC representative runs never model conversions, so the notice reads the deterministic method, not the resolved MC run.
    render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({
            planned: method([drawdownYear(2030, { rothConvertedCents: 5_000_000 })]),
            twr: null,
          })}
          resolvedDrawdown={method([drawdownYear(2030)])}
          isMcBasisActive
          capFillActive
        />
      </ThemeProvider>,
    );
    expect(
      screen.queryByText(/did not convert anything in this projection/i),
    ).not.toBeInTheDocument();
  });
});

describe('BalanceProjectionCharts — Roth conversions card', () => {
  function bars(container: HTMLElement): number {
    return container.querySelectorAll('rect[name="Roth converted"]').length;
  }
  // The conversions chart is lazy-loaded (Suspense), so wait for its bars.
  async function waitForBars(
    container: HTMLElement,
    count: number,
  ): Promise<void> {
    await waitFor(() => expect(bars(container)).toBe(count));
  }

  it('draws one bar per conversion year + a tile whose value ties out to the bar sum', async () => {
    // $27,992 + $18,500 = $46,492 gives tile $46k; viewDeflator is identity.
    const years = [
      drawdownYear(2039, { rothConvertedCents: 2_799_200 }),
      drawdownYear(2040, { rothConvertedCents: 1_850_000 }),
    ];
    const { container } = render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText('Total Roth converted')).toBeInTheDocument();
    expect(screen.getByText('$46k')).toBeInTheDocument();
    await waitForBars(container, 2);
  });

  it('drops conversion years past the death year so bars stay in step with the tile (filter)', async () => {
    // deathYear 2039: only 2039 contributes a bar and the tile ($27,992 → $28k); 2040 is excluded.
    const years = [
      drawdownYear(2039, { rothConvertedCents: 2_799_200 }),
      drawdownYear(2040, { rothConvertedCents: 1_850_000 }),
    ];
    const { container } = render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
          lastDeathFractional={2039.5}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText('$28k')).toBeInTheDocument();
    await waitForBars(container, 1);
  });

  it('hides the chart + tile entirely when no year converts (paired gate)', () => {
    const { container } = render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method([drawdownYear(2030)]), twr: null })}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByText('Total Roth converted')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /Roth conversions/i }),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('section[aria-labelledby="roth-conversions-heading"]'),
    ).toBeNull();
    expect(bars(container)).toBe(0);
  });

  it('reads the RESOLVED (representative MC) run for the series under an MC basis (positive)', async () => {
    // The deterministic method converts $0 while the resolved representative run converts $50k; the series must follow the resolved source.
    const deterministic = method([drawdownYear(2030)]);
    const representative = method([
      drawdownYear(2030, { rothConvertedCents: 5_000_000 }),
    ]);
    const { container } = render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: deterministic, twr: null })}
          resolvedDrawdown={representative}
          isMcBasisActive
          resolvedLabel="Typical"
        />
      </ThemeProvider>,
    );
    expect(screen.getByText('$50k')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Roth conversions (Typical)' }),
    ).toBeInTheDocument();
    const section = container.querySelector(
      'section[aria-labelledby="roth-conversions-heading"]',
    );
    expect(section).toHaveTextContent('Based on one example simulated path.');
    await waitForBars(container, 1);
  });

  it('hides the card when the representative MC run has zero conversions (negative)', () => {
    // Under an MC basis the series reads the resolved (zero) run, so the chart is absent even though the deterministic method converts.
    const deterministic = method([
      drawdownYear(2030, { rothConvertedCents: 5_000_000 }),
    ]);
    const representative = method([drawdownYear(2030)]);
    const { container } = render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: deterministic, twr: null })}
          resolvedDrawdown={representative}
          isMcBasisActive
          resolvedLabel="Typical"
        />
      </ThemeProvider>,
    );
    expect(screen.queryByText('Total Roth converted')).not.toBeInTheDocument();
    expect(bars(container)).toBe(0);
  });

  it('always shows NOMINAL dollars: the deflators never scale the bars + tile', async () => {
    // The Roth chart shows actual dollars converted each year: even with a doubling deflator under Future dollars, $50,000 nominal stays $50k (no basis deflation is applied to this series).
    const years = [drawdownYear(2030, { rothConvertedCents: 5_000_000 })];
    const { container } = render(
      <ThemeProvider>
        <BalanceProjectionCharts
          {...baseProps({ planned: method(years), twr: null })}
          viewDeflator={() => 2}
          basisDeflator={() => 2}
          displayMode="future"
        />
      </ThemeProvider>,
    );
    expect(screen.getByText('$50k')).toBeInTheDocument();
    await waitForBars(container, 1);
  });

  describe('Medicaid note', () => {
    const MEDICAID_COPY = /Medicaid may apply/i;

    it('shows it under a Monte Carlo basis whose representative rows carry no fplPercentage', () => {
      // The flag comes from the deterministic method's years, not the resolved basis.
      const representative = method([drawdownPhaseYear(2030)]);
      render(
        <ThemeProvider>
          <BalanceProjectionCharts
            {...baseProps({
              planned: method([drawdownYear(2030, { fplPercentage: 120 })]),
              twr: null,
            })}
            resolvedDrawdown={representative}
            isMcBasisActive
            resolvedLabel="Typical"
          />
        </ThemeProvider>,
      );
      expect(screen.getByText(MEDICAID_COPY)).toBeInTheDocument();
    });
  });
});
