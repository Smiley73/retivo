/**
 * What the person agreed to, for one session. The record lives in the session's
 * memory and dies with it (nothing on disk, so `clearAllLocalData()` has nothing
 * to clear); row 4's dispatcher and idle hook read it from the session, never a
 * copy. Choices are fixed once allowed: to change them the person disconnects
 * and pairs again.
 */
import { defaultSharingChoices, SHARING_SWITCH_IDS, type SharingChoices } from './switches';

/** What the dialog resolves with when the person allows. */
export interface ConsentAnswer {
  choices: SharingChoices;
  /** The D7 switch: completed calls count as activity for the idle timer. */
  keepSignedInWhileActive: boolean;
}

export interface ConsentRecord extends ConsentAnswer {
  /** When the person allowed, in the session clock's milliseconds. */
  grantedAt: number;
  /** The session this record is bound to; a record never outlives or crosses sessions. */
  sessionId: number;
}

/** Every switch at its default: sharing on, keep-signed-in off. */
export function defaultConsentAnswer(): ConsentAnswer {
  return { choices: defaultSharingChoices(), keepSignedInWhileActive: false };
}

/** Binds an answer to a session. The choices are copied and frozen so nothing edits them mid-session. */
export function createConsentRecord(answer: ConsentAnswer, grantedAt: number, sessionId: number): ConsentRecord {
  const choices = {} as SharingChoices;
  for (const id of SHARING_SWITCH_IDS) choices[id] = answer.choices[id] === true;
  return Object.freeze({
    choices: Object.freeze(choices),
    keepSignedInWhileActive: answer.keepSignedInWhileActive === true,
    grantedAt,
    sessionId,
  });
}
