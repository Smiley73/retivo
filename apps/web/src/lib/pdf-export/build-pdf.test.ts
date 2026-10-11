import { describe, expect, it, vi } from 'vitest';
import { buildAndDownloadPdf, buildPdfSectionModel } from './build-pdf';
import { PDF_SECTION_MANIFEST } from './section-manifest';
import type { PdfLibs } from './lazy-load';
import type { ReportData } from '../report-data';
import type { YearlyTableRow } from '../../pages/balance-projection-page-yearly';
import { ONE_LINE_DISCLAIMER, REPORT_DISCLAIMER } from '../disclaimer-fragments';
import { jsPDF } from 'jspdf';
import { APP_NAME, OPEN_SOURCE_TEXT, REPO_HOST_PATH, REPO_URL } from '../brand';

function emptyReportData(scenarioName: string): ReportData {
  return {
    overview: {
      householdName: scenarioName,
      members: [],
      totalCurrentPortfolio: 0,
      annualContributionRunRate: 0,
      estimatedAnnualOtherIncome: 0,
    },
    accounts: [],
  taxProfileDisclosures: [],
    rothTaxFreeAmounts: [],
    expenses: [],
    incomeStreams: [],
    socialSecurity: [],
    scenarios: [],
  };
}

const yearRows: YearlyTableRow[] = [
  {
    year: 2040,
    isCashflowYear: true,
    balanceByMethod: { planned: 1000, twr: 2000 },
    earned: 0,
    withdrawal: 40000,
    totalIncome: 50000,
    expenses: 60000,
    shortfall: 0,
    gains: 5000,
    gainsBreakdown: null,
  },
];

function buildModel(
  scenarioName: string,
  reportData = emptyReportData(scenarioName),
  chartTablesBySection?: ReadonlyMap<string, { head: string[][]; body: string[][] }>,
) {
  return buildPdfSectionModel({
    scenarioName,
    activeMcBasis: 'mc-typical',
    activeMethod: 'planned',
    displayMode: 'today',
    unifiedYearTableRows: yearRows,
    portfolioFlowsByYear: null,
    reportData,
    date: { year: 2026, month: 6, day: 20 },
    chartTablesBySection,
  });
}

interface RecordedTextCall {
  readonly value: unknown;
  readonly x: number;
  readonly y: number;
  readonly page: number;
}

interface RecordedAutoTableCall {
  readonly page: number;
  readonly options: {
    readonly head?: string[][];
    readonly body?: string[][];
    readonly foot?: string[][];
    readonly startY?: number;
    readonly showFoot?: string;
    readonly footStyles?: unknown;
    readonly styles?: unknown;
  };
}

function createRenderHarness(
  splitTextToSize: (text: string, width: number) => string[] = (text) => [text],
) {
  let pageCount = 1;
  let currentPage = 1;
  const textCalls: RecordedTextCall[] = [];
  const autoTableCalls: RecordedAutoTableCall[] = [];
  const docStub = {
    text: vi.fn((value: unknown, x: number, y: number) => {
      textCalls.push({ value, x, y, page: currentPage });
    }),
    textWithLink: vi.fn(),
    addPage: vi.fn(() => {
      pageCount += 1;
      currentPage = pageCount;
    }),
    save: vi.fn(),
    setFontSize: vi.fn(),
    setFont: vi.fn(),
    setPage: vi.fn((page: number) => {
      currentPage = page;
    }),
    setFillColor: vi.fn(),
    setTextColor: vi.fn(),
    roundedRect: vi.fn(),
    circle: vi.fn(),
    getNumberOfPages: vi.fn(() => pageCount),
    splitTextToSize: vi.fn(splitTextToSize),
    lastAutoTable: undefined as { finalY?: number } | undefined,
  };
  const jsPDFStub = vi.fn(function jsPDFCtor(this: unknown) {
    return docStub;
  });
  const autoTableStub = vi.fn(
    (_doc: unknown, options: RecordedAutoTableCall['options']) => {
      autoTableCalls.push({ page: currentPage, options });
      const rowCount = Math.max(1, options.body?.length ?? 0);
      docStub.lastAutoTable = {
        finalY: (options.startY ?? 40) + rowCount * 14,
      };
    },
  );
  const loader = vi.fn(
    async (): Promise<PdfLibs> => ({
      jsPDF: jsPDFStub as unknown as PdfLibs['jsPDF'],
      autoTable: autoTableStub as unknown as PdfLibs['autoTable'],
      svg2pdf: (() => Promise.resolve()) as unknown as PdfLibs['svg2pdf'],
    }),
  );
  return { autoTableCalls, docStub, loader, textCalls };
}

