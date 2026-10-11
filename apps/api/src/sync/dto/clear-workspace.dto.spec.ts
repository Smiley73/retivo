import { dtoViolations } from '../../test/dto-validation.js';
import { ClearWorkspaceDto } from './clear-workspace.dto.js';

describe('ClearWorkspaceDto', () => {
  const valid = { currentPassword: 'a-password', eraseHistory: false };

  it('accepts a well-formed body', () => {
    expect(dtoViolations(ClearWorkspaceDto, valid)).toEqual([]);
  });

  it('rejects a missing currentPassword', () => {
    expect(dtoViolations(ClearWorkspaceDto, { eraseHistory: false })).toContain(
      'currentPassword:isNotEmpty',
    );
  });

  it('rejects an empty currentPassword', () => {
    expect(dtoViolations(ClearWorkspaceDto, { ...valid, currentPassword: '' })).toContain(
      'currentPassword:isNotEmpty',
    );
  });

  it('rejects an overlong currentPassword', () => {
    expect(
      dtoViolations(ClearWorkspaceDto, { ...valid, currentPassword: 'x'.repeat(257) }),
    ).toContain('currentPassword:maxLength');
  });

  it('rejects a non-boolean eraseHistory', () => {
    expect(dtoViolations(ClearWorkspaceDto, { ...valid, eraseHistory: 'yes' })).toContain(
      'eraseHistory:isBoolean',
    );
  });
});
