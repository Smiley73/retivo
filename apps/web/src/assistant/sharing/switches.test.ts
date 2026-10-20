import { describe, expect, it } from 'vitest';
import { defaultConsentAnswer, createConsentRecord } from './consent';
import { KEEP_SIGNED_IN_LABEL, keepSignedInDescription } from './sentences';
import {
  CONSENT_SWITCHES,
  KEEP_SIGNED_IN_ID,
  SHARING_SWITCHES,
  SHARING_SWITCH_IDS,
  defaultSharingChoices,
  withheldSwitches,
} from './switches';

describe('the switch registry', () => {
  it('lists the ten sharing switches then the session switch, once each, in screen order', () => {
    expect(CONSENT_SWITCHES.map((definition) => definition.id)).toEqual([...SHARING_SWITCH_IDS, KEEP_SIGNED_IN_ID]);
    expect(CONSENT_SWITCHES.map((definition) => definition.group)).toEqual([...SHARING_SWITCH_IDS.map(() => 'sharing'), 'session']);
  });

  it('turns every sharing switch on and keep-signed-in off by default', () => {
    expect(Object.values(defaultSharingChoices()).every(Boolean)).toBe(true);
    expect(defaultConsentAnswer().keepSignedInWhileActive).toBe(false);
    expect(CONSENT_SWITCHES.find((definition) => definition.id === KEEP_SIGNED_IN_ID)?.defaultOn).toBe(false);
  });

  it('words every sharing switch as "share this" and says what off does under it', () => {
    for (const definition of SHARING_SWITCHES) {
      expect(definition.label, definition.id).not.toMatch(/^(don’t|do not|hide|withhold|round)/i);
      expect(definition.describe({ idleMinutes: 30 }), definition.id).toContain(`Off: ${definition.offDescription}`);
    }
  });

  it('keeps dollar exactness and first names as one switch each, not an inverse pair', () => {
    expect(SHARING_SWITCH_IDS.filter((id) => /round|role/i.test(id))).toEqual([]);
    expect(SHARING_SWITCH_IDS).toContain('exactDollars');
    expect(SHARING_SWITCH_IDS).toContain('firstNames');
  });

  it('labels the session switch word for word and describes the configured minutes', () => {
    const keep = CONSENT_SWITCHES.at(-1)!;
    expect(keep.label).toBe('Let assistant activity keep me signed in');
    expect(keep.label).toBe(KEEP_SIGNED_IN_LABEL);
    expect(keep.describe({ idleMinutes: 45 })).toBe(keepSignedInDescription(45));
    expect(keepSignedInDescription(1)).toContain('after 1 minute without');
    expect(keepSignedInDescription(45)).toContain('after 45 minutes without');
    expect(keepSignedInDescription(45)).toMatch(/Signing out, Disconnect, closing this tab and locking still end the session\.$/);
  });

  it('names the switches that are off, in screen order', () => {
    const choices = { ...defaultSharingChoices(), firstNames: false, balances: false };
    expect(withheldSwitches(choices)).toEqual(['balances', 'firstNames']);
  });
});

describe('the consent record', () => {
  it('binds the answer to a session, copies it and freezes it', () => {
    const answer = { ...defaultConsentAnswer(), keepSignedInWhileActive: true };
    const record = createConsentRecord(answer, 1234, 7);
    answer.choices.notes = false;
    expect(record).toMatchObject({ keepSignedInWhileActive: true, grantedAt: 1234, sessionId: 7 });
    expect(record.choices.notes).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.choices)).toBe(true);
  });

  it('reads anything but true as off, so a malformed answer never widens what is shared', () => {
    const sloppy = { choices: { members: 'yes' }, keepSignedInWhileActive: 'true' } as never;
    const record = createConsentRecord(sloppy, 0, 1);
    expect(Object.values(record.choices).every((value) => value === false)).toBe(true);
    expect(record.keepSignedInWhileActive).toBe(false);
  });
});
