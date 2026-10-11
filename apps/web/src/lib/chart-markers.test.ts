import { describe, expect, it } from 'vitest';
import {
  adaptiveYearTicks,
  assignMarkerLabelSlots,
  fiveYearTicks,
  labelAnchorForX,
  markerSlotDy,
} from './chart-markers';

describe('fiveYearTicks', () => {
  it('emits every multiple of 5 within the range', () => {
    expect(fiveYearTicks(2032, 2048)).toEqual([2035, 2040, 2045]);
  });

  it('falls back to the first and last plotted year when no multiple of 5 falls inside a short window', () => {
    expect(fiveYearTicks(2032, 2033)).toEqual([2032, 2033]);
  });

  it('falls back to a single tick when min equals max and straddles no multiple of 5', () => {
    expect(fiveYearTicks(2032, 2032)).toEqual([2032]);
  });
});

describe('adaptiveYearTicks', () => {
  it('uses a 5-year grid across a full ~40-year horizon', () => {
    expect(adaptiveYearTicks(2027, 2069)).toEqual([
      2030, 2035, 2040, 2045, 2050, 2055, 2060, 2065,
    ]);
  });

  it('drops to a yearly grid when zoomed into a narrow span', () => {
    // A 5-year grid would yield zero ticks for 2031–2034 (no multiple of 5);
    // the adaptive grid still shows ticks.
    expect(adaptiveYearTicks(2031, 2034)).toEqual([2031, 2032, 2033, 2034]);
  });

  it('uses a 2-year grid for a medium zoom span', () => {
    expect(adaptiveYearTicks(2031, 2043)).toEqual([
      2032, 2034, 2036, 2038, 2040, 2042,
    ]);
  });
});

describe('markerSlotDy', () => {
  it('maps slot 0 to the base offset', () => {
    expect(markerSlotDy(0)).toBe(-16);
  });

  it('steps each slot further into the top margin', () => {
    expect(markerSlotDy(1)).toBe(-30);
    expect(markerSlotDy(2)).toBe(-44);
  });
});

describe('assignMarkerLabelSlots', () => {
  it('returns an empty array for empty input', () => {
    expect(assignMarkerLabelSlots([])).toEqual([]);
  });

  it('puts a single marker in slot 0', () => {
    expect(assignMarkerLabelSlots([{ fractionalYear: 2030 }])).toEqual([
      { fractionalYear: 2030, slot: 0 },
    ]);
  });

  it('staggers two markers closer than the min delta', () => {
    const slots = assignMarkerLabelSlots([
      { fractionalYear: 2030 },
      { fractionalYear: 2032 }, // 2-year gap < MIN_DELTA_YEARS (4)
    ]).map((m) => m.slot);
    expect(slots).toEqual([0, 1]);
  });

  it('keeps two far-apart markers in slot 0', () => {
    const slots = assignMarkerLabelSlots([
      { fractionalYear: 2030 },
      { fractionalYear: 2040 }, // 10-year gap >= MIN_DELTA_YEARS
    ]).map((m) => m.slot);
    expect(slots).toEqual([0, 0]);
  });

  it('wraps back to slot 0 at the slot-count boundary', () => {
    // Four markers each 1 year apart (all < MIN_DELTA_YEARS) climb
    // slots 0,1,2 then wrap to 0 once SLOT_COUNT (3) is reached.
    const slots = assignMarkerLabelSlots([
      { fractionalYear: 2030 },
      { fractionalYear: 2031 },
      { fractionalYear: 2032 },
      { fractionalYear: 2033 },
    ]).map((m) => m.slot);
    expect(slots).toEqual([0, 1, 2, 0]);
  });

  it('sorts by fractionalYear before assigning slots', () => {
    const result = assignMarkerLabelSlots([
      { fractionalYear: 2032, label: 'b' },
      { fractionalYear: 2030, label: 'a' },
    ]);
    expect(result.map((m) => m.label)).toEqual(['a', 'b']);
    expect(result.map((m) => m.slot)).toEqual([0, 1]);
  });

  it('preserves all caller fields plus slot', () => {
    const result = assignMarkerLabelSlots([
      { fractionalYear: 2030, label: 'Retires', color: '#0a0' },
    ]);
    expect(result[0]).toEqual({
      fractionalYear: 2030,
      label: 'Retires',
      color: '#0a0',
      slot: 0,
    });
  });
});

describe('labelAnchorForX', () => {
  it('right-anchors labels past 75% of the visible domain', () => {
    expect(labelAnchorForX(2038, 2030, 2040)).toBe('end');
  });

  it('middle-anchors labels at or below 75% of the domain', () => {
    expect(labelAnchorForX(2035, 2030, 2040)).toBe('middle');
  });

  it('middle-anchors when the domain is degenerate or value non-finite', () => {
    expect(labelAnchorForX(2035, 2040, 2040)).toBe('middle');
    expect(labelAnchorForX(Number.NaN, 2030, 2040)).toBe('middle');
  });
});
