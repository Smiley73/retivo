// Type guard for the domain errors a projection page collapses to an empty state (unprojectable tax input, or no primary
// member or retirement date); any other error is a real bug, so callers keep their own `throw e`.

import { NoPrimaryRetirementError } from './balance-projection-runner';
import { TaxIntegrationInvalidInputError } from './tax-integration-helpers';

/** True when `e` means the household or scenario cannot be projected yet. */
export function isEmptyProjectionDataError(e: unknown): boolean {
  return (
    e instanceof TaxIntegrationInvalidInputError ||
    e instanceof NoPrimaryRetirementError
  );
}
