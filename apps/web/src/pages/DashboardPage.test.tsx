/**
 * DashboardPage render tests for the Graphite Spectrum landing dashboard.
 *
 * The page's financial numbers all come from `useDashboardProjection`,
 * which internally runs the shared Balance Projection data-load +
 * pipeline + view-model (incl. the async Monte-Carlo worker). These
 * tests mock that hook at the module boundary — the same pattern the
 * projection-page tests use to keep the MC worker out of the render
 * path — so we can drive the page's section order / progress bar / chart
 * wiring + loading + empty states deterministically without spinning up
 * IndexedDB or the worker. The view-model math itself is covered by the
 * BalanceProjection page + lib unit tests; the plan-health block's and
 * plan-basics card's own render behaviour is covered by their own suites
 * (`DashboardPlanHealthBlock.test.tsx`, `DashboardPlanBasicsCard.test.tsx`).
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./use-dashboard-projection', () => ({
  useDashboardProjection: vi.fn(),
}));

// The per-year chart lazy-loads an SVG renderer; stub it so the page
// render stays synchronous (the chart engine is exercised elsewhere).
// Capture the last props so we can assert the Monte-Carlo overlay wiring
// (the dashboard always renders ProjectionChart — never the fan — and
// passes an `mcOverlay` only when a fresh MC result exists).
let lastProjectionChartProps: Record<string, unknown> | null = null;
vi.mock('../components/ProjectionChart', () => ({
  ProjectionChart: (props: Record<string, unknown>) => {
    lastProjectionChartProps = props;
    return <div data-testid="projection-chart" />;
  },
}));

import { useDashboardProjection } from './use-dashboard-projection';
import type {
  DashboardProjection,
  DashboardAllocationSlice,
  DashboardByTypeSlice,
} from './use-dashboard-projection';
import type { PlanStressTestVm } from '../components/PlanStressTestSection';
import { vm as buildStressVm } from '../components/__fixtures__/plan-stress-test-vm';
import { DashboardPage } from './DashboardPage';
import { expectNoA11yViolations } from '../test/a11y';

const mockHook = useDashboardProjection as unknown as ReturnType<typeof vi.fn>;

function makeVm(stressOverrides: Partial<PlanStressTestVm> = {}) {
  return {
    enabledCalculatedMethods: new Set<'twr'>(['twr']),
    displayRows: [],
    retirementMarkers: [],
    expenseChartMarkers: [],
    balanceProjectionChartMarkers: [],
    tooltipMembers: [{ firstName: 'Pat', birthYear: 1965 }],
    primaryRetirementYear: 2050,
    stressVm: buildStressVm(stressOverrides),
  } as unknown as DashboardProjection['vm'];
}

function setHook(value: Partial<DashboardProjection>): void {
  mockHook.mockReturnValue({
    ready: true,
    error: null,
    configError: null,
    accountCount: 3,
    netWorth: 1_446_030,
    annualSpend: 108_000,
    allocation: [
      { bucket: 'pretax', dollars: 561, share: 0.561 },
      { bucket: 'taxable', dollars: 285, share: 0.285 },
      { bucket: 'taxfree_roth', dollars: 100, share: 0.1 },
      { bucket: 'taxfree_hsa', dollars: 54, share: 0.054 },
    ] satisfies DashboardAllocationSlice[],
    allocationByType: [
      { category: 'retirement', dollars: 500, share: 0.5 },
      { category: 'roth', dollars: 80, share: 0.08 },
      { category: 'brokerage', dollars: 205, share: 0.205 },
      { category: 'hsa', dollars: 74, share: 0.074 },
      { category: 'cash', dollars: 141, share: 0.141 },
    ] satisfies DashboardByTypeSlice[],
    projectedAtRetirement: 3_570_000,
    vm: makeVm(),
    ...value,
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

/** Minimal fresh MC summary whose real-basis P50/P25 series feed the
 *  dashboard's two overlay lines. firstYear 2030 → values map onto the
 *  chart x = year + 1 convention inside ProjectionChartInner. */
