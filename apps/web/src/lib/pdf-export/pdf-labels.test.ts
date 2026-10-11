import { describe, expect, it } from 'vitest';
import {
  buildCoverLabels,
  buildInventoryNote,
  buildMcMethodologyLabel,
  buildReportSectionNote,
  buildSectionLabel,
  displayModeLabel,
  formatIsoDate,
} from './pdf-labels';

const DATE = { year: 2026, month: 6, day: 20 };

describe('buildCoverLabels', () => {
  it('returns the scenario name, basis, display mode, and a dated stamp', () => {
    const labels = buildCoverLabels({
      scenarioName: 'Base Case',
      activeMcBasis: 'mc-typical',
      activeMethod: 'planned',
      displayMode: 'today',
      date: DATE,
    });
    expect(labels.scenarioName).toBe('Base Case');
    expect(labels.basisLabel).toBe('Typical'); // MC tier label
    expect(labels.displayModeLabel).toBe("Today's dollars");
    expect(labels.generatedOn).toBe('Generated on 2026-06-20');
    expect(labels.title.length).toBeGreaterThan(0);
  });

  it('falls back to the deterministic method label under no MC basis', () => {
    const labels = buildCoverLabels({
      scenarioName: 'X',
      activeMcBasis: null,
      activeMethod: 'twr',
      displayMode: 'future',
      date: DATE,
    });
    expect(labels.basisLabel).toBe('Historical');
    expect(labels.displayModeLabel).toBe('Future dollars');
  });
});

describe('buildSectionLabel', () => {
  it('suffixes the basis and display mode onto the section title', () => {
    const label = buildSectionLabel(
      'Balance projection',
      'mc-bad-luck',
      'planned',
      'today',
    );
    expect(label).toContain('Balance projection');
    expect(label).toContain('Bad-luck');
    expect(label).toContain("Today's dollars");
  });
});

describe('buildMcMethodologyLabel', () => {
  it('representative wording disclaims average/percentile', () => {
    const label = buildMcMethodologyLabel('representative');
    expect(label).toContain('not an average');
    expect(label.toLowerCase()).toContain('path');
  });

  it('percentile wording mentions a percentile', () => {
    expect(buildMcMethodologyLabel('percentile')).toContain('percentile');
  });

  it('fan wording mentions the fan', () => {
    expect(buildMcMethodologyLabel('fan').toLowerCase()).toContain('fan');
  });
});

describe('report notes', () => {
  it('report-section note mentions today’s dollars', () => {
    expect(buildReportSectionNote()).toContain("today's dollars");
  });

  it('inventory note is a non-empty string', () => {
    expect(buildInventoryNote().length).toBeGreaterThan(0);
  });
});

describe('display + date helpers', () => {
  it('displayModeLabel maps both modes', () => {
    expect(displayModeLabel('today')).toBe("Today's dollars");
    expect(displayModeLabel('future')).toBe('Future dollars');
  });

  it('formatIsoDate zero-pads', () => {
    expect(formatIsoDate({ year: 2026, month: 1, day: 5 })).toBe('2026-01-05');
  });
});
