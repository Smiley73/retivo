import { randomUUID } from 'node:crypto';
import { dtoViolations } from '../../test/dto-validation.js';
import { MfaDisableDto, MfaVerifyDto } from './mfa.dto.js';

const assertion = () => ({
  id: 'cred-id',
  rawId: 'AAAA',
  response: { clientDataJSON: 'AAAA', authenticatorData: 'AAAA', signature: 'AAAA' },
  clientExtensionResults: {},
  type: 'public-key',
});

describe('MfaVerifyDto — method-conditional proof', () => {
  const base = () => ({ challengeToken: 'challenge', deviceId: randomUUID() });

  it('accepts a code factor with only a code and a passkey with only a response', () => {
    expect(dtoViolations(MfaVerifyDto, { ...base(), method: 'totp', code: '123456' })).toEqual([]);
    expect(
      dtoViolations(MfaVerifyDto, { ...base(), method: 'passkey', response: assertion() }),
    ).toEqual([]);
  });

  it('rejects method=passkey carrying only a code (no response)', () => {
    const violations = dtoViolations(MfaVerifyDto, {
      ...base(),
      method: 'passkey',
      code: '123456',
    });
    expect(violations).toContain('method:mfaProofMatchesMethod');
    expect(violations).toContain('response:isObject');
  });

  it('rejects method=totp without a code', () => {
    expect(dtoViolations(MfaVerifyDto, { ...base(), method: 'totp' })).toEqual(
      expect.arrayContaining(['code:isNotEmpty']),
    );
  });

  it('rejects an unknown method', () => {
    expect(dtoViolations(MfaVerifyDto, { ...base(), method: 'sms', code: '123456' })).toContain(
      'method:isIn',
    );
  });

  it('rejects a code factor that also carries a response', () => {
    expect(
      dtoViolations(MfaVerifyDto, {
        ...base(),
        method: 'totp',
        code: '123456',
        response: assertion(),
      }),
    ).toContain('method:mfaProofMatchesMethod');
  });

  it('rejects method=passkey that also carries a code', () => {
    expect(
      dtoViolations(MfaVerifyDto, {
        ...base(),
        method: 'passkey',
        code: '123456',
        response: assertion(),
      }),
    ).toContain('method:mfaProofMatchesMethod');
  });
});

describe('MfaDisableDto — retired methods', () => {
  it('rejects the retired backup_code method', () => {
    expect(
      dtoViolations(MfaDisableDto, {
        currentPassword: 'a-password',
        method: 'backup_code',
        code: 'LEGACY-CODE',
      }),
    ).toContain('method:isIn');
  });
});