function freshMcResult() {
  return {
    firstYear: 2030,
    percentilesReal: {
      p10: [10, 20, 30],
      p25: [11, 21, 31],
      p50: [12, 22, 32],
    },
  } as unknown as NonNullable<PlanStressTestVm['result']>;
}

/** Every DOCUMENT_POSITION_FOLLOWING check in one place: asserts each
 *  node in `nodes` precedes the next one in document order. */
function expectDocumentOrder(nodes: readonly Element[]): void {
  for (let i = 0; i < nodes.length - 1; i++) {
    expect(
      nodes[i].compareDocumentPosition(nodes[i + 1]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
}

describe('DashboardPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
    lastProjectionChartProps = null;
  });

  it('renders the page header + subtitle', () => {
    setHook({});
    renderPage();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Dashboard' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Where the household stands today and where the plan is heading.',
      ),
    ).toBeInTheDocument();
  });

  it.each([
    ['cached', 'sig-1'] as const,
    ['uncached', null] as const,
  ])(
    'renders the five sections in document order: header, plan-health block, disclaimer, three-up row, chart (%s)',
    (_label, stressPairSignature) => {
      setHook({
        vm: makeVm({ successPct: 92, successTier: 'success', stressPairSignature }),
      });
      renderPage();

      const heading = screen.getByRole('heading', { level: 1, name: 'Dashboard' });
      const blockHeading = screen.getByRole('heading', {
        name: 'Retirement readiness',
      });
      const disclaimer = screen.getByRole('note', {
        name: 'Retirement readiness disclaimer',
      });
      const basicsHeading = screen.getByRole('heading', { name: 'Plan basics' });
      const allocationHeading = screen.getByRole('heading', {
        name: /Portfolio allocation - by tax treatment/,
      });
      const byTypeHeading = screen.getByRole('heading', {
        name: /Portfolio allocation - by account type/,
      });
      const chartHeading = screen.getByRole('heading', {
        name: 'Balance projection',
      });

      expectDocumentOrder([
        heading,
        blockHeading,
        disclaimer,
        basicsHeading,
        allocationHeading,
        byTypeHeading,
        chartHeading,
      ]);
    },
  );

  it('renders the plan-health block hero % and the plan-basics card figures', () => {
    setHook({ vm: makeVm({ successPct: 92, successTier: 'success', stressPairSignature: 'sig-1' }) });
    renderPage();
    const blockHeading = screen.getByRole('heading', {
      name: 'Retirement readiness',
    });
    const block = blockHeading.closest('section') as HTMLElement;
    expect(block).toHaveTextContent('92%');

    const basicsHeading = screen.getByRole('heading', { name: 'Plan basics' });
    const basicsCard = basicsHeading.closest('section') as HTMLElement;
    expect(basicsCard).toHaveTextContent('Current net worth');
    expect(basicsCard).toHaveTextContent('$1.4M');
    expect(basicsCard).toHaveTextContent('Projected at retirement');
    expect(basicsCard).toHaveTextContent('$3.6M');
    expect(basicsCard).toHaveTextContent('2050');
  });

  it('shows "—" in the plan-health block while the MC worker is still computing', () => {
    setHook({ vm: makeVm({ stressPairSignature: null }) });
    renderPage();
    expect(
      screen.getByText('calculating plan success…'),
    ).toBeInTheDocument();
  });

  it('links to the full Balance Projection page', () => {
    setHook({});
    renderPage();
    const link = screen.getByRole('link', { name: /Open full projection/ });
    expect(link).toHaveAttribute('href', '/balance-projection');
  });

  it('renders the three-up row: plan basics, portfolio allocation, by account type', () => {
    setHook({});
    renderPage();
    expect(
      screen.getByRole('heading', { name: 'Plan basics' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: /Portfolio allocation - by tax treatment/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('56.1%')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: /Portfolio allocation - by account type/,
      }),
    ).toBeInTheDocument();
  });

  it('shows the page-level progress bar above the block while a run is in flight', () => {
    setHook({
      vm: makeVm({
        isRunning: true,
        progressDone: 6_200,
        progressTotal: 10_000,
      }),
    });
    renderPage();
    const bar = screen.getByRole('progressbar', {
      name: /Simulating market histories: 6,200 of 10,000 paths/i,
    });
    const blockHeading = screen.getByRole('heading', {
      name: 'Retirement readiness',
    });
    expectDocumentOrder([bar, blockHeading]);
  });

  it('omits the progress bar when no run is in flight', () => {
    setHook({ vm: makeVm({ isRunning: false }) });
    renderPage();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('omits the progress bar on a cache hit — a cache hit never sets status to running', () => {
    setHook({
      vm: makeVm({
        isRunning: false,
        result: freshMcResult(),
        stressPairSignature: 'sig-1',
      }),
    });
    renderPage();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('renders the small card and the real net worth on a config error, without the plan-health block', () => {
    setHook({
      vm: null,
      configError: 'This scenario mixes settings the projection cannot combine.',
      projectedAtRetirement: null,
    });
    renderPage();
    expect(
      screen.getByText(
        'This scenario mixes settings the projection cannot combine.',
      ),
    ).toBeInTheDocument();
    const basicsCard = screen
      .getByRole('heading', { name: 'Plan basics' })
      .closest('section') as HTMLElement;
    expect(basicsCard).toHaveTextContent('$1.4M');
    expect(
      screen.queryByRole('heading', { name: 'Retirement readiness' }),
    ).not.toBeInTheDocument();
  });

  it('shows a loading shell before the workspace read settles', () => {
    // `ready: false` = the initial IndexedDB read is still in flight. The
    // page must render the loading skeleton, never the empty-looking
    // populated branch (chart + "—" cards) or the no-accounts prompt.
    setHook({ ready: false, vm: null, projectedAtRetirement: null });
    renderPage();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('Loading your dashboard…')).toBeInTheDocument();
    expect(screen.queryByText(/No accounts yet/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('projection-chart')).not.toBeInTheDocument();
  });

  it('shows the set-up prompt when the household has no accounts', () => {
    setHook({ accountCount: 0, vm: null, projectedAtRetirement: null });
    renderPage();
    expect(screen.getByText(/No accounts yet/)).toBeInTheDocument();
    // Neither the plan-health block, the plan-basics card, nor the
    // progress bar render in the empty state.
    expect(
      screen.queryByRole('heading', { name: 'Retirement readiness' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Current net worth')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('surfaces a load error', () => {
    setHook({ error: 'Failed to load projection data.' });
    renderPage();
    expect(
      screen.getByText('Failed to load projection data.'),
    ).toBeInTheDocument();
  });

  it('overlays the fresh MC Typical (P50) + Pessimistic (P25) series on the projection chart', () => {
    setHook({
      vm: makeVm({
        successPct: 92,
        successTier: 'success',
        isStale: false,
        isRunning: false,
        result: freshMcResult(),
      }),
    });
    renderPage();
    // The dashboard always renders the deterministic ProjectionChart (never
    // the fan) and threads the MC overlay built from the real-basis bands.
    expect(screen.getByTestId('projection-chart')).toBeInTheDocument();
    expect(lastProjectionChartProps?.mcOverlay).toEqual({
      firstYear: 2030,
      typical: [12, 22, 32],
      pessimistic: [11, 21, 31],
    });
  });

  it('omits the MC overlay while the run is stale or still computing', () => {
    setHook({ vm: makeVm({ result: freshMcResult(), isStale: true }) });
    renderPage();
    expect(lastProjectionChartProps?.mcOverlay).toBeNull();
  });

  it('has no a11y violations (smoke)', async () => {
    setHook({
      vm: makeVm({ successPct: 92, successTier: 'success', stressPairSignature: 'sig-1' }),
    });
    const { container } = renderPage();
    await expectNoA11yViolations(container);
  });
});
