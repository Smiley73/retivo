import { randomUUID } from 'node:crypto';
import { dtoViolations } from '../../test/dto-validation.js';
import { PasskeyAuthenticateFinishDto, PasskeyRegisterFinishDto } from './passkey.dto.js';

const authentication = () => ({
  id: 'x',
  rawId: 'eA',
  response: { clientDataJSON: 'eA', authenticatorData: 'eA', signature: 'eA' },
  clientExtensionResults: {},
  type: 'public-key',
});

const registration = () => ({
  id: 'cred',
  rawId: 'cred',
  response: { clientDataJSON: 'eA', attestationObject: 'eA' },
  clientExtensionResults: {},
  type: 'public-key',
});

describe('PasskeyRegisterFinishDto', () => {
  it('accepts a well-formed body', () => {
    expect(
      dtoViolations(PasskeyRegisterFinishDto, {
        response: registration(),
        stepUp: { currentPassword: 'a-password' },
      }),
    ).toEqual([]);
  });

  it('rejects a response that is not an object', () => {
    expect(
      dtoViolations(PasskeyRegisterFinishDto, {
        response: 'not-an-object',
        stepUp: { currentPassword: 'a-password' },
      }),
    ).toContain('response:isObject');
  });

  it('rejects an empty body', () => {
    expect(dtoViolations(PasskeyRegisterFinishDto, {})).toEqual(
      expect.arrayContaining(['response:isObject', 'stepUp:isDefined']),
    );
  });
});

describe('PasskeyAuthenticateFinishDto', () => {
  it('accepts a well-formed body', () => {
    expect(
      dtoViolations(PasskeyAuthenticateFinishDto, {
        deviceId: randomUUID(),
        response: authentication(),
      }),
    ).toEqual([]);
  });

  it('rejects a missing deviceId', () => {
    expect(dtoViolations(PasskeyAuthenticateFinishDto, { response: authentication() })).toContain(
      'deviceId:isUuid',
    );
  });

  it('rejects a non-uuid deviceId', () => {
    expect(
      dtoViolations(PasskeyAuthenticateFinishDto, {
        deviceId: 'not-a-uuid',
        response: authentication(),
      }),
    ).toContain('deviceId:isUuid');
  });
});
