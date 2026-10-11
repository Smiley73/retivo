/**
 * Cash Balance Pension remediation banner. Surfaces every CBP account
 * that needs the user's attention before any engine should run —
 * unconfigured (no linked income stream) or duplicate (multiple linked
 * streams). Shared across the Balance Projection, Monte Carlo, and
 * stress-test surfaces so the remediation prompt looks identical
 * everywhere.
 *
 * Each row carries a direct link to the Income form so the user can
 * configure / disambiguate the linked stream in one click. The form
 * understands the deep-link query parameters
 * (`linkedCbpAccountId`, `memberId`, `kind=pension`, `payoutType`).
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
    // Danger-toned card (legacy `.card .card--danger`) re-expressed in
    // Tailwind defaults; kept a <section role="alert"> so the
    // remediation prompt is announced as a live region (preserved a11y).
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
