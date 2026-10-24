/** CBP remediation banner; renders when cbpResolution.ok === false, otherwise null. */
import React from 'react';
import { CbpRemediationBanner } from '../components/CbpRemediationBanner';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import type { CbpValidationResult } from '../lib/balance-projection-runner-types';

export interface BalanceProjectionCbpBannerProps {
  readonly validation: CbpValidationResult | null;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
}

export const BalanceProjectionCbpBanner: React.FC<BalanceProjectionCbpBannerProps> = ({
  validation,
  accounts,
  members,
}) => {
  if (!validation || validation.ok) return null;
  return (
    <div className="mt-4">
      <CbpRemediationBanner
        validation={validation}
        accounts={[...accounts]}
        members={[...members]}
      />
    </div>
  );
};
