import { describe, it, expect } from 'vitest';
import { RMD_DIVISORS } from './rmd-divisors';
import {
  RMD_LIFE_EXPECTANCY_TABLES,
  selectRmdTableDivisor,
  type RmdLifeExpectancyTables,
} from './rmd-life-expectancy-tables';

describe('RMD_DIVISORS', () => {
  it('should_have_metadata_with_required_fields', () => {
    expect(typeof RMD_DIVISORS.metadata.source).toBe('string');
    expect(RMD_DIVISORS.metadata.source.length).toBeGreaterThan(0);
    expect(typeof RMD_DIVISORS.metadata.asOfDate).toBe('string');
    expect(RMD_DIVISORS.metadata.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(RMD_DIVISORS.metadata.jurisdiction).toBe('US-federal');
  });

  it('should_have_stable_permalink_URLs_in_metadata_source', () => {
    expect(RMD_DIVISORS.metadata.source).toContain('pub/irs-prior/p590b');
    expect(RMD_DIVISORS.metadata.source).toContain(
      'federalregister.gov/documents/2020/11/12/2020-24723',
    );
    expect(RMD_DIVISORS.metadata.source).not.toContain('publications/p590b');
  });

  // IRS Pub 590-B Appendix B Table III spot checks (2022 revision)
  it.each([
    [73, 26.5],
    [75, 24.6],
    [100, 6.4],
    [120, 2.0],
  ])('should_return_the_published_divisor_for_age_%i', (age, divisor) => {
    expect(RMD_DIVISORS.values[2024].uniformLifetime[age]).toBe(divisor);
  });

  it('should_have_at_least_one_year_entry', () => {
    const keys = Object.keys(RMD_DIVISORS.values);
    expect(keys.length).toBeGreaterThan(0);
  });

  it('should_cover_ages_73_through_120_for_every_year', () => {
    for (const [year, table] of Object.entries(RMD_DIVISORS.values)) {
      for (let age = 73; age <= 120; age++) {
        const divisor = table.uniformLifetime[age];
        expect(
          divisor,
          `year ${year}: missing divisor for age ${age}`,
        ).toBeDefined();
        expect(
          typeof divisor,
          `year ${year}: divisor for age ${age} must be a number`,
        ).toBe('number');
        expect(
          divisor,
          `year ${year}: divisor for age ${age} must be > 0`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('should_have_divisors_in_strictly_descending_order_73_through_120', () => {
    for (const [year, table] of Object.entries(RMD_DIVISORS.values)) {
      for (let age = 74; age <= 120; age++) {
        const prev = table.uniformLifetime[age - 1];
        const curr = table.uniformLifetime[age];
        expect(
          curr,
          `year ${year}: divisor at age ${age} (${curr}) must be < divisor at age ${age - 1} (${prev})`,
        ).toBeLessThan(prev);
      }
    }
  });
});

describe('RMD life-expectancy tables', () => {
  const { singleLife: SINGLE_LIFE_TABLE_I, jointLastSurvivor: JOINT_LIFE_TABLE_II } = RMD_LIFE_EXPECTANCY_TABLES;

  it('Table III (Uniform Lifetime) aliases the verified RMD_DIVISORS seed exactly', () => {
    expect(RMD_LIFE_EXPECTANCY_TABLES.uniformLifetime).toBe(RMD_DIVISORS);
  });

  it('Table I (Single Life) + Table II (Joint Life) carry the STABLE archived-PDF permalink (not the landing page)', () => {
    for (const t of [SINGLE_LIFE_TABLE_I, JOINT_LIFE_TABLE_II]) {
      expect(t.metadata.source).toContain('pub/irs-prior/p590b');
      expect(t.metadata.source).not.toContain('publications/p590b');
      expect(t.metadata.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(t.metadata.jurisdiction).toBe('US-federal');
    }
  });

  it('Table I is fully populated (ages 0–120, 121 entries)', () => {
    const singleLife = SINGLE_LIFE_TABLE_I.values[2024].singleLife;
    expect(Object.keys(singleLife)).toHaveLength(121);
    for (let age = 0; age <= 120; age++) {
      expect(typeof singleLife[age], `missing Table I entry for age ${age}`).toBe('number');
      expect(singleLife[age]).toBeGreaterThan(0);
    }
  });

  it('Table II is a fully populated symmetric 101×101 matrix (ages 20–120)', () => {
    const joint = JOINT_LIFE_TABLE_II.values[2024].jointLastSurvivor;
    const owners = Object.keys(joint).map(Number);
    expect(owners).toHaveLength(101);
    for (let a = 20; a <= 120; a++) {
      expect(Object.keys(joint[a])).toHaveLength(101);
      for (let b = 20; b <= 120; b++) {
        expect(typeof joint[a][b], `missing Table II entry for ${a}/${b}`).toBe('number');
        expect(joint[a][b], `asymmetry at ${a}/${b}`).toBe(joint[b][a]);
      }
    }
  });

  it('Table I exact fixtures — ages 0, 73, 90, 120', () => {
    const singleLife = SINGLE_LIFE_TABLE_I.values[2024].singleLife;
    expect(singleLife[0]).toBe(84.6);
    expect(singleLife[73]).toBe(16.4);
    expect(singleLife[90]).toBe(5.7);
    expect(singleLife[120]).toBe(1.0);
  });

  it('Table II exact fixtures — symmetric pair 30/50, same-age 73/73, boundary 20/120', () => {
    const joint = JOINT_LIFE_TABLE_II.values[2024].jointLastSurvivor;
    expect(joint[30][50]).toBe(56.6);
    expect(joint[30][50]).toBe(joint[50][30]); // symmetry
    expect(joint[73][73]).toBe(20.7);
    expect(joint[20][120]).toBe(65.0);
    expect(joint[20][120]).toBe(joint[120][20]); // boundary symmetry
  });
});

describe('selectRmdTableDivisor', () => {
  const TABLES = RMD_LIFE_EXPECTANCY_TABLES;

  it('returns the exact Uniform Lifetime (Table III) divisor at age 73', () => {
    expect(selectRmdTableDivisor({ table: 'uniformLifetime', ownerAge: 73 }, TABLES, 2025)).toEqual({
      kind: 'divisor',
      table: 'uniformLifetime',
      divisor: 26.5,
    });
  });

  it('clamps an owner age above 120 to the Table III floor divisor 2.0', () => {
    expect(
      selectRmdTableDivisor({ table: 'uniformLifetime', ownerAge: 130 }, TABLES, 2025),
    ).toMatchObject({ kind: 'divisor', divisor: 2.0 });
  });

  it('returns the exact Single Life (Table I) divisor for a spouse recalculation lookup', () => {
    expect(
      selectRmdTableDivisor({ table: 'singleLife', mode: 'recalculate', age: 62 }, TABLES, 2025),
    ).toMatchObject({ kind: 'divisor', table: 'singleLife', divisor: 25.4 });
  });

  it('anchors + decrements a non-spouse Single Life (Table I) divisor by exactly 1.0/yr', () => {
    const base = selectRmdTableDivisor(
      { table: 'singleLife', mode: 'anchoredDecrement', baseAge: 55, elapsedYears: 0 },
      TABLES,
      2025,
    );
    expect(base).toMatchObject({ kind: 'divisor', divisor: 31.6 }); // Table I[55]
    expect(
      selectRmdTableDivisor(
        { table: 'singleLife', mode: 'anchoredDecrement', baseAge: 55, elapsedYears: 2 },
        TABLES,
        2025,
      ),
    ).toMatchObject({ kind: 'divisor', divisor: 29.6 }); // 31.6 − 2.0
  });

  it('WITHHOLDS an anchored Single Life request once the schedule is exhausted (divisor ≤ 0)', () => {
    const r = selectRmdTableDivisor(
      { table: 'singleLife', mode: 'anchoredDecrement', baseAge: 120, elapsedYears: 5 },
      TABLES,
      2025,
    );
    expect(r.kind).toBe('withheld'); // Table I[120] = 1.0, minus 5 → non-positive
  });

  it('returns the exact Joint Life (Table II) divisor for a populated owner/beneficiary pair', () => {
    const r = selectRmdTableDivisor(
      { table: 'jointLastSurvivor', ownerAge: 73, beneficiaryAge: 73 },
      TABLES,
      2025,
    );
    expect(r).toMatchObject({ kind: 'divisor', table: 'jointLastSurvivor', divisor: 20.7 });
  });

  it('WITHHOLDS a Uniform Lifetime request for a tax year below the snapshot (no entry)', () => {
    const r = selectRmdTableDivisor({ table: 'uniformLifetime', ownerAge: 73 }, TABLES, 2000);
    expect(r.kind).toBe('withheld');
  });

  // Malformed age / taxYear inputs WITHHOLD, never silently clamp.
  it.each([
    ['NaN age', Number.NaN],
    ['Infinity age', Number.POSITIVE_INFINITY],
    ['negative age', -1],
    ['fractional age', 73.5],
  ])('WITHHOLDS a Uniform Lifetime request for a malformed %s', (_label, age) => {
    const r = selectRmdTableDivisor({ table: 'uniformLifetime', ownerAge: age }, TABLES, 2025);
    expect(r.kind).toBe('withheld');
  });

  it.each([
    ['NaN taxYear', Number.NaN],
    ['Infinity taxYear', Number.POSITIVE_INFINITY],
    ['negative taxYear', -1],
    ['fractional taxYear', 2025.5],
  ])('WITHHOLDS a Uniform Lifetime request for a malformed %s', (_label, taxYear) => {
    const r = selectRmdTableDivisor({ table: 'uniformLifetime', ownerAge: 80 }, TABLES, taxYear);
    expect(r.kind).toBe('withheld');
  });

  it('WITHHOLDS a Single Life recalculation request for a malformed (Infinite) age', () => {
    const r = selectRmdTableDivisor(
      { table: 'singleLife', mode: 'recalculate', age: Number.POSITIVE_INFINITY },
      TABLES,
      2025,
    );
    expect(r.kind).toBe('withheld');
  });
});

describe('selectRmdTableDivisor — clamp-to-latest snapshot boundary', () => {
  const SYNTH: RmdLifeExpectancyTables = {
    uniformLifetime: {
      values: {
        2024: { uniformLifetime: { 73: 10 } },
        2030: { uniformLifetime: { 73: 20 } },
      },
      metadata: { source: 'test', asOfDate: '2024-01-01', jurisdiction: 'US-federal' },
    },
    singleLife: RMD_LIFE_EXPECTANCY_TABLES.singleLife,
    jointLastSurvivor: RMD_LIFE_EXPECTANCY_TABLES.jointLastSurvivor,
  };

  it('resolves the year immediately before / exactly at / immediately after the second key', () => {
    expect(selectRmdTableDivisor({ table: 'uniformLifetime', ownerAge: 73 }, SYNTH, 2029)).toMatchObject({
      kind: 'divisor',
      divisor: 10,
    });
    expect(selectRmdTableDivisor({ table: 'uniformLifetime', ownerAge: 73 }, SYNTH, 2030)).toMatchObject({
      kind: 'divisor',
    });
    expect(selectRmdTableDivisor({ table: 'uniformLifetime', ownerAge: 73 }, SYNTH, 2031)).toMatchObject({
      kind: 'divisor',
      divisor: 20,
    });
  });
});
