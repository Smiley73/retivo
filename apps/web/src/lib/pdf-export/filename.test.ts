import { describe, expect, it } from 'vitest';
import { buildPdfFilename } from './filename';

const component = (name: string): string =>
  buildPdfFilename({ scenarioName: name, basisKey: 'b', date: { year: 2026, month: 1, day: 1 } })
    .replace(/^retivo-/, '')
    .replace(/-b-2026-01-01\.pdf$/, '');

describe('filename component sanitizing', () => {
  it.each([
    ['normal ASCII is unchanged', 'Base_Case-2', 'Base_Case-2'],
    ['control characters become a dash', 'a\x00b\x07c', 'a-b-c'],
    ['the RTL-override mark (U+202E) becomes a dash', 'safe\u202Eevil', 'safe-evil'],
    ['a leading dot is stripped, not dashed', '.hidden', 'hidden'],
    ['leading dots are stripped', '...deep', 'deep'],
    ['a path separator becomes a dash', 'a/b/c', 'a-b-c'],
    ['unicode becomes a dash', 'café résumé', 'caf-r-sum'],
    ['runs collapse to one dash and edges trim', '  spaced   out  ', 'spaced-out'],
    ['nothing usable gives "untitled"', '////', 'untitled'],
    ['an empty name gives "untitled"', '', 'untitled'],
    ['only dots gives "untitled"', '...', 'untitled'],
  ])('%s', (_label, name, expected) => {
    expect(component(name)).toBe(expected);
  });

  it('caps the component at 40 characters', () => {
    expect(component('a'.repeat(60))).toBe('a'.repeat(40));
  });

  it('leaves no trailing dash when the cap truncates mid-run', () => {
    expect(component(`${'a'.repeat(39)}!!!!tail`).endsWith('-')).toBe(false);
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
