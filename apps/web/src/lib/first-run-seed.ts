// Helpers for the shell's first-run primary-member seed (App.tsx): the record decision and the shared account-record request.

import type { MutableRefObject } from 'react';
import type { AccountRecord } from '../auth/types';
import type { HouseholdMemberPayload } from '../db/types';
import { listAggregates } from '../db/store';
import { queueLocalMutation } from '../sync/mutation-queue';
import { cryptoUuid } from './crypto-uuid';
import { hasPrimaryMemberSeeded, markPrimaryMemberSeeded } from './first-run-seed-flag';

export interface PrimaryMemberProfile {
  firstName: string;
  lastName: string;
  birthdate: string;
}

/** The primary member's profile from the account record, or null when any field is missing (the caller falls back to the demo prompt). */
export function primaryMemberProfileFromRecord(
  record: AccountRecord,
): PrimaryMemberProfile | null {
  const { firstName, lastName, birthdate } = record;
  if (!firstName || !lastName || !birthdate) return null;
  return { firstName, lastName, birthdate };
}

/**
 * Shares one account-record request across runs of the first-run effect
 * (StrictMode's double mount, a token refresh): reuse the promise in `ref`, which
 * is cleared on settle if it still holds it, so a failed request leaves nothing behind.
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

function queuePrimaryMember(
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

export type PrimaryMemberSeedResult = 'seeded' | 'already-populated' | 'already-seeded';

async function withSeedLock<T>(householdId: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return fn();
  return await locks.request(`retivo:primary-member-seed:${householdId}`, fn);
}

/**
 * Creates the primary member unless another tab got there first. The caller's
 * checks predate the account-record fetch, so the empty-workspace and flag checks
 * repeat here under a cross-tab lock. The flag is written before the queue call:
 * a throw inside it (which may have partly written) must never lead to a second seed.
 */
export function seedPrimaryMemberOnce(
  householdId: string,
  email: string,
  profile: PrimaryMemberProfile,
): Promise<PrimaryMemberSeedResult> {
  return withSeedLock(householdId, async () => {
    const members = await listAggregates('householdMember');
    if (members.length > 0) return 'already-populated';
    if (hasPrimaryMemberSeeded(householdId)) return 'already-seeded';
    markPrimaryMemberSeeded(householdId);
    await queuePrimaryMember(householdId, email, profile);
    return 'seeded';
  });
}
