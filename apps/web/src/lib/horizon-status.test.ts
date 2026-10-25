import { describe, expect, it } from 'vitest';
import { horizonStatus } from './horizon-status';

describe('horizonStatus', () => {
  it('funded through horizon → not danger', () => {
    expect(
      horizonStatus({ balance: 250_000, depletionYear: null, lastDeathYear: 2070 }),
    ).toEqual({ isDanger: false });
  });

  it('depletes BEFORE the last surviving member dies → danger', () => {
    expect(
      horizonStatus({ balance: 0, depletionYear: 2065, lastDeathYear: 2070 }),
    ).toEqual({ isDanger: true });
  });

  it('depletes AT the last death year (boundary) → danger', () => {
    expect(
      horizonStatus({ balance: 0, depletionYear: 2070, lastDeathYear: 2070 }),
    ).toEqual({ isDanger: true });
  });

  it('depletes AFTER the last death year → not danger', () => {
    expect(
      horizonStatus({ balance: 0, depletionYear: 2075, lastDeathYear: 2070 }),
    ).toEqual({ isDanger: false });
  });

  it('null depletion + zero balance falls back to ending-balance-zero (stress-test path)', () => {
    expect(
      horizonStatus({ balance: 0, depletionYear: null, lastDeathYear: 2070 }),
    ).toEqual({ isDanger: true });
  });

  it('null depletion + negative balance also flags danger', () => {
    expect(
      horizonStatus({ balance: -1, depletionYear: null, lastDeathYear: 2070 }),
    ).toEqual({ isDanger: true });
  });

  it('null balance + null depletion → not danger (drawdown did not run)', () => {
    expect(
      horizonStatus({ balance: null, depletionYear: null, lastDeathYear: 2070 }),
    ).toEqual({ isDanger: false });
  });

  it('null lastDeathYear + non-null depletion → not danger (no comparison possible)', () => {
    expect(
      horizonStatus({ balance: 100, depletionYear: 2060, lastDeathYear: null }),
    ).toEqual({ isDanger: false });
  });
});
