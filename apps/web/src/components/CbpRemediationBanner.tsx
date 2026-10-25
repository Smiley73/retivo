/**
 * Banner listing every Cash Balance Pension account that is unconfigured or duplicated, shared across the projection
 * surfaces; each row deep-links to the Income form.
 */
import React from 'react';
import { textLinkClass } from './TextLink';
import { Link } from 'react-router';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import type { CbpValidationResult } from '../lib/cbp-resolution';
import { incomeAddPath } from '../lib/cbp-resolution';
import { memberLabel } from '../lib/expense-format';

interface Props {
  readonly validation: CbpValidationResult;
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
}

export const CbpRemediationBanner: React.FC<Props> = ({
  validation,
  accounts,
  members,
}) => {
  if (validation.ok) return null;

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const unconfigured = validation.unconfigured
    .map((id) => byId.get(id))
    .filter((a): a is Aggregate<AccountPayload> => Boolean(a));
  const duplicates = validation.annuityDuplicateStream
    .map((id) => byId.get(id))
    .filter((a): a is Aggregate<AccountPayload> => Boolean(a));

  return (
    // A `<section role="alert">` so the remediation prompt is announced as a live region.
    <section
      className="mb-4 flex flex-col gap-3 rounded-lg border border-negative/40 bg-negative/5 p-5 shadow-sm"
      role="alert"
      aria-labelledby="cbp-remediation-heading"
    >
      <h2
        id="cbp-remediation-heading"
        className="m-0 text-xl font-semibold text-ink"
      >
        Cash Balance Pension elections need attention
      </h2>
      <p className="m-0 text-muted">
        Projections are paused until every CBP account is linked to
        exactly one pension income stream. Pick a payout type
        (annuity or lump sum) per account and link the stream that
        carries the payment forward.
      </p>
      <ul className="m-0 list-disc pl-5">
        {unconfigured.map((a) => {
          const owner = members.find((m) => m.id === a.payload.ownerId);
          const label = memberLabel(
            owner,
            members,
            owner?.payload.isPrimary === false ? 'secondary' : 'primary',
          );
          return (
            <li key={`unconfigured-${a.id}`}>
              <strong>{a.payload.name}</strong>{' '}
              <span className="text-muted">
                ({label}): no linked income stream.{' '}
              </span>
              <Link
                to={incomeAddPath(a)}
                className={textLinkClass}
              >
                Add a linked pension stream →
              </Link>
            </li>
          );
        })}
        {duplicates.map((a) => {
          const owner = members.find((m) => m.id === a.payload.ownerId);
          const label = memberLabel(
            owner,
            members,
            owner?.payload.isPrimary === false ? 'secondary' : 'primary',
          );
          return (
            <li key={`duplicate-${a.id}`}>
              <strong>{a.payload.name}</strong>{' '}
              <span className="text-muted">
                ({label}): multiple income streams link
                to this account.{' '}
              </span>
              <Link
                to="/income"
                className={textLinkClass}
              >
                Review income streams →
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
