// ReportPage page-level control and export wiring (not chart pixels): pickers, display-mode default from `retivo.balanceProjection.displayMode`, disabled un-projectable MC bases, Export disabled with progress while building, build-stage errors and cancel.
// The PDF lazy-loader is injected as a mock via `pdfLibLoader` so jsdom never imports real jsPDF.
import 'fake-indexeddb/auto';
import React from 'react';
import { act, render, screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllStores,
  clearSelectedScenario,
  writeSelectedScenario,
} from '../db/store';
import { SELECTED_SCENARIO_CHANGED_EVENT } from '../lib/scenario-mutations';
import { loadDemoData } from '../lib/demo-data-loader';
import { expectNoA11yViolations } from '../test/a11y';
import { ROUGH_BENCHMARK_ASSUMPTIONS } from '../lib/aca-ptc';
import { ThemeProvider } from '../contexts/ThemeContext';
import { BetaFeaturesProvider } from '../contexts/BetaFeaturesContext';
import { ReportPage } from './ReportPage';
import type { PdfLibLoader } from '../lib/pdf-export/lazy-load';
import { buildReportData } from '../lib/report-data';
import { buildPdfSectionModel } from '../lib/pdf-export/build-pdf';

type PdfLibs = Awaited<ReturnType<PdfLibLoader>>;

vi.mock('../lib/report-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/report-data')>();
  return {
    ...actual,
    buildReportData: vi.fn(actual.buildReportData),
  };
});

// Spy on the section-model assembly so the beta-feature tests can assert what the page asks the builder to leave out.
vi.mock('../lib/pdf-export/build-pdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pdf-export/build-pdf')>();
  return {
    ...actual,
    buildPdfSectionModel: vi.fn(actual.buildPdfSectionModel),
  };
});

// A jsPDF stub whose `svg2pdf` and `autoTable` are no-ops and whose `save` records the download; `throwInSvg2pdf` forces a build-stage failure.
function makeMockLoader(opts: { throwInSvg2pdf?: boolean } = {}): {
  loader: PdfLibLoader;
  saves: string[];
} {
  const saves: string[] = [];
  const jsPDFStub = vi.fn(function jsPDFCtor(this: Record<string, unknown>) {
    this.text = () => undefined;
    this.textWithLink = () => 0;
    this.addPage = () => undefined;
    this.save = (name: string) => {
      saves.push(name);
    };
    this.setFontSize = () => undefined;
    this.setFont = () => undefined;
    this.setPage = () => undefined;
    this.setFillColor = () => undefined;
    this.setTextColor = () => undefined;
    this.roundedRect = () => undefined;
    this.circle = () => undefined;
    this.getNumberOfPages = () => 1;
    this.splitTextToSize = (text: string) => [text];
  });
  const loader: PdfLibLoader = async () =>
    ({
      jsPDF: jsPDFStub as unknown as PdfLibs['jsPDF'],
      autoTable: (() => undefined) as unknown as PdfLibs['autoTable'],
      svg2pdf: ((async () => {
        if (opts.throwInSvg2pdf) throw new Error('svg2pdf boom');
      }) as unknown) as PdfLibs['svg2pdf'],
    });
  return { loader, saves };
}

function renderPage(loader?: PdfLibLoader): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/report']}>
      <ThemeProvider userId={null}>
        <BetaFeaturesProvider userId={null}>
          <ReportPage pdfLibLoader={loader} />
        </BetaFeaturesProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

async function seedProjectableWorkspace(): Promise<void> {
  await loadDemoData({
    householdId: 'hh-test',
    email: 'demo@example.test',
    displayName: 'Demo User',
  });
}

