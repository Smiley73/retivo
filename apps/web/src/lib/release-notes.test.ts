import { describe, expect, it } from 'vitest';
import {
  RELEASE_NOTES,
  type ReleaseNote,
  type ReleaseNoteKind,
} from './release-notes';

const VALID_KINDS: readonly ReleaseNoteKind[] = ['new', 'improved', 'fixed'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

describe('release notes', () => {
  it('every entry has a valid kind', () => {
    for (const note of RELEASE_NOTES) {
      expect(VALID_KINDS).toContain(note.kind);
    }
  });

  it('every entry has non-empty title and blurb', () => {
    for (const note of RELEASE_NOTES) {
      expect(note.title.trim()).not.toBe('');
      expect(note.blurb.trim()).not.toBe('');
    }
  });

  it('every entry has a parseable ISO YYYY-MM-DD date', () => {
    for (const note of RELEASE_NOTES) {
      expect(note.date).toMatch(ISO_DATE);
      expect(Number.isNaN(Date.parse(note.date))).toBe(false);
      // Strict calendar validation: year/month/day must round-trip
      const [year, month, day] = note.date.split('-').map(Number);
      const utc = new Date(Date.UTC(year!, month! - 1, day!));
      expect(utc.getUTCFullYear()).toBe(year!);
      expect(utc.getUTCMonth() + 1).toBe(month!);
      expect(utc.getUTCDate()).toBe(day!);
    }
  });

  it('is maintained newest-first: dates are non-increasing (ties allowed)', () => {
    for (let i = 0; i < RELEASE_NOTES.length - 1; i += 1) {
      // Array order is the display order — no runtime sort masks a slip.
      expect(RELEASE_NOTES[i]!.date >= RELEASE_NOTES[i + 1]!.date).toBe(true);
    }
  });

  it('the first (most recent) entry is no older than the newest backfilled entry', () => {
    // The ship-stamped first entry's date must be >= the next entry's date,
    // derived from the array itself so the invariant self-maintains (no literal
    // ship-date constant to drift).
    if (RELEASE_NOTES.length >= 2) {
      expect(RELEASE_NOTES[0]!.date >= RELEASE_NOTES[1]!.date).toBe(true);
    }
  });

  it('holds the AI assistant what-if, analysis and assistant announcements, then the open-source one', () => {
    const at = (title: string): ReleaseNote => RELEASE_NOTES.find((n) => n.title === title)!;
    const whatIf = at('Your AI assistant can try a what-if without saving it (beta)');
    const analysis = at('Your AI assistant can run the projection and the stress test (beta)');
    const assistant = at('Ask an AI assistant about your plan (beta)');
    const openSource = at('RETIVO is open source');
    expect(whatIf.kind).toBe('new');
    expect(whatIf.title).toBe('Your AI assistant can try a what-if without saving it (beta)');
    expect(whatIf.blurb).toMatch(/not saved/i);
    expect(whatIf.blurb).toMatch(/Scenarios page/);
    expect(analysis.kind).toBe('new');
    expect(analysis.title).toBe('Your AI assistant can run the projection and the stress test (beta)');
    expect(analysis.blurb).toMatch(/stress test/i);
    expect(analysis.blurb).toMatch(/cannot change anything/i);
    expect(assistant.kind).toBe('new');
    expect(assistant.title).toBe('Ask an AI assistant about your plan (beta)');
    expect(assistant.blurb).toMatch(/reads only what you allow/i);
    expect(assistant.blurb).toMatch(/cannot change anything/i);
    expect(openSource.kind).toBe('new');
    expect(openSource.title).toBe('RETIVO is open source');
    expect(`${openSource.title} ${openSource.blurb}`).toMatch(/open source/i);
  });

  it('keeps the open-source announcement as the oldest entry', () => {
    const entry = RELEASE_NOTES[RELEASE_NOTES.length - 1]!;
    expect(entry.kind).toBe('new');
    expect(entry.title).toBe('RETIVO is open source');
    expect(`${entry.title} ${entry.blurb}`).toMatch(/open source/i);
  });

  it('has no advice-toned "Social Security Optimizer" wording in any note', () => {
    for (const note of RELEASE_NOTES) {
      expect(`${note.title} ${note.blurb}`).not.toMatch(/Social Security Optimizer/);
    }
  });

  it('no note characterises an inherited Roth IRA’s five-year clock', () => {
    // The What’s New page renders every past entry, so a historical blurb is an
    // on-screen string like any other. Neither engine consults that clock now.
    for (const note of RELEASE_NOTES) {
      const text = `${note.title} ${note.blurb}`;
      if (!/inherited Roth/i.test(text)) continue;
      expect(text).not.toMatch(/five-year clock|five-taxable-year/i);
    }
  });

  it('rejects an out-of-order sequence (negative case)', () => {
    const outOfOrder: ReleaseNote[] = [
      { date: '2026-06-17', kind: 'new', title: 'Older', blurb: 'older entry' },
      { date: '2026-06-20', kind: 'new', title: 'Newer', blurb: 'newer entry' },
    ];
    const isNonIncreasing = outOfOrder.every(
      (note, i) => i === 0 || outOfOrder[i - 1]!.date >= note.date,
    );
    expect(isNonIncreasing).toBe(false);
  });
});
