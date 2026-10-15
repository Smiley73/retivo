/**
 * Helpers for the shell's first-run primary-member seed (App.tsx): the record
 * decision and the single shared account-record request.
 */
import type { MutableRefObject } from 'react';
import type { AccountRecord } from '../auth/types';
import type { HouseholdMemberPayload } from '../db/types';
import { queueLocalMutation } from '../sync/mutation-queue';
import { cryptoUuid } from './crypto-uuid';

/** The three account-record fields the primary member is built from. */
export interface PrimaryMemberProfile {
  firstName: string;
  lastName: string;
  birthdate: string;
}

/**
 * The primary member's profile from the account record, or null when any of the
 * three fields is missing or empty (accounts from before profile capture, or
 * created directly through the API) — the caller falls back to the demo prompt.
 */
export function primaryMemberProfileFromRecord(
  record: AccountRecord,
): PrimaryMemberProfile | null {
  const { firstName, lastName, birthdate } = record;
  if (!firstName || !lastName || !birthdate) return null;
  return { firstName, lastName, birthdate };
}

/**
 * Share one account-record request across every run of the first-run effect
 * (StrictMode's double mount, a token refresh mid-request): reuse the promise
 * held in `ref`, else start the request and store it. The ref is cleared when
 * the promise settles — only if it still holds the same promise — so a failed
 * request leaves nothing behind and the next run starts a fresh one.
 */
export function fetchRecordOnce(
  ref: MutableRefObject<Promise<AccountRecord> | null>,
  fetchRecord: () => Promise<AccountRecord>,
): Promise<AccountRecord> {
  if (ref.current) return ref.current;
  const promise = fetchRecord();
  ref.current = promise;
  const clear = () => {
    if (ref.current === promise) ref.current = null;
  };
  promise.then(clear, clear);
  return promise;
}

/** Queue the create mutation for the household's primary member. */
export function queuePrimaryMember(
  householdId: string,
  email: string,
  profile: PrimaryMemberProfile,
): Promise<unknown> {
  return queueLocalMutation<HouseholdMemberPayload>({
    type: 'householdMember',
    aggregateId: cryptoUuid(),
    householdId,
    operation: 'create',
    expectedVersion: 0,
    payload: {
      isPrimary: true,
      firstName: profile.firstName,
      lastName: profile.lastName,
      email,
      birthdate: profile.birthdate,
    },
  });
}
