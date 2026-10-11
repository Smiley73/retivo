import { describe, expect, it } from 'vitest';
import { jsonEq } from './json-eq';

describe('jsonEq', () => {
  it('should_return_true_for_structurally_equal_values', () => {
    expect(jsonEq({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] })).toBe(true);
    expect(jsonEq('x', 'x')).toBe(true);
  });

  it('should_treat_undefined_and_null_as_equal', () => {
    expect(jsonEq(undefined, null)).toBe(true);
    expect(jsonEq(null, undefined)).toBe(true);
  });

  it('should_return_false_for_differing_values', () => {
    expect(jsonEq({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEq({ a: 1 }, undefined)).toBe(false);
  });
});
