/**
 * Shared type guard for the domain errors that a projection-consuming page
 * collapses to an empty state instead of re-throwing to ErrorBoundary: an
 * unprojectable tax input, or an incomplete household with no primary member
 * / no resolvable retirement date. Any other error is a real bug and must
 * still re-throw — callers keep their own `throw e` fallback.
 *
 * Extracted (2nd repetition) from RothBETRPage.tsx and
 * WithdrawalGuidancePage.tsx, which both ran the same
 * `e instanceof TaxIntegrationInvalidInputError || e instanceof
 * NoPrimaryRetirementError` predicate in their projection-build catch block.
 */
import { NoPrimaryRetirementError } from './balance-projection-runner';
import { TaxIntegrationInvalidInputError } from './tax-integration-helpers';

/**
 * True when `e` is one of the known "the household/scenario can't be
 * projected yet" signals rather than a real bug.
 */
export function isEmptyProjectionDataError(e: unknown): boolean {
  return (
    e instanceof TaxIntegrationInvalidInputError ||
    e instanceof NoPrimaryRetirementError
  );
}
