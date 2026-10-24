// Display labels for the two deterministic projection methods, shared by every surface that names one; in `lib/` for `lib-independent-of-ui`.

import type { ProjectionMethod } from './balance-projection-runner-types.js';

export const TWR_METHOD_LABEL = 'Historical';

export const PROJECTION_METHOD_LABELS: Readonly<Record<ProjectionMethod, string>> = {
  planned: 'Planned',
  twr: TWR_METHOD_LABEL,
};

/**
 * Past-performance disclaimer for the Historical method (wording follows the
 * SEC's investor bulletin). The methodology modal and report word their own
 * simulated-history version.
 */
export const PAST_PERFORMANCE_DISCLAIMER =
  'Past performance is not a forecast — your accounts may earn more or less ' +
  'than they have.';
