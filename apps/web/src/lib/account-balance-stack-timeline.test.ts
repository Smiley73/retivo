/**
 * account-balance-stack-timeline — unified-timeline assembly.
 *
 * Behavior-named coverage:
 *  - historical region stays nominal under both display modes; projected region
 *    deflates (the display-toggle contract);
 *  - accumulation source switches between deterministic + MC shapes (the rows
 *    differ when the source differs);
 *  - drawdown overrides accumulation for shared years;
 *  - the boundary year equals the last actual year.
 */
import { describe, expect, it } from 'vitest';
import {
  assembleAccountBalanceStackTimeline,
  type AccumulationYearRow,
} from './account-balance-stack-timeline';
import type { HistoryYearRow } from './account-balance-stack-history';
import type { DrawdownYear } from './drawdown-engine-types';

function history(year: number, balance: number): HistoryYearRow {
  return {
    year,
    accountBalances: new Map([
      ['a', { balance, preEnd: balance, postEnd: 0, carriedForward: false }],
    ]),
  };
}

function accum(year: number, balance: number): AccumulationYearRow {
  return {
    year,
    accountBalances: new Map([
      ['a', { balance, preEnd: balance, postEnd: 0 }],
    ]),
  };
}

function drawdown(year: number, balance: number): DrawdownYear {
  return {
    year,
    balance,
    withdrawn: 0,
    netNeed: 0,
    growth: 0,
    deposit: 0,
    depleted: false,
    accountBalances: new Map([
      ['a', { balance, preEnd: balance, postEnd: 0, withdrawn: 0, deposit: 0 }],
    ]),
  };
}

describe('assembleAccountBalanceStackTimeline', () => {
  it('keeps historical rows nominal while deflating the projected region (display toggle)', () => {
    const historical = [history(2020, 100), history(2021, 110)];
    const accumulation = [accum(2022, 120)];

    const todayDollars = assembleAccountBalanceStackTimeline({
      historical,
      accumulation,
      drawdown: [],
      lastActualYear: 2021,
      basisDeflator: () => 0.5, // a meaningful Today's-dollars deflation
    });
    const futureDollars = assembleAccountBalanceStackTimeline({
      historical,
      accumulation,
      drawdown: [],
      lastActualYear: 2021,
      basisDeflator: () => 1, // Future dollars: no deflation
    });

    const histToday = todayDollars.rows.filter((r) => r.year <= 2021);
    const histFuture = futureDollars.rows.filter((r) => r.year <= 2021);
    // Pre-boundary (historical) values are byte-identical across modes.
    expect(histToday.map((r) => r.accountBalances.get('a')?.balance)).toEqual(
      histFuture.map((r) => r.accountBalances.get('a')?.balance),
    );

    // Post-boundary (projected) values differ: 120 * 0.5 vs 120 * 1.
    const projToday = todayDollars.rows.find((r) => r.year === 2022);
    const projFuture = futureDollars.rows.find((r) => r.year === 2022);
    expect(projToday?.accountBalances.get('a')?.balance).toBe(60);
    expect(projFuture?.accountBalances.get('a')?.balance).toBe(120);
  });

  it('sources the accumulation region from the supplied rows (deterministic vs MC differ)', () => {
    const historical = [history(2021, 110)];
    const deterministic = assembleAccountBalanceStackTimeline({
      historical,
      accumulation: [accum(2022, 120)],
      drawdown: [],
      lastActualYear: 2021,
      basisDeflator: () => 1,
    });
    const mc = assembleAccountBalanceStackTimeline({
      historical,
      accumulation: [accum(2022, 999)], // a different representative path
      drawdown: [],
      lastActualYear: 2021,
      basisDeflator: () => 1,
    });
    expect(
      deterministic.rows.find((r) => r.year === 2022)?.accountBalances.get('a')
        ?.balance,
    ).toBe(120);
    expect(
      mc.rows.find((r) => r.year === 2022)?.accountBalances.get('a')?.balance,
    ).toBe(999);
  });

  it('lets drawdown override accumulation for a shared projected year', () => {
    const out = assembleAccountBalanceStackTimeline({
      historical: [history(2021, 110)],
      accumulation: [accum(2030, 200)],
      drawdown: [drawdown(2030, 175)],
      lastActualYear: 2021,
      basisDeflator: () => 1,
    });
    expect(
      out.rows.find((r) => r.year === 2030)?.accountBalances.get('a')?.balance,
    ).toBe(175);
  });

  it('marks projected rows zone=projected and historical rows zone=actual', () => {
    const out = assembleAccountBalanceStackTimeline({
      historical: [history(2021, 110)],
      accumulation: [accum(2022, 120)],
      drawdown: [],
      lastActualYear: 2021,
      basisDeflator: () => 1,
    });
    expect(out.rows.find((r) => r.year === 2021)?.zone).toBe('actual');
    expect(out.rows.find((r) => r.year === 2022)?.zone).toBe('projected');
    expect(out.boundaryYear).toBe(2021);
  });
});
