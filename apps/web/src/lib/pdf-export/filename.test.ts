import { describe, expect, it } from 'vitest';
import {
  buildPdfFilename,
  sanitizeFilenameComponent,
} from './filename';

describe('sanitizeFilenameComponent', () => {
  it('passes normal ASCII through unchanged', () => {
    expect(sanitizeFilenameComponent('Base_Case-2')).toBe('Base_Case-2');
  });

  it('collapses control characters to a dash', () => {
    expect(sanitizeFilenameComponent('a\x00b\x07c')).toBe('a-b-c');
  });

  it('collapses the RTL-override mark to a dash', () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE between two words.
    expect(sanitizeFilenameComponent('safe\u202Eevil')).toBe('safe-evil');
  });

  it('strips a leading dot rather than turning it into a dash', () => {
    expect(sanitizeFilenameComponent('.hidden')).toBe('hidden');
    expect(sanitizeFilenameComponent('...deep')).toBe('deep');
  });

  it('collapses a forward slash (path separator) to a dash', () => {
    expect(sanitizeFilenameComponent('a/b/c')).toBe('a-b-c');
  });

  it('collapses unicode to a dash', () => {
    expect(sanitizeFilenameComponent('café résumé')).toBe('caf-r-sum');
  });

  it('collapses runs of disallowed chars to a single dash and trims edges', () => {
    expect(sanitizeFilenameComponent('  spaced   out  ')).toBe('spaced-out');
  });

  it('caps the result at 40 characters', () => {
    const long = 'a'.repeat(60);
    const out = sanitizeFilenameComponent(long);
    expect(out.length).toBe(40);
    expect(out).toBe('a'.repeat(40));
  });

  it('does not leave a trailing dash after the length cap truncates mid-run', () => {
    // 39 'a's then a dash region — the cap lands on the dash, which is trimmed.
    const out = sanitizeFilenameComponent(`${'a'.repeat(39)}!!!!tail`);
    expect(out.endsWith('-')).toBe(false);
  });

  it('returns "untitled" when nothing usable remains', () => {
    expect(sanitizeFilenameComponent('////')).toBe('untitled');
    expect(sanitizeFilenameComponent('')).toBe('untitled');
    expect(sanitizeFilenameComponent('...')).toBe('untitled');
  });
});

describe('buildPdfFilename', () => {
  it('builds the dated retirement filename', () => {
    expect(
      buildPdfFilename({
        scenarioName: 'Base Case',
        basisKey: 'Typical',
        date: { year: 2026, month: 6, day: 20 },
      }),
    ).toBe('retivo-Base-Case-Typical-2026-06-20.pdf');
  });

  it('zero-pads month and day', () => {
    expect(
      buildPdfFilename({
        scenarioName: 'X',
        basisKey: 'Planned',
        date: { year: 2026, month: 1, day: 5 },
      }),
    ).toBe('retivo-X-Planned-2026-01-05.pdf');
  });

  it('sanitizes a hostile scenario name into the filename', () => {
    const name = buildPdfFilename({
      scenarioName: '../../etc/passwd\u202E',
      basisKey: 'Bad-luck',
      date: { year: 2026, month: 12, day: 31 },
    });
    expect(name).toBe('retivo-etc-passwd-Bad-luck-2026-12-31.pdf');
    expect(name).not.toContain('/');
    expect(name).not.toContain('\u202E');
  });
});
