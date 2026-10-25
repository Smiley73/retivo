// The password-reset restriction window for newly enrolled factors, the control against the reset-then-inbox-takeover path: an attacker who
// owns the mailbox satisfies an emailed-code step-up, so step-up alone does not close it.
import { RESET_TTL_SEC } from './password-reset.service.js';
import type { UserRow } from '../dynamo/types.js';

/**
 * Post-completion restriction window, 24 hours: long enough for the owner to notice a reset they did not request,
 * tied to the actual reset event.
 */
export const FACTOR_RESTRICTION_WINDOW_SEC = 24 * 60 * 60;

export type ResetWindowUser = Pick<
  UserRow,
  | 'currentResetToken'
  | 'passwordResetRequestOpenedAt'
  | 'lastPasswordResetCompletedAt'
  | 'lastPasswordResetCompletedRequestedAt'
>;

/**
 * The still-open reset window a factor enrolled at `nowMs` falls inside, or null. A factor is marked restricted
 * durably at write time and stays so after the window closes until `confirm-restriction`; it is never re-derived from
 * these timestamps. The pending branch opens at the request (`passwordResetRequestOpenedAt`) and is bounded to
 * `RESET_TTL_SEC`, so an abandoned `currentResetToken` cannot restrict factors forever. The completed branch stays
 * open `FACTOR_RESTRICTION_WINDOW_SEC` after completion, evaluated against `lastPasswordResetCompletedRequestedAt`,
 * so a later never-consumed request can only widen the window. The branches are resolved independently and unioned.
 * `requestedAt` is the reset REQUEST instant (never completion), the earlier of the two when both are open, so an
 * abandoned request cannot move the comparison forward and let more factors predate it.
 */
export function resolveOpenResetWindow(
  user: ResetWindowUser,
  nowMs: number,
): { requestedAt: string } | null {
  let openRequestedAt: string | null = null;
  let openRequestedMs = Infinity;
  const consider = (requestedAtIso: string, requestedMs: number): void => {
    if (requestedMs < openRequestedMs) {
      openRequestedAt = requestedAtIso;
      openRequestedMs = requestedMs;
    }
  };

  // Pending, unconsumed request, bounded to the reset token TTL.
  const requestedAtIso = user.passwordResetRequestOpenedAt;
  if (requestedAtIso) {
    const requestedMs = Date.parse(requestedAtIso);
    if (
      Number.isFinite(requestedMs) &&
      user.currentResetToken &&
      nowMs - requestedMs < RESET_TTL_SEC * 1000
    ) {
      consider(requestedAtIso, requestedMs);
    }
  }

  // Completed reset still inside its window, resolved from `lastPasswordResetCompletedRequestedAt`, never the
  // overwritable `passwordResetRequestOpenedAt`: otherwise an abandoned second request would close this branch
  // early. Falls back to the completion stamp for rows from before the field.
  const completedAtIso = user.lastPasswordResetCompletedAt;
  if (completedAtIso) {
    const completedMs = Date.parse(completedAtIso);
    if (Number.isFinite(completedMs) && nowMs - completedMs < FACTOR_RESTRICTION_WINDOW_SEC * 1000) {
      const completedRequestedAtIso = user.lastPasswordResetCompletedRequestedAt ?? completedAtIso;
      const completedRequestedMs = Date.parse(completedRequestedAtIso);
      if (Number.isFinite(completedRequestedMs)) {
        consider(completedRequestedAtIso, completedRequestedMs);
      }
    }
  }

  return openRequestedAt !== null ? { requestedAt: openRequestedAt } : null;
}
