import { describe, expect, it } from 'vitest';
import { buildMasker, cleanText, EMPTY_MASKER, MASK, matchModeFor, sanitizeClientName, sanitizeFreeText, sanitizeLabel } from './sanitize';

describe('sanitizers', () => {
  it('removes control, zero-width and bidirectional characters', () => {
    const dirty = 'Ac\u0000c\u0007ou\u200Bnt\u202E\u2066 na\u00ADme\uFEFF\u009F';
    expect(sanitizeLabel(dirty, EMPTY_MASKER)).toBe('Account name');
  });

  it('collapses newlines, tabs and runs of whitespace to single spaces', () => {
    expect(sanitizeFreeText('  first\r\nsecond\t\tthird \u2028 fourth  ', EMPTY_MASKER)).toBe('first second third fourth');
  });

  it('cuts a 61-character label to 60 characters with an ellipsis', () => {
    const label = sanitizeLabel('a'.repeat(61), EMPTY_MASKER);
    expect(Array.from(label)).toHaveLength(60);
    expect(label.endsWith('…')).toBe(true);
    expect(sanitizeLabel('a'.repeat(60), EMPTY_MASKER)).toBe('a'.repeat(60));
  });

  it('cuts a 501-character note to 500 characters with an ellipsis', () => {
    const note = sanitizeFreeText('b'.repeat(501), EMPTY_MASKER);
    expect(Array.from(note)).toHaveLength(500);
    expect(note.endsWith('…')).toBe(true);
    expect(sanitizeFreeText('b'.repeat(500), EMPTY_MASKER)).toBe('b'.repeat(500));
  });

  it('counts code points, so a cut never splits a surrogate pair', () => {
    const cut = sanitizeLabel('\u{1F600}'.repeat(61), EMPTY_MASKER);
    expect(Array.from(cut)).toHaveLength(60);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('masks literal occurrences of the terms case-insensitively', () => {
    const masker = buildMasker(['Jane.Doe@Example.com', 'Doe']);
    expect(sanitizeFreeText('Write to JANE.DOE@example.COM or ask doe, DOE and Doe.', masker)).toBe(
      `Write to ${MASK} or ask ${MASK}, ${MASK} and ${MASK}.`,
    );
  });

  it('masks a term that zero-width characters were hiding', () => {
    const masker = buildMasker(['Doe']);
    expect(sanitizeLabel('D\u200Bo\u202Ee', masker)).toBe(MASK);
  });

  it('masks regular-expression metacharacters literally', () => {
    const masker = buildMasker(['a.b+c']);
    expect(sanitizeLabel('a.b+c axbbc', masker)).toBe(`${MASK} axbbc`);
  });

  it('ignores terms that are empty once cleaned', () => {
    expect(buildMasker([' ', '', '\u200B']).pattern).toBeNull();
  });

  it('masks a single-character term', () => {
    expect(sanitizeLabel('For 李', buildMasker(['李']))).toBe(`For ${MASK}`);
  });

  it('masks a short term only as a whole word, so unrelated words survive', () => {
    expect(sanitizeLabel('Sam S. Savings', buildMasker(['S']))).toBe(`Sam ${MASK}. Savings`);
    expect(sanitizeLabel('Savings Schwab', buildMasker(['S']))).toBe('Savings Schwab');
    expect(sanitizeFreeText('Savings, buying and Ng-led plans', buildMasker(['Ng']))).toBe(
      `Savings, buying and ${MASK}-led plans`,
    );
    expect(sanitizeLabel('Annual dues, Ann and ANN.', buildMasker(['Ann']))).toBe(`Annual dues, ${MASK} and ${MASK}.`);
    expect(sanitizeLabel('Dollar figures are exact.', buildMasker(['S', 'Ng', 'Ann']))).toBe('Dollar figures are exact.');
  });

  it('still masks a longer term inside a word and a short CJK term anywhere', () => {
    expect(sanitizeLabel('TheSmithFamily trust', buildMasker(['Smith']))).toBe(`The${MASK}Family trust`);
    expect(sanitizeLabel('Smithfield', buildMasker(['Smith']))).toBe(`${MASK}field`);
    expect(sanitizeLabel('李先生的账户', buildMasker(['李']))).toBe(`${MASK}先生的账户`);
  });

  it('matches a name across Unicode normalization forms', () => {
    const composed = 'M\u00fcller';
    const decomposed = 'Mu\u0308ller';
    expect(sanitizeLabel(`The ${decomposed} trust`, buildMasker([composed]))).toBe(`The ${MASK} trust`);
    expect(sanitizeLabel(`The ${composed} trust`, buildMasker([decomposed]))).toBe(`The ${MASK} trust`);
    expect(sanitizeLabel('Mu\u200B\u0308ller', buildMasker([composed]))).toBe(MASK);
  });

  it('treats a combining mark as part of the word a short term would otherwise end', () => {
    expect(sanitizeLabel('Li\u0301 and Li', buildMasker(['Li']))).toBe(`L\u00ed and ${MASK}`);
  });

  it('states one matching policy: whole word below four characters, substring otherwise', () => {
    expect(matchModeFor('S')).toBe('word');
    expect(matchModeFor('Ng')).toBe('word');
    expect(matchModeFor('Ann')).toBe('word');
    expect(matchModeFor('Smith')).toBe('substring');
    expect(matchModeFor('李')).toBe('substring');
    expect(matchModeFor('a@b.c')).toBe('substring');
  });

  it('tells whether a whole token is one of the terms', () => {
    const masker = buildMasker(['Zimmerman', 'Müller']);
    expect(masker.isTerm('zimmerman')).toBe(true);
    expect(masker.isTerm('ZIMMERMAN')).toBe(true);
    expect(masker.isTerm('Mu\u0308ller')).toBe(true);
    expect(masker.isTerm('zimmermann')).toBe(false);
    expect(masker.isTerm('3f2-zimmerman')).toBe(false);
    expect(EMPTY_MASKER.isTerm('anything')).toBe(false);
  });

  it('leaves empty text empty', () => {
    expect(sanitizeLabel('', EMPTY_MASKER)).toBe('');
    expect(sanitizeFreeText('   \n ', EMPTY_MASKER)).toBe('');
    expect(cleanText('')).toBe('');
  });

  it('takes the untrusted client name down the same path', () => {
    expect(sanitizeClientName('Evil\u202E\nAgent '.padEnd(80, 'x'), EMPTY_MASKER)).toHaveLength(60);
    expect(sanitizeClientName('Claude\u200B Code', EMPTY_MASKER)).toBe('Claude Code');
    expect(sanitizeClientName(null)).toBe('');
    expect(sanitizeClientName(undefined)).toBe('');
  });
});
