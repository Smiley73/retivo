import { describe, expect, it } from 'vitest';
import {
  scheduleStartToGlideAnchor,
  glideAnchorToScheduleStart,
} from './schedule-anchor-bridge';
import type { GlideAnchor } from '../db/types';

describe('scheduleStartToGlideAnchor (inbound widen)', () => {
  it('passes retirementStart / year through unchanged', () => {
    expect(scheduleStartToGlideAnchor({ kind: 'retirementStart' })).toEqual({
      kind: 'retirementStart',
    });
    expect(scheduleStartToGlideAnchor({ kind: 'year', year: 2040 })).toEqual({
      kind: 'year',
      year: 2040,
    });
  });

  it('keeps an explicit age.memberId', () => {
    expect(
      scheduleStartToGlideAnchor({
        kind: 'age',
        memberId: 'secondary',
        years: 67,
        months: 0,
      }),
    ).toEqual({ kind: 'age', memberId: 'secondary', years: 67, months: 0 });
  });

  it('resolves an owner-implicit age.memberId to the passed memberRole', () => {
    // Income owner-implicit (no stored memberId) resolves to the owner role so the picker displays and bounds the actual owner.
    expect(
      scheduleStartToGlideAnchor(
        { kind: 'age', years: 65, months: 0 },
        { memberRole: 'secondary' },
      ),
    ).toEqual({ kind: 'age', memberId: 'secondary', years: 65, months: 0 });
  });

  it('falls back to primary when neither stored memberId nor memberRole is given', () => {
    expect(
      scheduleStartToGlideAnchor({ kind: 'age', years: 65, months: 0 }),
    ).toEqual({ kind: 'age', memberId: 'primary', years: 65, months: 0 });
  });

  it('preserves a non-zero months on an untouched age (no collapse at the boundary)', () => {
    expect(
      scheduleStartToGlideAnchor({ kind: 'age', years: 65, months: 6 }),
    ).toEqual({ kind: 'age', memberId: 'primary', years: 65, months: 6 });
  });
});

describe('glideAnchorToScheduleStart (outbound narrow)', () => {
  it('passes retirementStart / year through unchanged', () => {
    expect(glideAnchorToScheduleStart({ kind: 'retirementStart' })).toEqual({
      kind: 'retirementStart',
    });
    expect(glideAnchorToScheduleStart({ kind: 'year', year: 2040 })).toEqual({
      kind: 'year',
      year: 2040,
    });
  });

  it('rejects the two impossible glide-only kinds (guards to retirementStart)', () => {
    expect(
      glideAnchorToScheduleStart({
        kind: 'durationFromExpenseStart',
        months: 12,
      }),
    ).toEqual({ kind: 'retirementStart' });
    expect(glideAnchorToScheduleStart({ kind: 'expenseEnd' })).toEqual({
      kind: 'retirementStart',
    });
  });

  describe('age.memberId owner-implicit matrix', () => {
    const age: Extract<GlideAnchor, { kind: 'age' }> = {
      kind: 'age',
      memberId: 'secondary',
      years: 67,
      months: 0,
    };

    it('omits memberId when memberSelectable is false (income non-partTime)', () => {
      expect(
        glideAnchorToScheduleStart(age, { memberSelectable: false }),
      ).toEqual({ kind: 'age', years: 67, months: 0 });
    });

    it('omits memberId when the resolved role equals ownerRole (income owner-implicit)', () => {
      expect(
        glideAnchorToScheduleStart(age, {
          memberSelectable: true,
          ownerRole: 'secondary',
        }),
      ).toEqual({ kind: 'age', years: 67, months: 0 });
    });

    it('keeps memberId for an explicit non-owner pick', () => {
      expect(
        glideAnchorToScheduleStart(age, {
          memberSelectable: true,
          ownerRole: 'primary',
        }),
      ).toEqual({ kind: 'age', memberId: 'secondary', years: 67, months: 0 });
    });

    it('Expense (no opts) always keeps memberId', () => {
      expect(glideAnchorToScheduleStart(age)).toEqual({
        kind: 'age',
        memberId: 'secondary',
        years: 67,
        months: 0,
      });
      expect(
        glideAnchorToScheduleStart({
          kind: 'age',
          memberId: 'primary',
          years: 65,
          months: 0,
        }),
      ).toEqual({ kind: 'age', memberId: 'primary', years: 65, months: 0 });
    });

    it('a memberId-less age resolves to primary and omits when ownerRole is primary', () => {
      expect(
        glideAnchorToScheduleStart(
          { kind: 'age', years: 65, months: 0 },
          { memberSelectable: true, ownerRole: 'primary' },
        ),
      ).toEqual({ kind: 'age', years: 65, months: 0 });
    });
  });
});

describe('round-trip (income owner-implicit partTime)', () => {
  it('a secondary-owned owner-implicit age stays owner-implicit through a years-only edit', () => {
    const anchor = scheduleStartToGlideAnchor(
      { kind: 'age', years: 65, months: 0 },
      { memberRole: 'secondary' },
    );
    expect(anchor).toEqual({
      kind: 'age',
      memberId: 'secondary',
      years: 65,
      months: 0,
    });
    const edited: GlideAnchor = { ...anchor, years: 66 } as GlideAnchor;
    expect(
      glideAnchorToScheduleStart(edited, {
        memberSelectable: true,
        ownerRole: 'secondary',
      }),
    ).toEqual({ kind: 'age', years: 66, months: 0 });
  });

  it('explicitly choosing the non-owner persists the role; re-choosing the owner re-omits it', () => {
    expect(
      glideAnchorToScheduleStart(
        { kind: 'age', memberId: 'secondary', years: 65, months: 0 },
        { memberSelectable: true, ownerRole: 'primary' },
      ),
    ).toEqual({ kind: 'age', memberId: 'secondary', years: 65, months: 0 });
    expect(
      glideAnchorToScheduleStart(
        { kind: 'age', memberId: 'primary', years: 65, months: 0 },
        { memberSelectable: true, ownerRole: 'primary' },
      ),
    ).toEqual({ kind: 'age', years: 65, months: 0 });
  });
});