describe('buildPdfSectionModel', () => {
  it('emits one section per manifest entry, in manifest order', () => {
    const model = buildModel('Base Case');
    expect(model.sections).toHaveLength(PDF_SECTION_MANIFEST.length);
    expect(model.sections.map((s) => s.manifest.id)).toEqual(
      PDF_SECTION_MANIFEST.map((s) => s.id),
    );
  });

  it('leaves out excluded sections (hidden beta features) and keeps manifest order for the rest', () => {
    const model = buildPdfSectionModel({
      scenarioName: 'Base Case',
      activeMcBasis: 'mc-typical',
      activeMethod: 'planned',
      displayMode: 'today',
      unifiedYearTableRows: yearRows,
      portfolioFlowsByYear: null,
      reportData: emptyReportData('Base Case'),
      date: { year: 2026, month: 6, day: 20 },
      excludedSectionIds: new Set(['table-withdrawal-guidance']),
    });
    const ids = model.sections.map((s) => s.manifest.id);
    expect(ids).not.toContain('table-withdrawal-guidance');
    expect(ids).toEqual(
      PDF_SECTION_MANIFEST.map((s) => s.id).filter((id) => id !== 'table-withdrawal-guidance'),
    );
  });

  it('puts the cover first with the expected labels', () => {
    const model = buildModel('Base Case');
    const cover = model.sections[0];
    expect(cover.manifest.kind).toBe('cover');
    expect(cover.data.kind).toBe('cover');
    if (cover.data.kind === 'cover') {
      expect(cover.data.labels.scenarioName).toBe('Base Case');
      expect(cover.data.labels.basisLabel).toBe('Typical');
      expect(cover.data.labels.generatedOn).toBe('Generated on 2026-06-20');
    }
    expect(model.coverLabels.scenarioName).toBe('Base Case');
  });

  it('orders the cover first, then the scenario summary', () => {
    const ids = buildModel('X').sections.map((s) => s.manifest.id);
    expect(ids[0]).toBe('cover');
    expect(ids.indexOf('chart-balance')).toBeGreaterThan(0);
    // The scenario summary (with the household overview folded in) leads the
    // content sections; the standalone overview page is gone.
    expect(ids[1]).toBe('report-scenarios');
    expect(ids).not.toContain('report-overview');
    expect(ids.indexOf('report-scenarios')).toBeLessThan(
      ids.indexOf('chart-balance'),
    );
  });

  it('builds the year-by-year table spec from the already-transformed rows', () => {
    const model = buildModel('X');
    const yearSection = model.sections.find(
      (s) => s.manifest.id === 'table-year-by-year',
    );
    expect(yearSection?.data.kind).toBe('table');
    if (yearSection?.data.kind === 'table') {
      expect(yearSection.data.spec?.body).toHaveLength(1);
      expect(yearSection.data.spec?.body[0][0]).toBe('2040');
    }
  });

  it('carries a per-chart tableSpec on chart sections when one is supplied', () => {
    const tables = new Map([
      ['chart-balance', { head: [['Year', 'Planned']], body: [['2040', '$1,000']] }],
    ]);
    const model = buildModel('X', emptyReportData('X'), tables);
    const balanceChart = model.sections.find(
      (s) => s.manifest.id === 'chart-balance',
    );
    expect(balanceChart?.data.kind).toBe('chart');
    if (balanceChart?.data.kind === 'chart') {
      expect(balanceChart.data.tableSpec?.body[0][0]).toBe('2040');
    }
    // A chart section with no supplied table carries a null tableSpec.
    const stressChart = model.sections.find(
      (s) => s.manifest.id === 'chart-stress-test',
    );
    if (stressChart?.data.kind === 'chart') {
      expect(stressChart.data.tableSpec).toBeNull();
    }
  });

  it('carries the supplied withdrawal-guidance spec on the final section', () => {
    const spec = {
      head: [['Year / Account']],
      body: [['2040'], ['note', '', '', '', '', '']],
    };
    const model = buildPdfSectionModel({
      scenarioName: 'X',
      activeMcBasis: null,
      activeMethod: 'planned',
      displayMode: 'today',
      unifiedYearTableRows: yearRows,
      portfolioFlowsByYear: null,
      reportData: emptyReportData('X'),
      date: { year: 2026, month: 6, day: 20 },
      withdrawalGuidanceTableSpec: spec,
    });
    const section = model.sections.find(
      (s) => s.manifest.id === 'table-withdrawal-guidance',
    );
    expect(section?.manifest.kind).toBe('table');
    expect(section?.data.kind).toBe('table');
    if (section?.data.kind === 'table') {
      expect(section.data.spec).toEqual(spec);
    }
  });

  it('yields a null-spec withdrawal-guidance section when none is supplied', () => {
    const model = buildModel('X');
    const section = model.sections.find(
      (s) => s.manifest.id === 'table-withdrawal-guidance',
    );
    expect(section?.data.kind).toBe('table');
    if (section?.data.kind === 'table') {
      expect(section.data.spec).toBeNull();
    }
  });

  it('yields a null-spec Roth tax-free-amounts section when there are no rows', () => {
    const model = buildModel('X');
    const section = model.sections.find((s) => s.manifest.id === 'table-roth-tax-free');
    expect(section?.data.kind).toBe('table');
    if (section?.data.kind === 'table') {
      expect(section.data.spec).toBeNull();
    }
  });

  it('carries the Roth tax-free-amounts spec when rows are present', () => {
    const reportData = emptyReportData('X');
    reportData.rothTaxFreeAmounts = [
      { id: 'roth-tax-free-person-m1', kind: 'person', label: 'Alex', amount: 45_000 },
    ];
    const model = buildModel('X', reportData);
    const section = model.sections.find((s) => s.manifest.id === 'table-roth-tax-free');
    expect(section?.data.kind).toBe('table');
    if (section?.data.kind === 'table') {
      expect(section.data.spec?.body).toHaveLength(1);
      expect(section.data.spec?.body[0][0]).toBe('Alex');
    }
  });

  it('does not leak another scenario’s data when a specific scenario is passed', () => {
    // Two distinct scenarios → the cover + report only ever carry the
    // scenario actually handed in.
    const a = buildModel('Scenario A', emptyReportData('Scenario A'));
    const b = buildModel('Scenario B', emptyReportData('Scenario B'));
    expect(a.coverLabels.scenarioName).toBe('Scenario A');
    expect(b.coverLabels.scenarioName).toBe('Scenario B');
    expect(JSON.stringify(a)).not.toContain('Scenario B');
    expect(JSON.stringify(b)).not.toContain('Scenario A');
  });
});

