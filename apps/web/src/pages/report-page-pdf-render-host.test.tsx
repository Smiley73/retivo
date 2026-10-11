/**
 * ReportPagePdfRenderHost — the off-screen chart-capture host.
 *
 * Asserts the host's contract, not pixel output:
 *  - it renders an `<svg>` for the manifest's projection-chart sections it
 *    owns (the per-year balance line, BOTH account-balance groupings; BOTH
 *    expense chart groupings when expenseRows is non-empty),
 *  - both account-balance groupings (Tier/Type and Account) are present
 *    (the two bands render distinct group-by controls),
 *  - it calls `onReady` once chart geometry has committed, keyed by the
 *    `section-manifest.ts` section ids.
 *
 * The in-house SVG chart engine renders real `<svg>` nodes under jsdom (no
 * canvas), so the readiness probe resolves; no real jsPDF is touched here.
 */
import React from 'react';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDF_SECTION_MANIFEST } from '../lib/pdf-export/section-manifest';
import {
  ReportPagePdfRenderHost,
  type ReportPagePdfRenderHostProps,
  type RenderHostAccount,
} from './report-page-pdf-render-host';
import type { ProjectionChartRow } from '../components/ProjectionChart';
import type { PlanStressTestVm } from '../components/PlanStressTestSection';
import type { StackBandYear } from './balance-projection-page-account-balance-stack';

/** Minimal stress VM stub: `hasNoAccounts: true` keeps the stress chart from
 *  rendering, so the always-present chart set stays the three baseline ones. */
const STRESS_VM_NO_RESULT = {
  hasNoAccounts: true,
  result: null,
  cbpValidation: null,
} as unknown as PlanStressTestVm;

function makeDisplayRows(): ProjectionChartRow[] {
  return [2040, 2041, 2042].map((year, i) => ({
    year,
    x: year + 1,
    plannedSolid: 1_000_000 - i * 50_000,
    plannedDashed: null,
    twrSolid: null,
    twrDashed: null,
    plannedGrowth: null,
    twrGrowth: null,
  }));
}

function makeTimeline(): StackBandYear[] {
  return [2040, 2041, 2042].map((year) => ({
    year,
    zone: 'projected' as const,
    accountBalances: new Map([
      ['acc-1', { balance: 500_000, preEnd: 500_000, postEnd: 0, carriedForward: false }],
      ['acc-2', { balance: 250_000, preEnd: 0, postEnd: 250_000, carriedForward: false }],
    ]),
  }));
}

const ACCOUNTS: RenderHostAccount[] = [
  { id: 'acc-1', name: '401(k)', ownerDisplayName: 'Alex', type: 'RETIREMENT_401K' },
  { id: 'acc-2', name: 'Roth IRA', ownerDisplayName: 'Alex', type: 'RETIREMENT_ROTH_IRA' },
];

function makeProps(
  overrides: Partial<ReportPagePdfRenderHostProps> = {},
): ReportPagePdfRenderHostProps {
  return {
    displayRows: makeDisplayRows(),
    enabledCalculatedMethods: new Set(),
    retirementMarkers: [],
    lifeExpectancyMarkers: [],
    tooltipMembers: [],
    accounts: ACCOUNTS,
    byAccountAccounts: ACCOUNTS,
    accountStackTimeline: makeTimeline(),
    accountStackBoundaryYear: 2040,
    accountStackMarkers: [],
    customTiers: null,
    excludedAccountIds: [],
    methodLabel: 'Planned',
    activeMethod: 'planned',
    mcLine: null,
    expenseRows: [],
    expenseCategoryRows: [],
    expenseCategoryMeta: [],
    expenseMarkers: [],
    stressVm: STRESS_VM_NO_RESULT,
    cashflowRows: [],
    breakdownRows: [],
    depletionYear: null,
    categoryMeta: [],
    portfolioRows: [],
    taxBurdenRows: [],
    rmdRows: [],
    rothRows: [],
    qcdRows: [],
    onReady: () => undefined,
    onError: () => undefined,
    ...overrides,
  };
}

