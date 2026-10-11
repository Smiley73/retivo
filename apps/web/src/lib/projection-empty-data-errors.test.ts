/**
 * Tests for `isEmptyProjectionDataError` — the shared type guard
 * RothBETRPage and WithdrawalGuidancePage use to collapse a projection build
 * failure to an empty state instead of re-throwing to ErrorBoundary.
 */
import { describe, it, expect } from 'vitest';
import { isEmptyProjectionDataError } from './projection-empty-data-errors';
import { NoPrimaryRetirementError } from './balance-projection-runner';
import { TaxIntegrationInvalidInputError } from './tax-integration-helpers';

describe('isEmptyProjectionDataError', () => {
  it('should_return_true_for_TaxIntegrationInvalidInputError', () => {
    expect(
      isEmptyProjectionDataError(new TaxIntegrationInvalidInputError('bad snapshot')),
    ).toBe(true);
  });

  it('should_return_true_for_NoPrimaryRetirementError', () => {
    expect(isEmptyProjectionDataError(new NoPrimaryRetirementError())).toBe(true);
  });

  it('should_return_false_for_a_generic_Error', () => {
    expect(isEmptyProjectionDataError(new Error('boom'))).toBe(false);
  });

  it('should_return_false_for_a_non_error_value', () => {
    expect(isEmptyProjectionDataError('not an error')).toBe(false);
    expect(isEmptyProjectionDataError(undefined)).toBe(false);
    expect(isEmptyProjectionDataError(null)).toBe(false);
  });
});
