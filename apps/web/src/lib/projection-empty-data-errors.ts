// Domain errors a projection page collapses to an empty state; any other error is a real bug, so callers keep their own `throw e`.

import { NoPrimaryRetirementError } from './balance-projection-runner';
import { TaxIntegrationInvalidInputError } from './tax-integration-helpers';

/** True when `e` means the household or scenario cannot be projected yet: unprojectable tax input, or no primary member or retirement date. */
export function isEmptyProjectionDataError(e: unknown): boolean {
  return (
    e instanceof TaxIntegrationInvalidInputError ||
    e instanceof NoPrimaryRetirementError
  );
}