describe('ReportPage (Export PDF page)', () => {
  beforeEach(async () => {
    await clearAllStores();
    // clearAllStores preserves the selectedScenario pointer (production keeps it across a force-bootstrap), so reset it too or a pointer written in one test leaks into the next.
    await clearSelectedScenario();
    window.localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(async () => {
    cleanup();
    await clearAllStores();
    await clearSelectedScenario();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders the scenario, basis, and display-mode pickers', async () => {
    await seedProjectableWorkspace();
    const { container } = renderPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Export PDF' }),
    ).toBeInTheDocument();
    // Scenario and basis are React Aria Selects (button triggers with the field label); the display unit is a radiogroup.
    await waitFor(() =>
      expect(screen.getByLabelText('Scenario')).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Basis')).toBeInTheDocument();
    expect(
      screen.getByRole('radiogroup', { name: 'Display unit' }),
    ).toBeInTheDocument();
    // Wait for both assumptions panels: they are part of the accessibility scan.
    await screen.findByRole('heading', { name: 'Filing assumptions' });
    await screen.findByRole('heading', { name: 'Health coverage assumptions' });
    await expectNoA11yViolations(container);
  });

  it('passes full history-derived account metrics into report data', async () => {
    await seedProjectableWorkspace();
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Export PDF' });
    await waitFor(() => expect(vi.mocked(buildReportData)).toHaveBeenCalled());
    const latestCall = vi.mocked(buildReportData).mock.calls.at(-1);
    expect(latestCall).toBeDefined();
    const reportInput = latestCall?.[0];
    expect(reportInput?.accountMetricsById).toBeInstanceOf(Map);
    expect(reportInput?.accountMetricsById?.size).toBe(reportInput?.accounts.length);
    const metrics = [...(reportInput?.accountMetricsById?.values() ?? [])];
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics.some((metric) => metric.historicalReturnPct !== null)).toBe(true);
    expect(metrics[0]).toEqual(
      expect.objectContaining({
        ownerDisplayName: expect.any(String),
        totalContributions: expect.any(Number),
        totalGains: expect.any(Number),
        currentBalance: expect.any(Number),
      }),
    );
    expect(metrics[0]).toHaveProperty('currentBalanceTaxFree');
  });

  it("defaults the display mode from the retivo.balanceProjection.displayMode localStorage key", async () => {
    window.localStorage.setItem('retivo.balanceProjection.displayMode', 'future');
    await seedProjectableWorkspace();
    renderPage();
    const group = await screen.findByRole('radiogroup', { name: 'Display unit' });
    const future = within(group).getByRole('radio', { name: 'Future dollars' });
    await waitFor(() => expect(future).toBeChecked());
  });

  it("falls back to today's dollars when no display-mode preference is stored", async () => {
    await seedProjectableWorkspace();
    renderPage();
    const group = await screen.findByRole('radiogroup', { name: 'Display unit' });
    const today = within(group).getByRole('radio', { name: "Today's dollars" });
    await waitFor(() => expect(today).toBeChecked());
  });

  it('disables the un-projectable Monte Carlo bases in the basis picker', async () => {
    await seedProjectableWorkspace();
    const user = userEvent.setup();
    renderPage();
    const basis = await screen.findByLabelText('Basis');
    await user.click(basis);
    // With no MC run the representative runs are null, so each MC option is disabled.
    const typical = await screen.findByRole('option', { name: 'Typical' });
    expect(typical).toHaveAttribute('aria-disabled', 'true');
    const pessimistic = screen.getByRole('option', { name: 'Pessimistic' });
    expect(pessimistic).toHaveAttribute('aria-disabled', 'true');
  });

  it('disables the Export button and shows a progress bar while a build is in progress', async () => {
    await seedProjectableWorkspace();
    const user = userEvent.setup();
    // A loader that never resolves keeps the build in progress so the disabled/progress state can be observed.
    const neverResolves: PdfLibLoader = () => new Promise<PdfLibs>(() => undefined);
    renderPage(neverResolves);
    const exportBtn = await screen.findByRole('button', { name: 'Export PDF' });
    await waitFor(() => expect(exportBtn).not.toBeDisabled());
    await user.click(exportBtn);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export PDF' })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: /Building your PDF/i }),
    ).toBeInTheDocument();
  });

  it('omits the Projected withdrawals PDF section while that beta feature is hidden (the default)', async () => {
    await seedProjectableWorkspace();
    const user = userEvent.setup();
    const { loader, saves } = makeMockLoader();
    renderPage(loader);
    const exportBtn = await screen.findByRole('button', { name: 'Export PDF' });
    await waitFor(() => expect(exportBtn).not.toBeDisabled());
    await user.click(exportBtn);
    await waitFor(() => expect(saves).toHaveLength(1));
    const params = vi.mocked(buildPdfSectionModel).mock.calls.at(-1)?.[0];
    expect(params?.excludedSectionIds).toBeDefined();
    expect([...(params?.excludedSectionIds ?? [])]).toEqual(['table-withdrawal-guidance']);
    const model = vi.mocked(buildPdfSectionModel).mock.results.at(-1)?.value;
    expect(model.sections.map((s: { manifest: { id: string } }) => s.manifest.id)).not.toContain(
      'table-withdrawal-guidance',
    );
  });

  it('includes the Projected withdrawals PDF section once the beta feature is switched on', async () => {
    // The page renders with userId=null, so the anonymous preference key is the one the provider reads.
    window.localStorage.setItem('retivo.betaFeatures.anonymous', 'on');
    await seedProjectableWorkspace();
    const user = userEvent.setup();
    const { loader, saves } = makeMockLoader();
    renderPage(loader);
    const exportBtn = await screen.findByRole('button', { name: 'Export PDF' });
    await waitFor(() => expect(exportBtn).not.toBeDisabled());
    await user.click(exportBtn);
    await waitFor(() => expect(saves).toHaveLength(1));
    const params = vi.mocked(buildPdfSectionModel).mock.calls.at(-1)?.[0];
    expect(params?.excludedSectionIds?.size ?? 0).toBe(0);
    const model = vi.mocked(buildPdfSectionModel).mock.results.at(-1)?.value;
    expect(model.sections.map((s: { manifest: { id: string } }) => s.manifest.id)).toContain(
      'table-withdrawal-guidance',
    );
  });

  it('re-enables Export and surfaces an error (no partial download) when the build throws', async () => {
    await seedProjectableWorkspace();
    const user = userEvent.setup();
    const { loader, saves } = makeMockLoader({ throwInSvg2pdf: true });
    renderPage(loader);
    const exportBtn = await screen.findByRole('button', { name: 'Export PDF' });
    await waitFor(() => expect(exportBtn).not.toBeDisabled());
    await user.click(exportBtn);
    // A build throw inside svg2pdf shows an error alert and brings Export back, with no `save()` call (no partial download).
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/svg2pdf boom/i),
    );
    expect(
      screen.getByRole('button', { name: 'Export PDF' }),
    ).toBeInTheDocument();
    expect(saves).toHaveLength(0);
  });

  it('aborts cleanly and re-enables Export when the build is cancelled', async () => {
    await seedProjectableWorkspace();
    const user = userEvent.setup();
    const neverResolves: PdfLibLoader = () => new Promise<PdfLibs>(() => undefined);
    renderPage(neverResolves);
    const exportBtn = await screen.findByRole('button', { name: 'Export PDF' });
    await waitFor(() => expect(exportBtn).not.toBeDisabled());
    await user.click(exportBtn);
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    await user.click(cancel);
    // A user cancel tears the export down without surfacing an error.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Export PDF' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the filing assumptions + standing disclosures for the selected scenario', async () => {
    await seedProjectableWorkspace();
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Export PDF' });
    const panel = await screen.findByRole('note', { name: 'Filing assumptions' });
    expect(within(panel).getByText('While both spouses are alive')).toBeInTheDocument();
    expect(within(panel).getByText('After a spouse dies')).toBeInTheDocument();
    expect(panel).toHaveTextContent(/standard deduction is used every year/i);
    expect(panel).toHaveTextContent(/alternative minimum tax/i);
    expect(panel).toHaveTextContent(/not tax advice or a filing recommendation/i);
  });

  it('renders the health coverage assumptions + standing disclosures for the selected scenario', async () => {
    await seedProjectableWorkspace();
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Export PDF' });
    const panel = await screen.findByRole('note', { name: 'Health coverage assumptions' });
    expect(within(panel).getByText('Marketplace coverage')).toBeInTheDocument();
    expect(within(panel).getByText('Federal poverty guidelines')).toBeInTheDocument();
    expect(within(panel).getByText('Benchmark plan price')).toBeInTheDocument();
    expect(within(panel).getByText('Months of coverage')).toBeInTheDocument();
    expect(panel).toHaveTextContent(/rough estimate/i);
    expect(panel).toHaveTextContent(/not a quote from an exchange/i);
    expect(panel).toHaveTextContent(/base Medicare premium/i);
    expect(panel).toHaveTextContent(/not an eligibility determination/i);
    // The disclosure quotes the constant the engine prices from, so a recalibration cannot leave the text stale.
    expect(panel).toHaveTextContent(
      new RegExp(
        `\\$${ROUGH_BENCHMARK_ASSUMPTIONS.baseMonthlyDollars.toLocaleString('en-US')} a month for a ${ROUGH_BENCHMARK_ASSUMPTIONS.baseAge}-year-old`,
        'i',
      ),
    );
    expect(panel).toHaveTextContent(
      new RegExp(
        `From ${ROUGH_BENCHMARK_ASSUMPTIONS.baseYear}, the estimate grows every year at the scenario.s medical inflation rate`,
        'i',
      ),
    );
  });

  it('renders the market-stress assumptions and disclosures', async () => {
    await seedProjectableWorkspace();
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Export PDF' });
    const panel = await screen.findByRole('note', {
      name: 'Market stress assumptions',
    });
    expect(within(panel).getByText('Higher fees')).toBeInTheDocument();
    expect(within(panel).getByText('Lower returns')).toBeInTheDocument();
    expect(within(panel).getByText('Higher inflation')).toBeInTheDocument();
    expect(within(panel).getByText('Longer life')).toBeInTheDocument();
    expect(panel).toHaveTextContent(/investment cost 0\.5% a year higher/i);
    expect(panel).toHaveTextContent(/up to age 105/i);
    expect(panel).toHaveTextContent(/the same simulated market histories/i);
    expect(panel).toHaveTextContent(/illustrations, not forecasts/i);
    expect(panel).toHaveTextContent(/never move independently of it/i);
  });

  it('defaults the scenario pick from the selected-scenario pointer (narrow channel)', async () => {
    // The sidebar's active-scenario pointer drives the default pick; pre-seed a non-base scenario before mount.
    await seedProjectableWorkspace();
    await writeSelectedScenario({
      scenarioId: 'demo-scenario-early',
      updatedAt: new Date().toISOString(),
    });
    renderPage();
    const scenarioSelect = await screen.findByLabelText('Scenario');
    await waitFor(() =>
      expect(scenarioSelect).toHaveTextContent('Retire early at 62'),
    );
  });

  it('re-runs the pointer read on SELECTED_SCENARIO_CHANGED_EVENT without clobbering a resolved pick', async () => {
    // The selected-scenario event re-runs the pointer read, but the page preserves an already-resolved valid pick rather than override a user's explicit choice, so the export target stays stable mid-session.
    await seedProjectableWorkspace();
    renderPage();
    const scenarioSelect = await screen.findByLabelText('Scenario');
    await waitFor(() => expect(scenarioSelect).toHaveTextContent('Base'));

    await writeSelectedScenario({
      scenarioId: 'demo-scenario-early',
      updatedAt: new Date().toISOString(),
    });
    await act(async () => {
      window.dispatchEvent(new Event(SELECTED_SCENARIO_CHANGED_EVENT));
    });

    await waitFor(() => expect(scenarioSelect).toHaveTextContent('Base'));
    expect(scenarioSelect).not.toHaveTextContent('Retire early at 62');
  });
});