describe('ReportPagePdfRenderHost', () => {
  afterEach(() => cleanup());

  it('calls onReady with an SVG for each section it owns once geometry commits', async () => {
    let readySvgs: Record<string, SVGElement> | null = null;
    render(
      <ReportPagePdfRenderHost
        {...makeProps({
          onReady: (m) => {
            readySvgs = m;
          },
        })}
      />,
    );
    await waitFor(() => expect(readySvgs).not.toBeNull(), { timeout: 4000 });

    const ready = readySvgs as unknown as Record<string, SVGElement>;
    // The host owns exactly these chart sections from the manifest.
    // Expense chart sections are conditionally included only when expenseRows
    // is non-empty. makeProps() defaults to expenseRows: [], so only the three
    // always-present sections are expected here.
    const ownedIds = [
      'chart-balance',
      'chart-account-balances-tier',
      'chart-account-balances-account',
    ];
    for (const id of ownedIds) {
      // Each owned id must be a real manifest entry (identity check against the
      // single source of truth) and resolve to an SVGElement.
      expect(PDF_SECTION_MANIFEST.some((e) => e.id === id)).toBe(true);
      expect(ready[id]).toBeDefined();
      expect(ready[id].tagName.toLowerCase()).toBe('svg');
    }
  });

  it('renders both account-balance groupings (Tier/Type and Account)', async () => {
    let ready = false;
    render(
      <ReportPagePdfRenderHost
        {...makeProps({
          onReady: () => {
            ready = true;
          },
        })}
      />,
    );
    await waitFor(() => expect(ready).toBe(true), { timeout: 4000 });
    // Each band renders a Type-vs-Account group-by radiogroup; two bands → two.
    // The host is intentionally `aria-hidden` (off-screen capture surface), so
    // query with `hidden: true` to reach the accessibility-hidden subtree.
    const groups = screen.getAllByRole('radiogroup', {
      name: /Group by: Type \| Account/i,
      hidden: true,
    });
    expect(groups.length).toBe(2);
  });

  it('mounts the QCD chart and captures its SVG under chart-qcd when qcdRows is non-empty', async () => {
    let readySvgs: Record<string, SVGElement> | null = null;
    render(
      <ReportPagePdfRenderHost
        {...makeProps({
          rmdRows: [{ year: 2040, rmdMet: 8_000, rmdShortfall: 0, rmdRetained: 1_000 }],
          qcdRows: [{ year: 2040, qcdDollars: 5_000, netTaxableRmd: 8_000, rmdOffsetDollars: 5_000 }],
          onReady: (m) => {
            readySvgs = m;
          },
        })}
      />,
    );
    await waitFor(() => expect(readySvgs).not.toBeNull(), { timeout: 4000 });

    const ready = readySvgs as unknown as Record<string, SVGElement>;
    expect(PDF_SECTION_MANIFEST.some((e) => e.id === 'chart-qcd')).toBe(true);
    expect(ready['chart-qcd']).toBeDefined();
    expect(ready['chart-qcd'].tagName.toLowerCase()).toBe('svg');
  });

  it('omits chart-qcd from the ready map when qcdRows is empty (default props)', async () => {
    let readySvgs: Record<string, SVGElement> | null = null;
    render(
      <ReportPagePdfRenderHost
        {...makeProps({
          onReady: (m) => {
            readySvgs = m;
          },
        })}
      />,
    );
    await waitFor(() => expect(readySvgs).not.toBeNull(), { timeout: 4000 });

    const ready = readySvgs as unknown as Record<string, SVGElement>;
    expect(ready['chart-qcd']).toBeUndefined();
  });

  it('calls onError when chart geometry never commits within the timeout', { timeout: 30_000 }, async () => {
    vi.useFakeTimers();
    // Route rAF through setTimeout so fake timers control all ticks.
    const origRAF = globalThis.requestAnimationFrame;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number =>
      window.setTimeout(() => cb(0), 0) as unknown as number,
    );
    // Force collectSvgs() to always miss: querySelectorAll('svg') returns an
    // empty list, while every other selector keeps its real behaviour.
    const origQSA = Element.prototype.querySelectorAll;
    const qsSpy = vi
      .spyOn(Element.prototype, 'querySelectorAll')
      .mockImplementation(function (this: Element, selector: string) {
        if (selector === 'svg') return document.querySelectorAll('.___never___');
        return origQSA.call(this, selector) as NodeListOf<Element>;
      });

    let caughtError: Error | null = null;
    render(
      <ReportPagePdfRenderHost
        {...makeProps({
          onError: (e) => {
            caughtError = e;
          },
        })}
      />,
    );

    // Advance past GEOMETRY_TIMEOUT_MS (10 000 ms) — each tick fires via setTimeout(0).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toBe('PDF chart geometry did not commit in time.');

    qsSpy.mockRestore();
    vi.stubGlobal('requestAnimationFrame', origRAF);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
