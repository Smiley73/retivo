// Display labels for the two deterministic projection methods; in `lib/` for `lib-independent-of-ui`.

import type { ProjectionMethod } from './balance-projection-runner-types.js';

export const TWR_METHOD_LABEL = 'Historical';

export const PROJECTION_METHOD_LABELS: Readonly<Record<ProjectionMethod, string>> = {
  planned: 'Planned',
  twr: TWR_METHOD_LABEL,
};

/** Past-performance disclaimer for the Historical method, worded after the SEC's investor bulletin. */
export const PAST_PERFORMANCE_DISCLAIMER =
  'Past performance is not a forecast — your accounts may earn more or less ' +
  'than they have.';
