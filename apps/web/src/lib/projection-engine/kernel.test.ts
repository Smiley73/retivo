import { describe, expect, it } from 'vitest';
import { runStepKernel, type StepInputs } from './kernel';

function zeros(n: number): Float64Array {
  return new Float64Array(n);
}

function filled(n: number, v: number): Float64Array {
  return new Float64Array(n).fill(v);
}

function baseInputs(stepCount: number, override: Partial<StepInputs> = {}): StepInputs {
  return {
    mainReturnPct: zeros(stepCount),
    cpiPct: zeros(stepCount),
    contribPre: zeros(stepCount),
    contribPost: zeros(stepCount),
    expense: zeros(stepCount),
    income: zeros(stepCount),
    deposit: zeros(stepCount),
    retirementStepIdx: stepCount,
    initialPre: 0,
    initialPost: 0,
    ...override,
  };
}

describe('runStepKernel', () => {
  it('zero-everything → balance unchanged across the horizon', () => {
    const out = runStepKernel(baseInputs(12, { initialPre: 1000 }));
    expect(out.preEnd[11]).toBe(1000);
    expect(out.postEnd[11]).toBe(0);
    expect(out.depletionStepIdx).toBe(-1);
    expect(out.cumCpi[11]).toBe(1);
  });

  it('constant 0.5%/mo over 12 accumulation steps compounds to 1.005^12', () => {
    const out = runStepKernel(
      baseInputs(12, { initialPre: 1000, mainReturnPct: filled(12, 0.5) }),
    );
    const expected = 1000 * Math.pow(1.005, 12);
    expect(out.preEnd[11]).toBeCloseTo(expected, 6);
  });

  it('CPI tracking is multiplicative across steps', () => {
    const out = runStepKernel(baseInputs(3, { cpiPct: filled(3, 1) }));
    expect(out.cumCpi[0]).toBeCloseTo(1.01, 9);
    expect(out.cumCpi[1]).toBeCloseTo(1.0201, 9);
    expect(out.cumCpi[2]).toBeCloseTo(1.030301, 9);
  });

  it('contributions land before growth each step', () => {
    const inp = baseInputs(1, {
      contribPre: filled(1, 100),
      mainReturnPct: filled(1, 1),
    });
    const out = runStepKernel(inp);
    expect(out.preEnd[0]).toBeCloseTo(101, 9);
    expect(out.contributions[0]).toBe(100);
  });

  it('post-tax bucket isolated from pre-tax contributions', () => {
    const out = runStepKernel(
      baseInputs(1, {
        initialPre: 500,
        initialPost: 500,
        contribPre: filled(1, 100),
        mainReturnPct: filled(1, 0),
      }),
    );
    expect(out.preEnd[0]).toBe(600);
    expect(out.postEnd[0]).toBe(500);
  });

  it('mid-horizon retirement crossover uses default net-need strategy', () => {
    const stepCount = 24;
    const expense = zeros(stepCount);
    for (let i = 12; i < stepCount; i += 1) expense[i] = 100;
    const out = runStepKernel(
      baseInputs(stepCount, {
        initialPre: 1200,
        retirementStepIdx: 12,
        expense,
      }),
    );
    expect(out.withdrawal[12]).toBe(100);
    expect(out.withdrawal[23]).toBe(100);
    expect(out.preEnd[23]).toBeCloseTo(0, 6);
    expect(out.depletionStepIdx).toBe(-1);
  });

  it('depletion fires the first step the target exceeds the pool', () => {
    const out = runStepKernel(
      baseInputs(1, {
        initialPre: 1,
        retirementStepIdx: 0,
        expense: filled(1, 10),
      }),
    );
    expect(out.depletionStepIdx).toBe(0);
    expect(out.withdrawal[0]).toBe(1);
  });

  it('sub-portfolio folds into the pool at retirement', () => {
    const out = runStepKernel(
      baseInputs(2, {
        initialPre: 1000,
        retirementStepIdx: 1,
        subPortfolio: {
          initialBalance: 500,
          returnPct: zeros(1),
        },
      }),
    );
    expect(out.preEnd[1] + out.postEnd[1]).toBeCloseTo(1500, 6);
  });

  it('expense and income drive net-need correctly', () => {
    const out = runStepKernel(
      baseInputs(1, {
        initialPre: 100,
        retirementStepIdx: 0,
        expense: filled(1, 50),
        income: filled(1, 30),
      }),
    );
    expect(out.withdrawal[0]).toBe(20);
    expect(out.preEnd[0] + out.postEnd[0]).toBeCloseTo(80, 6);
  });

  it('pre/post ratio at retirement entry is preserved during drawdown', () => {
    const out = runStepKernel(
      baseInputs(1, {
        initialPre: 50,
        initialPost: 50,
        retirementStepIdx: 0,
        expense: filled(1, 10),
      }),
    );
    expect(out.preEnd[0]).toBeCloseTo(45, 6);
    expect(out.postEnd[0]).toBeCloseTo(45, 6);
  });

});
