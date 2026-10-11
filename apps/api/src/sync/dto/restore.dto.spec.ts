import { dtoViolations } from '../../test/dto-validation.js';
import { RestoreDto } from './restore.dto.js';

describe('RestoreDto', () => {
  it('accepts a compactor-style snapshot id', () => {
    expect(dtoViolations(RestoreDto, { snapshotId: '2026-05-31T12:00:00.000Z' })).toEqual([]);
  });

  it('rejects a snapshot id that could escape the household prefix', () => {
    expect(dtoViolations(RestoreDto, { snapshotId: '../other/snap' })).toContain(
      'snapshotId:matches',
    );
  });
});