describe('buildAndDownloadPdf (mock loader)', () => {
  it('drives the injected jsPDF trio and never loads the real libs', async () => {
    const calls: string[] = [];
    const brandDrawCalls: string[] = [];
    let currentFontSize: number | null = null;
    let currentTextColor: string | null = null;
    let capturedCoverWordmark = false;
    const docStub = {
      text: vi.fn((value: unknown, x: number, y: number) => {
        calls.push('text');
        if (!capturedCoverWordmark && value === APP_NAME) {
          brandDrawCalls.push(
            `wordmark:${x},${y},${currentFontSize}pt,${currentTextColor}`,
          );
          capturedCoverWordmark = true;
        }
      }),
      textWithLink: vi.fn(() => calls.push('textWithLink')),
      addPage: vi.fn(() => calls.push('addPage')),
      save: vi.fn((name: string) => calls.push(`save:${name}`)),
      setFontSize: vi.fn((size: number) => {
        currentFontSize = size;
      }),
      setFont: vi.fn(),
      setPage: vi.fn(),
      setFillColor: vi.fn((r: number, g: number, b: number) => {
        brandDrawCalls.push(`fill:${r},${g},${b}`);
      }),
      setTextColor: vi.fn((r: number, g: number, b: number) => {
        currentTextColor = `${r},${g},${b}`;
      }),
      rect: vi.fn(),
      roundedRect: vi.fn(),
      circle: vi.fn((x: number, y: number, radius: number, style: string) => {
        brandDrawCalls.push(`circle:${x},${y},${radius},${style}`);
      }),
      getNumberOfPages: vi.fn().mockReturnValue(1),
      splitTextToSize: vi.fn((text: string) => [text]),
    };
    // `new jsPDF(...)` is called, so the stub must be a constructor.
    const jsPDFStub = vi.fn(function jsPDFCtor(this: unknown) {
      return docStub;
    });
    const autoTableStub = vi.fn(() => calls.push('autoTable'));

    const loader = vi.fn(
      async (): Promise<PdfLibs> =>
        ({
          jsPDF: jsPDFStub as unknown as PdfLibs['jsPDF'],
          autoTable: autoTableStub as unknown as PdfLibs['autoTable'],
          svg2pdf: (() => Promise.resolve()) as unknown as PdfLibs['svg2pdf'],
        }) ,
    );

    const model = buildModel('Base Case');
    await buildAndDownloadPdf({
      sectionModel: model,
      svgElementsBySection: new Map(),
      filename: 'retivo-Base-Case-Typical-2026-06-20.pdf',
      loader,
    });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(jsPDFStub).toHaveBeenCalledTimes(1);
    expect(docStub.save).toHaveBeenCalledWith(
      'retivo-Base-Case-Typical-2026-06-20.pdf',
    );
    expect(docStub.setFillColor).toHaveBeenCalledTimes(1);
    expect(docStub.circle).toHaveBeenCalledTimes(1);
    expect(brandDrawCalls).toEqual([
      'fill:14,101,73',
      'circle:47,63,7,F',
      'wordmark:68,69,18pt,14,101,73',
    ]);
    expect(docStub.rect).not.toHaveBeenCalled();
    expect(docStub.roundedRect).not.toHaveBeenCalled();
    expect(docStub.text).toHaveBeenCalledWith(APP_NAME, 68, 69);
    // At least one table rendered (year-by-year has rows).
    expect(autoTableStub).toHaveBeenCalled();
  });

  it('forwards a table footer with last-page-only totals styling', async () => {
    const spec = {
      head: [['Account', 'Balance']],
      body: [['IRA', '$100']],
      foot: [['Total', '$100']],
    };
    const model = buildPdfSectionModel({
      scenarioName: 'Base Case',
      activeMcBasis: null,
      activeMethod: 'planned',
      displayMode: 'today',
      unifiedYearTableRows: yearRows,
      portfolioFlowsByYear: null,
      reportData: emptyReportData('Base Case'),
      date: { year: 2026, month: 6, day: 20 },
      withdrawalGuidanceTableSpec: spec,
    });
    const { autoTableCalls, loader } = createRenderHarness();

    await buildAndDownloadPdf({
      sectionModel: model,
      svgElementsBySection: new Map(),
      filename: 'r.pdf',
      loader,
    });

    const rendered = autoTableCalls.find(
      (call) => call.options.body?.[0]?.[0] === 'IRA',
    );
    expect(rendered?.options).toEqual(
      expect.objectContaining({
        head: spec.head,
        body: spec.body,
        foot: spec.foot,
        showFoot: 'lastPage',
        styles: { fontSize: 7, cellPadding: 2 },
        footStyles: {
          fontStyle: 'bold',
          fillColor: [238, 240, 242],
          textColor: [0, 0, 0],
          lineWidth: 0.5,
          lineColor: [120, 120, 120],
        },
      }),
    );
  });

  it('renders the Roth tax-free amounts table and lists it in the table of contents', async () => {
    const reportData = emptyReportData('Base Case');
    reportData.rothTaxFreeAmounts = [
      { id: 'roth-tax-free-person-m1', kind: 'person', label: 'Alex', amount: 45_000 },
      { id: 'roth-tax-free-employer-e1', kind: 'employer', label: '401k', amount: 12_000 },
    ];
    const model = buildModel('Base Case', reportData);
    const { autoTableCalls, docStub, loader } = createRenderHarness();

    await buildAndDownloadPdf({
      sectionModel: model,
      svgElementsBySection: new Map(),
      filename: 'r.pdf',
      loader,
    });

    const rendered = autoTableCalls.find(
      (call) => call.options.head?.[0]?.[0] === 'Person or account',
    );
    expect(rendered?.options.body).toEqual([
      ['Alex', expect.any(String), '$45,000'],
      ['401k', expect.any(String), '$12,000'],
    ]);
    // Pinned so a future `continue` in the section-emission loop cannot
    // silently drop this section's table-of-contents entry.
    expect(docStub.textWithLink).toHaveBeenCalledWith(
      'Roth tax-free amounts',
      40,
      expect.any(Number),
      expect.objectContaining({ pageNumber: expect.any(Number) }),
    );
  });

  it('renders member bullets with retirement dates and canonical age formats', async () => {
    const reportData = emptyReportData('Base Case');
    reportData.overview.members = [
      {
        role: 'primary',
        name: 'Alex Morgan',
        currentAge: 52,
        retirementAge: { years: 59, months: 6 },
        retirementYear: 2033,
        retirementMonth: 5,
      },
      {
        role: 'secondary',
        name: 'No Birthdate',
        currentAge: null,
        retirementAge: { years: 59, months: 0 },
        retirementYear: null,
        retirementMonth: null,
      },
      {
        role: 'secondary',
        name: 'Year Only',
        currentAge: 52,
        retirementAge: { years: 59, months: 4 },
        retirementYear: 2033,
        retirementMonth: null,
      },
    ];
    const { docStub, loader, textCalls } = createRenderHarness();

    await buildAndDownloadPdf({
      sectionModel: buildModel('Base Case', reportData),
      svgElementsBySection: new Map(),
      filename: 'r.pdf',
      loader,
      overview: reportData.overview,
    });

    const expected = [
      '- Alex Morgan · age 52 · retires May 2033 at age 59.5',
      '- No Birthdate · retires at age 59',
      '- Year Only · age 52 · retires 2033 at age 59 years 4 months',
    ];
    expect(textCalls.map((call) => call.value)).toEqual(
      expect.arrayContaining(expected),
    );
    for (const line of expected) {
      expect(docStub.splitTextToSize).toHaveBeenCalledWith(line, 515);
    }
  });

  it('paginates wrapped Scenario text line by line within the usable page', async () => {
    const descriptionLines = Array.from(
      { length: 60 },
      (_, index) => `description-line-${index + 1}`,
    );
    const noteLines = Array.from(
      { length: 65 },
      (_, index) => `note-line-${index + 1}`,
    );
    const { loader, textCalls } = createRenderHarness((text) => {
      if (text === 'LONG DESCRIPTION') return descriptionLines;
      if (text === 'LONG NOTES') return noteLines;
      return [text];
    });

    await buildAndDownloadPdf({
      sectionModel: buildModel('Base Case'),
      svgElementsBySection: new Map(),
      filename: 'r.pdf',
      loader,
      scenarioDescription: 'LONG DESCRIPTION',
      scenarioNotes: 'LONG NOTES',
      scenarioSettingGroups: [
        { title: 'Retirement & longevity', rows: [{ label: 'Age', value: '65' }] },
      ],
    });

    const renderedLines = textCalls.filter(
      (call) => typeof call.value === 'string' && call.value.startsWith('description-line-'),
    );
    expect(renderedLines).toHaveLength(descriptionLines.length);
    expect(renderedLines.every((call) => call.y <= 795)).toBe(true);
    expect(new Set(renderedLines.map((call) => call.page)).size).toBeGreaterThan(1);
    const renderedNotes = textCalls.filter(
      (call) => typeof call.value === 'string' && call.value.startsWith('note-line-'),
    );
    expect(renderedNotes).toHaveLength(noteLines.length);
    expect(renderedNotes.every((call) => call.y <= 795)).toBe(true);
    const continuation = textCalls.find(
      (call) => call.value === 'Scenario (continued)',
    );
    expect(continuation).toEqual(
      expect.objectContaining({ x: 40, y: 50 }),
    );
    const firstContinuedLine = renderedLines.find(
      (call) => call.page === continuation?.page,
    );
    expect(firstContinuedLine?.y).toBe(74);
    const scenarioPage = textCalls.find(
      (call) => call.value === 'SCENARIO' && call.y === 50,
    )?.page;
    expect(continuation?.page).toBeGreaterThan(scenarioPage ?? 0);
  });

  it('keeps member and projection headings with first content near a page boundary', async () => {
    const descriptionLines = Array.from(
      { length: 51 },
      (_, index) => `boundary-line-${index + 1}`,
    );
    const reportData = emptyReportData('Base Case');
    reportData.overview.members = [
      {
        role: 'primary',
        name: 'Member With A Name Long Enough To Wrap',
        currentAge: 52,
        retirementAge: { years: 59, months: 6 },
        retirementYear: 2033,
        retirementMonth: 5,
      },
    ];
    const memberText =
      '- Member With A Name Long Enough To Wrap · age 52 · retires May 2033 at age 59.5';
    const memberLines = ['- Member With A Name', 'Long Enough To Wrap · age 52', '· retires May 2033 at age 59.5'];
    const { loader, textCalls } = createRenderHarness((text) => {
      if (text === 'BOUNDARY DESCRIPTION') return descriptionLines;
      if (text === memberText) return memberLines;
      return [text];
    });

    await buildAndDownloadPdf({
      sectionModel: buildModel('Base Case', reportData),
      svgElementsBySection: new Map(),
      filename: 'r.pdf',
      loader,
      overview: reportData.overview,
      scenarioDescription: 'BOUNDARY DESCRIPTION',
      atRetirementBalance: 500_000,
    });

    const membersHeading = textCalls.find((call) => call.value === 'Members');
    const renderedMemberLines = textCalls.filter(
      (call) => typeof call.value === 'string' && memberLines.includes(call.value),
    );
    const projectionHeading = textCalls.find(
      (call) => call.value === 'Projection milestones',
    );
    const projectionLine = textCalls.find(
      (call) => call.value === 'At retirement (estimated): $500,000',
    );
    expect(membersHeading).toEqual(expect.objectContaining({ y: 74 }));
    expect(renderedMemberLines[0]).toEqual(
      expect.objectContaining({ page: membersHeading?.page, y: 90 }),
    );
    expect(renderedMemberLines.every((call) => call.y <= 795)).toBe(true);
    expect(projectionHeading?.page).toBe(renderedMemberLines.at(-1)?.page);
    expect(projectionHeading?.y).toBeGreaterThan(renderedMemberLines.at(-1)?.y ?? 0);
    expect(projectionLine).toEqual(
      expect.objectContaining({ page: projectionHeading?.page }),
    );
    expect(projectionLine?.y).toBeGreaterThan(projectionHeading?.y ?? 0);
  });

  it('moves a near-boundary settings heading with its first table row', async () => {
    const descriptionLines = Array.from(
      { length: 52 },
      (_, index) => `settings-boundary-line-${index + 1}`,
    );
    const { autoTableCalls, loader, textCalls } = createRenderHarness((text) =>
      text === 'SETTINGS BOUNDARY' ? descriptionLines : [text],
    );

    await buildAndDownloadPdf({
      sectionModel: buildModel('Base Case'),
      svgElementsBySection: new Map(),
      filename: 'r.pdf',
      loader,
      scenarioDescription: 'SETTINGS BOUNDARY',
      scenarioSettingGroups: [
        { title: 'Retirement & longevity', rows: [{ label: 'Age', value: '65' }] },
      ],
    });

    const heading = textCalls.find(
      (call) => call.value === 'Retirement & longevity',
    );
    const table = autoTableCalls.find(
      (call) => call.options.body?.[0]?.[0] === 'Age',
    );
    expect(heading).toEqual(expect.objectContaining({ y: 74 }));
    expect(table).toEqual(
      expect.objectContaining({
        page: heading?.page,
        options: expect.objectContaining({ startY: 82 }),
      }),
    );
    expect(
      textCalls.some(
        (call) =>
          call.value === 'Scenario (continued)' &&
          call.page === heading?.page &&
          call.x === 40 &&
          call.y === 50,
      ),
    ).toBe(true);
  });

  it('stamps the one-line disclaimer footer once on every page', async () => {
    // Page-counting docStub: addPage increments; getNumberOfPages returns the
    // running count so the footer loop iterates the true page count.
    let pageCount = 1;
    const textCalls: Array<{ str: unknown; x: number; y: number }> = [];
    const docStub = {
      text: vi.fn((str: unknown, x: number, y: number) => {
        textCalls.push({ str, x, y });
      }),
      textWithLink: vi.fn(),
      addPage: vi.fn(() => {
        pageCount += 1;
      }),
      save: vi.fn(),
      setFontSize: vi.fn(),
      setFont: vi.fn(),
      setPage: vi.fn(),
      setFillColor: vi.fn(),
      setTextColor: vi.fn(),
      roundedRect: vi.fn(),
      circle: vi.fn(),
      getNumberOfPages: vi.fn(() => pageCount),
      splitTextToSize: vi.fn((text: string) => [text]),
    };
    const jsPDFStub = vi.fn(function jsPDFCtor(this: unknown) {
      return docStub;
    });
    const loader = vi.fn(
      async (): Promise<PdfLibs> => ({
        jsPDF: jsPDFStub as unknown as PdfLibs['jsPDF'],
        autoTable: (() => {}) as unknown as PdfLibs['autoTable'],
        svg2pdf: (() => Promise.resolve()) as unknown as PdfLibs['svg2pdf'],
      }),
    );

    await buildAndDownloadPdf({
      sectionModel: buildModel('Base Case'),
      svgElementsBySection: new Map(),
      filename: 'r.pdf',
      loader,
      disclaimer: REPORT_DISCLAIMER,
    });

    // The cover retitle + the page-2 heading.
    expect(textCalls.some((c) => c.str === 'Retirement Planning Report')).toBe(true);
    expect(textCalls.some((c) => c.str === 'Important Information')).toBe(true);

    // One footer disclaimer per page, always on the footer baseline (y=825).
    const footerCalls = textCalls.filter((c) => c.str === ONE_LINE_DISCLAIMER);
    expect(pageCount).toBeGreaterThan(1);
    expect(footerCalls).toHaveLength(pageCount);
    for (const c of footerCalls) expect(c.y).toBe(825);

    // The repo address (no scheme) sits at the left edge of every page's footer.
    const repoCalls = textCalls.filter((c) => c.str === REPO_HOST_PATH);
    expect(repoCalls).toHaveLength(pageCount);
    for (const c of repoCalls) {
      expect(c.x).toBe(40);
      expect(c.y).toBe(825);
    }

    // No retired operator identity (old brand mark, old host) in the drawn text.
    for (const c of textCalls) {
      expect(String(c.str)).not.toMatch(/b[a]dger|app[.]retivo[.]money/i);
    }
  });

  it('the footer repo address clears the left edge of the centred one-line disclaimer', () => {
    // A per-call stub cannot see overlap, so measure with real jsPDF at the
    // footer's 8pt, using the same anchors `buildAndDownloadPdf` draws at
    // (address at x=40, disclaimer centred at x=297).
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    doc.setFontSize(8);
    const addressRightEdge = 40 + doc.getTextWidth(REPO_HOST_PATH);
    const disclaimerLeftEdge = 297 - doc.getTextWidth(ONE_LINE_DISCLAIMER) / 2;
    expect(addressRightEdge).toBeLessThan(disclaimerLeftEdge - 8);
  });

  it('renders exactly one external link (the open-source line), on page 1 only', async () => {
    let pageCount = 1;
    const linkCalls: Array<{ str: unknown; url: unknown }> = [];
    const docStub = {
      text: vi.fn(),
      textWithLink: vi.fn(
        (str: unknown, _x: number, _y: number, opts?: { url?: unknown }) => {
          linkCalls.push({ str, url: opts?.url });
        },
      ),
      addPage: vi.fn(() => {
        pageCount += 1;
      }),
      save: vi.fn(),
      setFontSize: vi.fn(),
      setFont: vi.fn(),
      setPage: vi.fn(),
      setFillColor: vi.fn(),
      setTextColor: vi.fn(),
      roundedRect: vi.fn(),
      circle: vi.fn(),
      getNumberOfPages: vi.fn(() => pageCount),
      splitTextToSize: vi.fn((text: string) => [text]),
    };
    const jsPDFStub = vi.fn(function jsPDFCtor(this: unknown) {
      return docStub;
    });
    const loader = vi.fn(
      async (): Promise<PdfLibs> => ({
        jsPDF: jsPDFStub as unknown as PdfLibs['jsPDF'],
        autoTable: (() => {}) as unknown as PdfLibs['autoTable'],
        svg2pdf: (() => Promise.resolve()) as unknown as PdfLibs['svg2pdf'],
      }),
    );

    await buildAndDownloadPdf({
      sectionModel: buildModel('Base Case'),
      svgElementsBySection: new Map(),
      filename: 'r.pdf',
      loader,
      disclaimer: REPORT_DISCLAIMER,
    });

    // Exactly one external link, to the repo, and its visible string is the
    // page-one open-source line (never repeated per page).
    const repoLinks = linkCalls.filter((c) => c.url === REPO_URL);
    expect(repoLinks).toHaveLength(1);
    expect(repoLinks[0]!.str).toBe(OPEN_SOURCE_TEXT);
  });
});
