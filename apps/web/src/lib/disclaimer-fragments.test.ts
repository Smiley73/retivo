/**
 * Semantic guards for the shared report disclaimer: the terms it must state
 * and the references it must no longer make.
 */
import { describe, expect, it } from 'vitest';
import { REPORT_DISCLAIMER } from './disclaimer-fragments';

describe('disclaimer fragments', () => {

  it('REPORT_DISCLAIMER states the no-fiduciary + staleness + third-party terms', () => {
    expect(REPORT_DISCLAIMER).toMatch(/informational/i);
    expect(REPORT_DISCLAIMER).toMatch(/not financial.*advice/i);
    expect(REPORT_DISCLAIMER).toMatch(/no advisory or fiduciary relationship/i);
    expect(REPORT_DISCLAIMER).toMatch(/point-in-time snapshots/i);
    expect(REPORT_DISCLAIMER).toMatch(/prepared solely for the person who generated it/i);
    expect(REPORT_DISCLAIMER).toMatch(
      /consult an appropriately qualified professional\.$/,
    );
  });

  it('REPORT_DISCLAIMER no longer points at the Terms or Privacy Notice, and keeps the rest of the closing', () => {
    expect(REPORT_DISCLAIMER).not.toContain('Terms of Use');
    expect(REPORT_DISCLAIMER).not.toContain('Privacy Notice');
    expect(REPORT_DISCLAIMER).toContain(
      'reliance on it. Before making any retirement, investment, or tax ' +
        'decision, verify any figure that matters against your own records ' +
        'and consult an appropriately qualified professional.',
    );
  });
});
