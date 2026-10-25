import 'reflect-metadata';
import { dtoViolations } from '../../test/dto-validation.js';
import {
  EncryptedWorkspaceResetDto,
  PasskeyRemoveDto,
  UpdateAccountDto,
  UpsertKeyEnvelopeDto,
} from './auth.dto.js';

describe('UpdateAccountDto', () => {
  const valid = { firstName: 'Alicia', lastName: 'Smythe', birthdate: '1971-05-13' };

  it('accepts a well-formed body', () => {
    expect(dtoViolations(UpdateAccountDto, valid)).toEqual([]);
  });

  it('rejects a future birthdate', () => {
    expect(dtoViolations(UpdateAccountDto, { ...valid, birthdate: '2999-01-01' })).toContain(
      'birthdate:birthdateInSupportedRange',
    );
  });

  it('rejects a birthdate more than 120 years ago', () => {
    expect(dtoViolations(UpdateAccountDto, { ...valid, birthdate: '1800-01-01' })).toContain(
      'birthdate:birthdateInSupportedRange',
    );
  });

  it('rejects a blank or whitespace-only name', () => {
    expect(dtoViolations(UpdateAccountDto, { ...valid, firstName: '   ' })).toContain(
      'firstName:matches',
    );
  });

  describe('on a leap day', () => {
    beforeEach(() => jest.useFakeTimers({ now: new Date('2020-02-29T12:00:00Z') }));
    afterEach(() => jest.useRealTimers());

    it('clamps the 120-year minimum to Feb 28 of a non-leap year', () => {
      expect(dtoViolations(UpdateAccountDto, { ...valid, birthdate: '1900-02-28' })).toEqual([]);
      expect(dtoViolations(UpdateAccountDto, { ...valid, birthdate: '1900-02-27' })).toContain(
        'birthdate:birthdateInSupportedRange',
      );
    });
  });

  it('rejects a name over 80 characters', () => {
    expect(dtoViolations(UpdateAccountDto, { ...valid, firstName: 'A'.repeat(81) })).toContain(
      'firstName:maxLength',
    );
  });
});

describe('UpdateAccountDto — unknown fields', () => {
  it('rejects an unknown property', () => {
    expect(
      dtoViolations(UpdateAccountDto, {
        firstName: 'Alicia',
        lastName: 'Smythe',
        birthdate: '1971-05-13',
        email: 'sneaky@example.test',
      }),
    ).toContain('email:whitelistValidation');
  });
});

describe('PasskeyRemoveDto', () => {
  it('accepts a password-only body', () => {
    expect(dtoViolations(PasskeyRemoveDto, { currentPassword: 'a-password' })).toEqual([]);
  });

  it('rejects a missing currentPassword', () => {
    expect(dtoViolations(PasskeyRemoveDto, {})).toContain('currentPassword:isString');
  });
});

describe('EncryptedWorkspaceResetDto', () => {
  it('accepts the confirmation phrase with a password', () => {
    expect(
      dtoViolations(EncryptedWorkspaceResetDto, {
        confirmation: 'DELETE',
        currentPassword: 'a-password',
      }),
    ).toEqual([]);
  });

  it('rejects a missing currentPassword', () => {
    expect(dtoViolations(EncryptedWorkspaceResetDto, { confirmation: 'DELETE' })).toContain(
      'currentPassword:isString',
    );
  });
});

describe('UpsertKeyEnvelopeDto', () => {
  const body = (): Record<string, unknown> & { slot: Record<string, unknown> } => ({
    slot: {
      householdId: 'hh-1',
      slotId: 'password',
      slotType: 'password',
      kdf: { algorithm: 'PBKDF2-HMAC-SHA-256', iterations: 600_000, salt: 'c2FsdA' },
      wrappedKey: 'd3JhcHBlZA',
      encryptionVersion: 1,
      createdAt: '2026-10-09T00:00:00.000Z',
      updatedAt: '2026-10-09T00:00:00.000Z',
    },
    envelopeSetVersion: 1,
    expectedEnvelopeSetVersion: 0,
    envelopeSetTag: 'dGFnMQ',
  });

  it('accepts a well-formed password-slot body', () => {
    expect(dtoViolations(UpsertKeyEnvelopeDto, body())).toEqual([]);
  });

  it('rejects a slot missing its wrappedKey', () => {
    const b = body();
    delete b.slot.wrappedKey;
    expect(dtoViolations(UpsertKeyEnvelopeDto, b)).toContain('slot.wrappedKey:isString');
  });

  it('rejects a body missing the slot field instead of letting the handler throw', () => {
    const b = body() as Record<string, unknown>;
    delete b.slot;
    expect(dtoViolations(UpsertKeyEnvelopeDto, b)).toEqual(
      expect.arrayContaining(['slot:isDefined', 'slot:isObject']),
    );
  });
});
