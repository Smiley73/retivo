import { describe, expect, it } from 'vitest';
import { PDF_SECTION_MANIFEST } from './section-manifest';

describe('PDF_SECTION_MANIFEST', () => {
  it('starts with the cover section', () => {
    expect(PDF_SECTION_MANIFEST[0].id).toBe('cover');
    expect(PDF_SECTION_MANIFEST[0].kind).toBe('cover');
  });

  it('has exactly one cover entry', () => {
    const covers = PDF_SECTION_MANIFEST.filter((s) => s.kind === 'cover');
    expect(covers).toHaveLength(1);
  });

  it('has no duplicate ids', () => {
    const ids = PDF_SECTION_MANIFEST.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('leads with the scenario summary (household overview folded in)', () => {
    const ids = PDF_SECTION_MANIFEST.map((s) => s.id);
    expect(ids[1]).toBe('report-scenarios');
    expect(ids).not.toContain('report-overview');
  });

  it('places the Accounts inventory immediately before the per-account breakdown', () => {
    const ids = PDF_SECTION_MANIFEST.map((s) => s.id);
    expect(ids.indexOf('table-account-breakdown')).toBe(
      ids.indexOf('report-accounts') + 1,
    );
  });

  it('ends with the projected withdrawals table as the final section', () => {
    const last = PDF_SECTION_MANIFEST[PDF_SECTION_MANIFEST.length - 1];
    expect(last.id).toBe('table-withdrawal-guidance');
    expect(last.kind).toBe('table');
    expect(last.title).toBe('Projected withdrawals');
    const ids = PDF_SECTION_MANIFEST.map((s) => s.id);
    expect(ids.indexOf('table-withdrawal-guidance')).toBe(
      ids.indexOf('table-tax-detail') + 1,
    );
  });

  it('orders RMD before the tax & health-cost burden chart', () => {
    const ids = PDF_SECTION_MANIFEST.map((s) => s.id);
    expect(ids.indexOf('chart-rmd')).toBeLessThan(
      ids.indexOf('chart-tax-health-cost'),
    );
  });

  it('places chart-qcd immediately after chart-rmd', () => {
    const ids = PDF_SECTION_MANIFEST.map((s) => s.id);
    expect(ids.indexOf('chart-qcd')).toBe(ids.indexOf('chart-rmd') + 1);
  });

  it('places chart-qcd immediately before chart-roth-conversions', () => {
    const ids = PDF_SECTION_MANIFEST.map((s) => s.id);
    expect(ids.indexOf('chart-roth-conversions')).toBe(ids.indexOf('chart-qcd') + 1);
  });

  it('places table-roth-tax-free immediately after chart-roth-conversions, with kind table and a non-empty title', () => {
    const ids = PDF_SECTION_MANIFEST.map((s) => s.id);
    expect(ids.indexOf('table-roth-tax-free')).toBe(
      ids.indexOf('chart-roth-conversions') + 1,
    );
    const entry = PDF_SECTION_MANIFEST.find((s) => s.id === 'table-roth-tax-free');
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('table');
    expect(entry!.title.length).toBeGreaterThan(0);
  });

  it('chart-qcd has kind "chart" and a non-empty title', () => {
    const entry = PDF_SECTION_MANIFEST.find((s) => s.id === 'chart-qcd');
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('chart');
    expect(entry!.title.length).toBeGreaterThan(0);
  });

  it('only uses the three known kinds, with non-empty titles', () => {
    for (const entry of PDF_SECTION_MANIFEST) {
      expect(['cover', 'chart', 'table']).toContain(entry.kind);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.id.length).toBeGreaterThan(0);
    }
  });
});
