/**
 * Tests for filing-status derivation.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveFilingStatus,
  isWellFormedFilingPlan,
  openEndedStatusWindow,
  resolveFilingPlanForYear,
  summarizeFilingPlan,
  unresolvedFilingDetail,
  type FilingPlanContext,
  type FilingPlanResolution,
  type FilingPlanTaxUnit,
  type FilingSummaryContext,
  type FilingPlanUnresolvedReason,
  type FilingStatusWindow,
  type IndividualFilingPlan,
  type JointFilingPlan,
  type ResolvedTaxUnit,
  type SeparateFilingPlan,
  type TaxFilingPlan,
  type TaxUnitFilingStatus,
} from './filing-status';

describe('deriveFilingStatus', () => {
  it('should_return_MFJ_when_both_members_alive_and_no_override', () => {
    expect(deriveFilingStatus({ primaryAlive: true, secondaryAlive: true })).toBe('MFJ');
  });

  it('should_return_Single_when_primary_alive_and_secondary_dead', () => {
    expect(deriveFilingStatus({ primaryAlive: true, secondaryAlive: false })).toBe('Single');
  });

  it('should_return_Single_when_primary_dead_and_secondary_alive', () => {
    expect(deriveFilingStatus({ primaryAlive: false, secondaryAlive: true })).toBe('Single');
  });

  it('should_return_override_HoH_when_both_alive_and_override_is_HoH', () => {
    expect(
      deriveFilingStatus({ primaryAlive: true, secondaryAlive: true, filingStatusOverride: 'HoH' }),
    ).toBe('HoH');
  });

  it('should_return_override_HoH_when_secondary_dead_and_override_is_HoH', () => {
    expect(
      deriveFilingStatus({ primaryAlive: true, secondaryAlive: false, filingStatusOverride: 'HoH' }),
    ).toBe('HoH');
  });

  it('should_return_override_Single_when_both_alive_and_override_is_Single', () => {
    expect(
      deriveFilingStatus({ primaryAlive: true, secondaryAlive: true, filingStatusOverride: 'Single' }),
    ).toBe('Single');
  });
});

describe('resolveFilingPlanForYear', () => {
  const base: FilingPlanContext = {
    hasSecondaryMember: true,
    primaryAlive: true,
    secondaryAlive: true,
    taxYear: 2030,
  };

  describe('explicit filing plan', () => {
    it('should_resolve_joint_plan_to_MFJ_while_both_alive', () => {
      const jointPlan: JointFilingPlan = { kind: 'joint' };
      const res = resolveFilingPlanForYear({ ...base, taxFilingPlan: jointPlan });
      expect(res.kind).toBe('resolved');
      // Assert against the exported resolved-unit contract.
      const expectedStatus: TaxUnitFilingStatus = 'MFJ';
      const expectedUnit: ResolvedTaxUnit = {
        memberIds: ['primary', 'secondary'],
        filingStatus: expectedStatus,
      };
      expect(res).toEqual({ kind: 'resolved', taxUnits: [expectedUnit] });
    });

    it('should_resolve_joint_plan_to_MFJ_in_the_death_year_itself', () => {
      // The dying member still counts as alive in their death year → MFJ.
      const res = resolveFilingPlanForYear({
        ...base,
        taxFilingPlan: { kind: 'joint' },
        secondaryAlive: true,
      });
      expect(res).toEqual({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['primary', 'secondary'], filingStatus: 'MFJ' }],
      });
    });

    it('should_resolve_joint_plan_to_Single_after_a_spouse_death', () => {
      const res = resolveFilingPlanForYear({
        ...base,
        taxFilingPlan: { kind: 'joint' },
        secondaryAlive: false,
      });
      expect(res).toEqual({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['primary'], filingStatus: 'Single' }],
      });
    });

    it('should_diverge_from_the_frozen_MFJ_scalar_after_death_the_audit_finding_6_fix', () => {
      // Same post-death year: the joint PLAN drops to Single, whereas the frozen
      // scalar keeps filing MFJ. This is the transition-safety fix.
      const ctx: FilingPlanContext = { ...base, secondaryAlive: false };
      const plan = resolveFilingPlanForYear({ ...ctx, taxFilingPlan: { kind: 'joint' } });
      const scalar = resolveFilingPlanForYear({ ...ctx, filingStatusOverride: 'MFJ' });
      expect(plan).toEqual({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['primary'], filingStatus: 'Single' }],
      });
      expect(scalar).toEqual(plan);
    });

    it('should_apply_a_year_bounded_QSS_window_to_the_post_death_survivor', () => {
      const qssWindow: FilingStatusWindow = {
        status: 'QSS',
        start: { kind: 'year', year: 2031 },
        end: { kind: 'year', year: 2033 },
      };
      const plan: TaxFilingPlan = { kind: 'joint', statusWindows: [qssWindow] };
      const inWindow = resolveFilingPlanForYear({
        ...base,
        taxFilingPlan: plan,
        secondaryAlive: false,
        taxYear: 2032,
      });
      expect(inWindow).toEqual({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['primary'], filingStatus: 'QSS' }],
      });
    });

    it('should_treat_the_QSS_window_end_as_exclusive', () => {
      const plan: TaxFilingPlan = {
        kind: 'joint',
        statusWindows: [
          { status: 'QSS', start: { kind: 'year', year: 2031 }, end: { kind: 'year', year: 2033 } },
        ],
      };
      const atEnd = resolveFilingPlanForYear({
        ...base,
        taxFilingPlan: plan,
        secondaryAlive: false,
        taxYear: 2033,
      });
      expect(atEnd).toEqual({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['primary'], filingStatus: 'Single' }],
      });
    });

    it('should_not_override_a_live_MFJ_year_with_a_status_window', () => {
      const plan: TaxFilingPlan = {
        kind: 'joint',
        statusWindows: [
          { status: 'HoH', start: { kind: 'year', year: 2029 }, end: { kind: 'year', year: 2040 } },
        ],
      };
      const res = resolveFilingPlanForYear({ ...base, taxFilingPlan: plan, taxYear: 2030 });
      expect(res).toEqual({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['primary', 'secondary'], filingStatus: 'MFJ' }],
      });
    });

    it('should_resolve_an_age_anchored_window_using_the_birth_year', () => {
      const plan: IndividualFilingPlan = {
        kind: 'individual',
        statusWindows: [
          {
            status: 'HoH',
            start: { kind: 'age', memberId: 'primary', years: 60, months: 0 },
            end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
          },
        ],
      };
      const ctx: FilingPlanContext = {
        hasSecondaryMember: false,
        primaryAlive: true,
        secondaryAlive: false,
        taxYear: 2032,
        primaryBirthYear: 1970, // turns 62 in 2032 → inside [60, 65)
      };
      expect(resolveFilingPlanForYear({ ...ctx, taxFilingPlan: plan })).toEqual({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['primary'], filingStatus: 'HoH' }],
      });
    });

    it('should_treat_an_age_window_as_inactive_when_the_birth_year_is_missing', () => {
      const plan: TaxFilingPlan = {
        kind: 'individual',
        statusWindows: [
          {
            status: 'HoH',
            start: { kind: 'age', memberId: 'primary', years: 60, months: 0 },
            end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
          },
        ],
      };
      const ctx: FilingPlanContext = {
        hasSecondaryMember: false,
        primaryAlive: true,
        secondaryAlive: false,
        taxYear: 2032,
        // primaryBirthYear intentionally absent → the window cannot resolve.
      };
      expect(resolveFilingPlanForYear({ ...ctx, taxFilingPlan: plan })).toEqual({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['primary'], filingStatus: 'Single' }],
      });
    });

    it('should_resolve_separate_units_while_both_alive', () => {
      const primaryUnit: FilingPlanTaxUnit = {
        memberId: 'primary',
        filingStatus: 'MFS',
        householdSize: 1,
      };
      const secondaryUnit: FilingPlanTaxUnit = {
        memberId: 'secondary',
        filingStatus: 'MFS',
        householdSize: 2,
      };
      const plan: SeparateFilingPlan = { kind: 'separate', units: [primaryUnit, secondaryUnit] };
      expect(resolveFilingPlanForYear({ ...base, taxFilingPlan: plan })).toEqual({
        kind: 'resolved',
        taxUnits: [
          { memberIds: ['primary'], filingStatus: 'MFS', householdSize: 1 },
          { memberIds: ['secondary'], filingStatus: 'MFS', householdSize: 2 },
        ],
      });
    });

    it('should_collapse_separate_units_to_the_surviving_Single_unit_after_a_death', () => {
      const plan: TaxFilingPlan = {
        kind: 'separate',
        units: [
          { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
          { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
        ],
      };
      expect(
        resolveFilingPlanForYear({ ...base, taxFilingPlan: plan, primaryAlive: false }),
      ).toEqual({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['secondary'], filingStatus: 'Single' }],
      });
    });

    it('should_resolve_no_tax_units_when_nobody_is_alive', () => {
      expect(
        resolveFilingPlanForYear({
          ...base,
          taxFilingPlan: { kind: 'joint' },
          primaryAlive: false,
          secondaryAlive: false,
        }),
      ).toEqual({ kind: 'resolved', taxUnits: [] });
    });

    it('should_surface_an_unknown_plan_kind_never_throw', () => {
      // Simulate a newer client's plan kind (or corrupt IndexedDB data) reaching
      // this older resolver: `plan.units` is absent, so the old fall-through would
      // throw a TypeError. It must resolve `unresolved`, symmetric with an
      // unknown scalar.
      const corruptPlan = { kind: 'future-status' } as unknown as TaxFilingPlan;
      const res = resolveFilingPlanForYear({ ...base, taxFilingPlan: corruptPlan });
      expect(res.kind).toBe('unresolved');
      const expectedReason: FilingPlanUnresolvedReason = 'unknown-plan-kind';
      if (res.kind === 'unresolved') expect(res.reason).toBe(expectedReason);
    });

    it('unknown_plan_kind_stays_unresolved_when_everybody_is_dead', () => {
      // An unknown `plan.kind` must be flagged regardless of alive-state — it
      // must NOT be swallowed by the all-deceased short-circuit into `[]`,
      // symmetric with the scalar-path invalid/ambiguous combinations.
      const corruptPlan = { kind: 'future-status' } as unknown as TaxFilingPlan;
      const res = resolveFilingPlanForYear({
        ...base,
        taxFilingPlan: corruptPlan,
        primaryAlive: false,
        secondaryAlive: false,
      });
      expect(res.kind).toBe('unresolved');
      const expectedReason: FilingPlanUnresolvedReason = 'unknown-plan-kind';
      if (res.kind === 'unresolved') expect(res.reason).toBe(expectedReason);
    });
  });

  describe('legacy scalar × household-cardinality matrix', () => {
    const oneMember: FilingPlanContext = {
      hasSecondaryMember: false,
      primaryAlive: true,
      secondaryAlive: false,
      taxYear: 2030,
    };

    it('one_member_Single_resolves_to_Single', () => {
      expect(resolveFilingPlanForYear({ ...oneMember, filingStatusOverride: 'Single' })).toEqual({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['primary'], filingStatus: 'Single' }],
      });
    });

    it('one_member_HoH_resolves_to_an_open_ended_HoH_unit', () => {
      expect(resolveFilingPlanForYear({ ...oneMember, filingStatusOverride: 'HoH' })).toEqual({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['primary'], filingStatus: 'HoH' }],
      });
    });

    it('one_member_MFJ_is_flagged_as_an_invalid_combination', () => {
      const res = resolveFilingPlanForYear({ ...oneMember, filingStatusOverride: 'MFJ' });
      expect(res.kind).toBe('unresolved');
      if (res.kind === 'unresolved') expect(res.reason).toBe('one-member-joint-invalid');
    });

    it('two_member_MFJ_resolves_to_a_joint_plan_while_both_alive', () => {
      expect(resolveFilingPlanForYear({ ...base, filingStatusOverride: 'MFJ' })).toEqual({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['primary', 'secondary'], filingStatus: 'MFJ' }],
      });
    });

    it('two_member_MFJ_transitions_to_Single_after_a_death', () => {
      expect(
        resolveFilingPlanForYear({ ...base, filingStatusOverride: 'MFJ', primaryAlive: false }),
      ).toEqual({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['secondary'], filingStatus: 'Single' }],
      });
    });

    it('two_member_Single_is_flagged_as_ambiguous', () => {
      const res = resolveFilingPlanForYear({ ...base, filingStatusOverride: 'Single' });
      expect(res.kind).toBe('unresolved');
      const expectedReason: FilingPlanUnresolvedReason = 'two-member-scalar-ambiguous';
      if (res.kind === 'unresolved') expect(res.reason).toBe(expectedReason);
    });

    it('two_member_HoH_is_flagged_as_ambiguous', () => {
      const res = resolveFilingPlanForYear({ ...base, filingStatusOverride: 'HoH' });
      expect(res.kind).toBe('unresolved');
      if (res.kind === 'unresolved') expect(res.reason).toBe('two-member-scalar-ambiguous');
    });

    it('an_unknown_scalar_value_is_surfaced_never_guessed', () => {
      const res = resolveFilingPlanForYear({
        ...base,
        // Simulate a corrupt / future scalar reaching the resolver.
        filingStatusOverride: 'QSS' as unknown as 'MFJ',
      });
      expect(res.kind).toBe('unresolved');
      if (res.kind === 'unresolved') expect(res.reason).toBe('unknown-scalar');
    });

    it('one_member_MFJ_stays_invalid_even_when_everybody_is_dead', () => {
      // The invalid combination must be flagged regardless of alive-state — it
      // must NOT be swallowed by the all-deceased short-circuit into `[]`.
      const res = resolveFilingPlanForYear({
        ...oneMember,
        filingStatusOverride: 'MFJ',
        primaryAlive: false,
        secondaryAlive: false,
      });
      expect(res.kind).toBe('unresolved');
      if (res.kind === 'unresolved') expect(res.reason).toBe('one-member-joint-invalid');
    });

    it('two_member_Single_stays_ambiguous_even_when_everybody_is_dead', () => {
      const res = resolveFilingPlanForYear({
        ...base,
        filingStatusOverride: 'Single',
        primaryAlive: false,
        secondaryAlive: false,
      });
      expect(res.kind).toBe('unresolved');
      if (res.kind === 'unresolved') expect(res.reason).toBe('two-member-scalar-ambiguous');
    });

    it('two_member_MFJ_still_short_circuits_to_empty_when_everybody_is_dead', () => {
      // A VALID combination is the legitimate all-deceased exception: it resolves
      // cleanly to no tax units.
      expect(
        resolveFilingPlanForYear({
          ...base,
          filingStatusOverride: 'MFJ',
          primaryAlive: false,
          secondaryAlive: false,
        }),
      ).toEqual({ kind: 'resolved', taxUnits: [] });
    });
  });

  describe('no plan and no scalar → household-composition default', () => {
    it('couple_files_MFJ_while_both_alive', () => {
      expect(resolveFilingPlanForYear(base)).toEqual({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['primary', 'secondary'], filingStatus: 'MFJ' }],
      });
    });

    it('couple_files_Single_after_a_death', () => {
      expect(resolveFilingPlanForYear({ ...base, secondaryAlive: false })).toEqual({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['primary'], filingStatus: 'Single' }],
      });
    });

    it('lone_member_files_Single', () => {
      expect(
        resolveFilingPlanForYear({
          ...base,
          hasSecondaryMember: false,
          secondaryAlive: false,
        }),
      ).toEqual({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['primary'], filingStatus: 'Single' }],
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Runtime validation of an untrusted `taxFilingPlan` payload
// ---------------------------------------------------------------------------

describe('resolveFilingPlanForYear — corrupt plan payloads', () => {
  const ctx: FilingPlanContext = {
    hasSecondaryMember: true,
    primaryAlive: true,
    secondaryAlive: true,
    taxYear: 2030,
  };
  /** A malformed payload only a corrupt store / a newer client can produce. */
  const corrupt = (plan: unknown): FilingPlanContext => ({
    ...ctx,
    taxFilingPlan: plan as TaxFilingPlan,
  });
  const expectUnresolved = (plan: unknown): void => {
    const res = resolveFilingPlanForYear(corrupt(plan));
    expect(res.kind).toBe('unresolved');
    if (res.kind !== 'unresolved') throw new Error('unreachable');
    expect(res.reason).toBe<FilingPlanUnresolvedReason>('invalid-plan-shape');
    expect(res.detail.length).toBeGreaterThan(0);
  };

  it('should_return_unresolved_when_separate_plan_has_no_units', () => {
    expectUnresolved({ kind: 'separate' });
  });

  it('should_return_unresolved_when_separate_plan_has_one_unit', () => {
    // A single-entry `units` array would SILENTLY DROP the other spouse — the
    // exact outcome the guard exists to prevent.
    expectUnresolved({
      kind: 'separate',
      units: [{ memberId: 'primary', filingStatus: 'MFS', householdSize: 1 }],
    });
  });

  it('should_return_unresolved_when_both_units_name_the_same_spouse', () => {
    // A duplicate owner would double-count that spouse's accounts on merge.
    expectUnresolved({
      kind: 'separate',
      units: [
        { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
        { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
      ],
    });
  });

  it('should_return_unresolved_when_a_unit_carries_an_unknown_status', () => {
    expectUnresolved({
      kind: 'separate',
      units: [
        { memberId: 'primary', filingStatus: 'NOT_A_STATUS', householdSize: 1 },
        { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
      ],
    });
  });

  it('should_return_unresolved_when_a_unit_household_size_is_invalid', () => {
    expectUnresolved({
      kind: 'separate',
      units: [
        { memberId: 'primary', filingStatus: 'MFS', householdSize: 0 },
        { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
      ],
    });
  });

  it('should_return_unresolved_when_statusWindows_is_not_a_list', () => {
    expectUnresolved({ kind: 'joint', statusWindows: { status: 'QSS' } });
  });

  it('should_return_unresolved_when_a_window_anchor_is_unusable', () => {
    expectUnresolved({
      kind: 'joint',
      statusWindows: [
        { status: 'QSS', start: { kind: 'retirementStart' }, end: { kind: 'year', year: 2032 } },
      ],
    });
  });

  it('should_not_throw_for_any_corrupt_payload', () => {
    // The whole point: a malformed plan must degrade to the legacy fallback,
    // never take down the projection / MC run / report with a TypeError.
    for (const plan of [
      { kind: 'separate' },
      { kind: 'separate', units: 'nope' },
      { kind: 'separate', units: [null, null] },
      { kind: 'joint', statusWindows: [null] },
      { kind: 'individual', statusWindows: [{ status: 'HoH' }] },
    ]) {
      expect(() => resolveFilingPlanForYear(corrupt(plan))).not.toThrow();
    }
  });

  // The stored value's declared type is a compile-time claim only.
  // IndexedDB / sync can hand the resolver a `null`, a JSON array, or a bare
  // primitive, all of which passed the `!== undefined` boundary check and then
  // threw a TypeError on the first `.kind` read — taking down the whole
  // projection instead of routing the year to the legacy-scalar fallback.
  it('should_return_unresolved_when_the_stored_plan_is_null', () => {
    expectUnresolved(null);
  });

  it('should_return_unresolved_when_the_stored_plan_is_a_list', () => {
    expectUnresolved([{ kind: 'joint' }]);
  });

  it('should_return_unresolved_when_the_stored_plan_is_a_primitive', () => {
    expectUnresolved('joint');
    expectUnresolved(42);
    expectUnresolved(true);
  });

  it('should_not_throw_for_a_non_object_payload', () => {
    for (const plan of [null, [], [{ kind: 'joint' }], 'joint', 42, true]) {
      expect(() => resolveFilingPlanForYear(corrupt(plan))).not.toThrow();
    }
  });

  it('should_still_resolve_a_well_formed_separate_plan', () => {
    const plan: SeparateFilingPlan = {
      kind: 'separate',
      units: [
        { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
        { memberId: 'secondary', filingStatus: 'HoH', householdSize: 2 },
      ],
    };
    const res = resolveFilingPlanForYear({ ...ctx, taxFilingPlan: plan });
    expect(res.kind).toBe('resolved');
  });
});

// ---------------------------------------------------------------------------
// A stored plan that no longer matches the household's membership
// ---------------------------------------------------------------------------

describe('resolveFilingPlanForYear — plan vs household cardinality', () => {
  /** A household that added a spouse AFTER an individual plan was saved — a
   *  supported flow (the household editor adds a second member at any time),
   *  so the stored plan is legitimate history, not corrupt data. */
  const coupleWithIndividualPlan: FilingPlanContext = {
    taxFilingPlan: { kind: 'individual' },
    hasSecondaryMember: true,
    primaryAlive: true,
    secondaryAlive: true,
    taxYear: 2030,
  };

  it('should_return_unresolved_for_an_individual_plan_on_a_two_member_household', () => {
    const res = resolveFilingPlanForYear(coupleWithIndividualPlan);
    expect(res.kind).toBe('unresolved');
    if (res.kind !== 'unresolved') throw new Error('unreachable');
    expect(res.reason).toBe<FilingPlanUnresolvedReason>('invalid-plan-shape');
    expect(res.detail).toMatch(/spouse/i);
  });

  it('should_not_file_one_Single_return_for_a_whole_couple', () => {
    // The bug this pins: resolving literally produced ONE `Single` unit covering
    // the couple, taxing both spouses on the narrower single schedule and
    // deduction — silently, since the summary reported it as resolved.
    const res = resolveFilingPlanForYear(coupleWithIndividualPlan);
    expect(res.kind).not.toBe('resolved');
    const summary = summarizeFilingPlan({
      taxFilingPlan: { kind: 'individual' },
      hasSecondaryMember: true,
      taxYear: 2030,
    });
    // The engines keep the legacy derivation (both alive, no scalar → MFJ)
    // and the editor prompts, instead of quietly filing Single.
    expect(summary.headline).toBe('Married filing jointly');
    expect(summary.unresolvedLegacyDetail).toBeDefined();
  });

  it('should_prompt_for_resolution_via_unresolvedFilingDetail', () => {
    expect(
      unresolvedFilingDetail({
        taxFilingPlan: { kind: 'individual' },
        hasSecondaryMember: true,
        taxYear: 2030,
      }),
    ).toMatch(/spouse/i);
  });

  it('should_keep_resolving_an_individual_plan_for_a_one_member_household', () => {
    const res = resolveFilingPlanForYear({
      ...coupleWithIndividualPlan,
      hasSecondaryMember: false,
      secondaryAlive: false,
    });
    expect(res.kind).toBe('resolved');
    if (res.kind !== 'resolved') throw new Error('unreachable');
    expect(res.taxUnits).toEqual([{ memberIds: ['primary'], filingStatus: 'Single' }]);
  });

  it('should_keep_resolving_a_joint_plan_whose_spouse_was_removed', () => {
    // The mirror case needs no guard: with no secondary member the alive-state
    // already collapses a joint plan to the sole member's `Single` return, which
    // is the correct treatment for a one-person household.
    const res = resolveFilingPlanForYear({
      taxFilingPlan: { kind: 'joint' },
      hasSecondaryMember: false,
      primaryAlive: true,
      secondaryAlive: false,
      taxYear: 2030,
    });
    expect(res.kind).toBe('resolved');
    if (res.kind !== 'resolved') throw new Error('unreachable');
    expect(res.taxUnits).toEqual([{ memberIds: ['primary'], filingStatus: 'Single' }]);
  });
});

describe('isWellFormedFilingPlan', () => {
  it('should_reject_an_absent_or_unknown_kind_plan', () => {
    expect(isWellFormedFilingPlan(undefined, false)).toBe(false);
    expect(isWellFormedFilingPlan({ kind: 'future' } as unknown as TaxFilingPlan, false)).toBe(
      false,
    );
  });

  it('should_reject_a_corrupt_separate_payload', () => {
    expect(
      isWellFormedFilingPlan(
        {
          kind: 'separate',
          units: [{ memberId: 'primary', filingStatus: 'MFS', householdSize: 1 }],
        } as unknown as TaxFilingPlan,
        true,
      ),
    ).toBe(false);
  });

  it('should_reject_a_non_object_stored_value', () => {
    // The editor asks this predicate before opening on the stored plan,
    // so a corrupt `null` would crash `initialFilingPlan` on the very tab the
    // resolution prompt links to for repairing it.
    for (const stored of [null, [], [{ kind: 'joint' }], 'joint', 42, true]) {
      expect(isWellFormedFilingPlan(stored, true)).toBe(false);
      expect(isWellFormedFilingPlan(stored, false)).toBe(false);
    }
  });

  it('should_reject_a_plan_that_does_not_match_the_household', () => {
    expect(isWellFormedFilingPlan({ kind: 'individual' }, true)).toBe(false);
    expect(isWellFormedFilingPlan({ kind: 'individual' }, false)).toBe(true);
  });

  it('should_accept_the_plans_the_resolver_accepts', () => {
    expect(isWellFormedFilingPlan({ kind: 'joint' }, true)).toBe(true);
    expect(
      isWellFormedFilingPlan(
        {
          kind: 'separate',
          units: [
            { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
            { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
          ],
          livedTogether: true,
        },
        true,
      ),
    ).toBe(true);
  });
});

describe('resolveFilingPlanForYear — an exception outranks the standing status', () => {
  // The bug this locks down: a one-person plan filing head of household every year
  // (a standing OPEN-ENDED window), with a two-year qualifying-surviving-spouse
  // exception added on top. The editor rendered the QSS row and its statutory
  // two-year warning, so the plan LOOKED configured — but a standing window covers
  // every tax year, so a stored-order first-match scan never reached the exception
  // and those two years were still filed head of household. Materially different
  // tax, silently, with no error or warning on any surface.
  const QSS_START = 2036;
  /** EXCLUSIVE — the window covers 2036 and 2037 only. */
  const QSS_END = 2038;
  const qss: FilingStatusWindow = {
    status: 'QSS',
    start: { kind: 'year', year: QSS_START },
    end: { kind: 'year', year: QSS_END },
  };
  const standingHoH = openEndedStatusWindow('HoH');
  const solo = {
    hasSecondaryMember: false,
    primaryAlive: true,
    secondaryAlive: false,
  } as const;
  const statusIn = (plan: TaxFilingPlan, taxYear: number): TaxUnitFilingStatus | undefined => {
    const res = resolveFilingPlanForYear({ ...solo, taxFilingPlan: plan, taxYear });
    return res.kind === 'resolved' ? res.taxUnits[0]?.filingStatus : undefined;
  };

  // BOTH stored orders resolve identically. The editor now writes the exceptions
  // ahead of the standing window, but a plan written before that (or synced from a
  // client that wrote it the other way) must not be resolved differently — the
  // priority is a property of the two window KINDS, not of their array positions.
  const orders: ReadonlyArray<readonly [string, IndividualFilingPlan]> = [
    ['standing_window_stored_first', { kind: 'individual', statusWindows: [standingHoH, qss] }],
    ['exception_stored_first', { kind: 'individual', statusWindows: [qss, standingHoH] }],
  ];
  for (const [order, plan] of orders) {
    it(`should_file_QSS_in_every_year_the_exception_covers_with_the_${order}`, () => {
      expect(statusIn(plan, QSS_START)).toBe('QSS');
      expect(statusIn(plan, QSS_END - 1)).toBe('QSS');
    });

    it(`should_resume_the_standing_HoH_status_outside_the_exception_with_the_${order}`, () => {
      expect(statusIn(plan, QSS_START - 1)).toBe('HoH');
      // `end` is EXCLUSIVE, so the end year itself is back to the standing status.
      expect(statusIn(plan, QSS_END)).toBe('HoH');
      expect(statusIn(plan, QSS_END + 5)).toBe('HoH');
    });
  }

  it('should_apply_the_same_priority_to_a_couples_post_death_survivor', () => {
    // Same shape on a joint plan: the standing window is a leftover from a spell
    // when the spouse was removed, and the survivor's QSS years must still
    // win against it.
    const plan: JointFilingPlan = { kind: 'joint', statusWindows: [standingHoH, qss] };
    const survivor = (taxYear: number): FilingPlanResolution =>
      resolveFilingPlanForYear({
        taxFilingPlan: plan,
        hasSecondaryMember: true,
        primaryAlive: true,
        secondaryAlive: false,
        taxYear,
      });
    expect(survivor(QSS_START)).toEqual<FilingPlanResolution>({
      kind: 'resolved',
      taxUnits: [{ memberIds: ['primary'], filingStatus: 'QSS' }],
    });
    expect(survivor(QSS_END)).toEqual<FilingPlanResolution>({
      kind: 'resolved',
      taxUnits: [{ memberIds: ['primary'], filingStatus: 'HoH' }],
    });
    // A live MFJ year is still untouched by either window.
    expect(
      resolveFilingPlanForYear({
        taxFilingPlan: plan,
        hasSecondaryMember: true,
        primaryAlive: true,
        secondaryAlive: true,
        taxYear: QSS_START,
      }),
    ).toEqual<FilingPlanResolution>({
      kind: 'resolved',
      taxUnits: [{ memberIds: ['primary', 'secondary'], filingStatus: 'MFJ' }],
    });
  });

  it('should_keep_first_stored_wins_between_two_overlapping_exceptions', () => {
    // Only the standing window is deprioritised. Among year-bounded exceptions the
    // earliest stored one still wins the years they share.
    const laterHoH: FilingStatusWindow = {
      status: 'HoH',
      start: { kind: 'year', year: QSS_START },
      end: { kind: 'year', year: 2050 },
    };
    expect(
      statusIn({ kind: 'individual', statusWindows: [qss, laterHoH] }, QSS_START),
    ).toBe('QSS');
    expect(
      statusIn({ kind: 'individual', statusWindows: [laterHoH, qss] }, QSS_START),
    ).toBe('HoH');
  });

  it('should_list_the_exception_the_engines_really_apply_on_every_summary_surface', () => {
    // The report card and the PDF settings table list `windows`; with the exception
    // genuinely winning its years, listing it is accurate rather than a promise
    // nothing keeps.
    const plan: IndividualFilingPlan = {
      kind: 'individual',
      statusWindows: [standingHoH, qss],
    };
    const summary = summarizeFilingPlan({
      taxFilingPlan: plan,
      hasSecondaryMember: false,
      taxYear: 2030,
    });
    expect(summary.headline).toBe('Head of household');
    expect(summary.windows).toEqual([
      'Qualifying surviving spouse from 2036 up to (but not including) 2038',
    ]);
    expect(statusIn(plan, QSS_START)).toBe('QSS');
  });
});

// ---------------------------------------------------------------------------
// The shared, resolver-backed filing summary
// ---------------------------------------------------------------------------

describe('summarizeFilingPlan', () => {
  it('should_report_the_legacy_status_the_engine_actually_filed_when_unresolved', () => {
    // The regression: a two-member `Single` scalar cannot be converted, so the
    // engines fall back to `deriveFilingStatus` → Single. The on-screen card
    // used to claim "one joint return" while the PDF said "Single".
    const summary = summarizeFilingPlan({
      filingStatusOverride: 'Single',
      hasSecondaryMember: true,
      taxYear: 2030,
    });
    expect(summary.unresolvedLegacyDetail).toBeDefined();
    expect(summary.headline).toBe('Single');
    expect(summary.whileBothAlive).toMatch(/filed as single/i);
    expect(summary.whileBothAlive).not.toMatch(/joint/i);
    // And it agrees with what the resolver+legacy fallback really does.
    expect(
      deriveFilingStatus({
        primaryAlive: true,
        secondaryAlive: true,
        filingStatusOverride: 'Single',
      }),
    ).toBe('Single');
  });

  it('should_describe_a_joint_plan_as_one_joint_return', () => {
    const summary = summarizeFilingPlan({
      taxFilingPlan: { kind: 'joint' },
      hasSecondaryMember: true,
      taxYear: 2030,
    });
    expect(summary.headline).toBe('Married filing jointly');
    expect(summary.afterADeath).toMatch(/still filed jointly/i);
  });

  it('should_say_a_separate_plan_files_two_returns_through_the_death_year', () => {
    const summary = summarizeFilingPlan({
      taxFilingPlan: {
        kind: 'separate',
        units: [
          { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
          { memberId: 'secondary', filingStatus: 'HoH', householdSize: 2 },
        ],
      },
      hasSecondaryMember: true,
      taxYear: 2030,
    });
    expect(summary.headline).toMatch(/separate returns/i);
    expect(summary.units).toHaveLength(2);
    expect(summary.afterADeath).toMatch(/two separate returns/i);
    expect(summary.afterADeath).not.toMatch(/jointly/i);
  });

  it('should_report_HoH_for_a_one_member_household_carrying_the_HoH_scalar', () => {
    // The legacy scalar resolves CLEANLY here (open-ended HoH), so no prompt.
    const summary = summarizeFilingPlan({
      filingStatusOverride: 'HoH',
      hasSecondaryMember: false,
      taxYear: 2030,
    });
    expect(summary.unresolvedLegacyDetail).toBeUndefined();
    expect(summary.headline).toBe('Head of household');
  });

  it('should_read_an_open_ended_HoH_window_as_the_standing_status_not_an_exception', () => {
    const summary = summarizeFilingPlan({
      taxFilingPlan: { kind: 'individual', statusWindows: [openEndedStatusWindow('HoH')] },
      hasSecondaryMember: false,
      taxYear: 2030,
    });
    expect(summary.headline).toBe('Head of household');
    expect(summary.windows).toEqual([]);
  });

  it('should_match_the_materialized_plan_to_the_scalar_it_replaces', () => {
    // The plan the editor seeds for a one-member `HoH` scalar must
    // resolve to the SAME tax unit the scalar itself resolves to, every year.
    const scalarCtx: FilingPlanContext = {
      filingStatusOverride: 'HoH',
      hasSecondaryMember: false,
      primaryAlive: true,
      secondaryAlive: false,
      taxYear: 2040,
    };
    const planCtx: FilingPlanContext = {
      taxFilingPlan: { kind: 'individual', statusWindows: [openEndedStatusWindow('HoH')] },
      hasSecondaryMember: false,
      primaryAlive: true,
      secondaryAlive: false,
      taxYear: 2040,
    };
    expect(resolveFilingPlanForYear(planCtx)).toEqual(resolveFilingPlanForYear(scalarCtx));
  });

  // The summary drives the on-screen report card AND the PDF settings
  // table. It must survive exactly the payloads the resolver already classifies
  // as unresolved: a window entry that IS an object but is missing an anchor
  // would reach `isOpenEndedStatusWindow` / `describeFilingStatusWindow` and
  // throw, so a corrupt scenario could not be reported on at all.
  it('should_not_throw_on_a_malformed_status_window', () => {
    const withBadWindow = (statusWindows: unknown): FilingSummaryContext => ({
      taxFilingPlan: { kind: 'joint', statusWindows } as unknown as TaxFilingPlan,
      hasSecondaryMember: true,
      taxYear: 2030,
    });
    for (const statusWindows of [
      [{ status: 'QSS', start: { kind: 'year', year: 2031 } }], // no `end`
      [{ status: 'QSS', end: { kind: 'year', year: 2033 } }], // no `start`
      [{ status: 'QSS', start: null, end: null }],
      [{ status: 'NOT_A_STATUS', start: { kind: 'year', year: 2031 }, end: { kind: 'year', year: 2033 } }],
      [null],
      ['nope'],
    ]) {
      expect(() => summarizeFilingPlan(withBadWindow(statusWindows))).not.toThrow();
    }
  });

  it('should_skip_a_malformed_window_and_still_report_the_legacy_filing', () => {
    const summary = summarizeFilingPlan({
      taxFilingPlan: {
        kind: 'joint',
        // Missing `end` — the resolver classifies the whole plan as unresolved,
        // so the summary reports the LEGACY treatment and lists no exception.
        statusWindows: [{ status: 'QSS', start: { kind: 'year', year: 2031 } }],
      } as unknown as TaxFilingPlan,
      hasSecondaryMember: true,
      taxYear: 2030,
    });
    expect(summary.windows).toEqual([]);
    expect(summary.unresolvedLegacyDetail).toBeDefined();
    expect(summary.headline).toBe('Married filing jointly');
  });

  // A STANDING (open-ended) window can reach a couple's plan without any
  // filing-editor control showing it: a joint plan whose spouse was temporarily
  // removed picks one up from the one-person "Files as" control, and once the
  // spouse is back the couple's controls neither display it nor list it among the
  // exception years. The resolver still applies it to the survivor's return
  // forever, so the death sentence must name THAT status — hardcoding "single"
  // would make the summary disagree with the engine.
  describe('a standing window the couple cannot see still drives the summary', () => {
    /** The plan the editor really writes for that sequence: still `joint`
     *  (the radio was never touched), carrying the one-person control's
     *  open-ended head-of-household status. */
    const jointWithStandingHoH: JointFilingPlan = {
      kind: 'joint',
      statusWindows: [openEndedStatusWindow('HoH')],
    };

    it('should_agree_with_the_post_death_resolution_about_the_survivor_status', () => {
      const summary = summarizeFilingPlan({
        taxFilingPlan: jointWithStandingHoH,
        hasSecondaryMember: true,
        taxYear: 2030,
      });
      // Both spouses alive → still one joint return (a window never overrides a
      // live MFJ year), so only the LATER years are at stake.
      expect(summary.headline).toBe('Married filing jointly');
      const postDeath = resolveFilingPlanForYear({
        taxFilingPlan: jointWithStandingHoH,
        hasSecondaryMember: true,
        primaryAlive: true,
        secondaryAlive: false,
        taxYear: 2035,
      });
      expect(postDeath).toEqual<FilingPlanResolution>({
        kind: 'resolved',
        taxUnits: [{ memberIds: ['primary'], filingStatus: 'HoH' }],
      });
      // The sentence names what the engine files, not an assumed `Single`.
      expect(summary.afterADeath).toMatch(/later years file head of household/i);
      expect(summary.afterADeath).not.toMatch(/file single/i);
    });

    it('should_still_say_single_for_a_plan_carrying_no_standing_window', () => {
      const summary = summarizeFilingPlan({
        taxFilingPlan: { kind: 'joint' },
        hasSecondaryMember: true,
        taxYear: 2030,
      });
      expect(summary.afterADeath).toMatch(/later years file single\./i);
    });

    it('should_name_the_exception_years_in_either_stored_order', () => {
      // A year-bounded exception outranks the standing window whichever
      // order the two are stored in, so the sentence names the standing status for
      // the later years AND the exception that interrupts it, from either payload.
      const qss: FilingStatusWindow = {
        status: 'QSS',
        start: { kind: 'year', year: 2036 },
        end: { kind: 'year', year: 2038 },
      };
      for (const statusWindows of [
        [openEndedStatusWindow('HoH'), qss],
        [qss, openEndedStatusWindow('HoH')],
      ]) {
        const plan: JointFilingPlan = { kind: 'joint', statusWindows };
        expect(
          summarizeFilingPlan({
            taxFilingPlan: plan,
            hasSecondaryMember: true,
            taxYear: 2030,
          }).afterADeath,
        ).toBe(
          'The year a spouse dies is still filed jointly; later years file head of ' +
            'household, except Qualifying surviving spouse from 2036 up to (but not ' +
            'including) 2038.',
        );
        expect(
          resolveFilingPlanForYear({
            taxFilingPlan: plan,
            hasSecondaryMember: true,
            primaryAlive: true,
            secondaryAlive: false,
            taxYear: 2036,
          }),
        ).toEqual<FilingPlanResolution>({
          kind: 'resolved',
          taxUnits: [{ memberIds: ['primary'], filingStatus: 'QSS' }],
        });
        expect(
          resolveFilingPlanForYear({
            taxFilingPlan: plan,
            hasSecondaryMember: true,
            primaryAlive: true,
            secondaryAlive: false,
            taxYear: 2038,
          }),
        ).toEqual<FilingPlanResolution>({
          kind: 'resolved',
          taxUnits: [{ memberIds: ['primary'], filingStatus: 'HoH' }],
        });
      }
    });

    it('should_keep_the_legacy_single_default_when_the_plan_is_not_applied', () => {
      // An `individual` plan on a couple is UNRESOLVED: the engines ignore
      // the plan and keep the legacy derivation, whose post-death status is
      // `Single`. Its standing window must not colour the sentence.
      const summary = summarizeFilingPlan({
        taxFilingPlan: { kind: 'individual', statusWindows: [openEndedStatusWindow('HoH')] },
        hasSecondaryMember: true,
        taxYear: 2030,
      });
      expect(summary.unresolvedLegacyDetail).toBeDefined();
      expect(summary.afterADeath).toMatch(/later years file single\./i);
      expect(
        resolveFilingPlanForYear({
          taxFilingPlan: { kind: 'individual', statusWindows: [openEndedStatusWindow('HoH')] },
          hasSecondaryMember: true,
          primaryAlive: true,
          secondaryAlive: false,
          taxYear: 2035,
        }).kind,
      ).toBe('unresolved');
    });
  });

  it('should_not_throw_when_the_stored_plan_is_not_an_object', () => {
    // Same corrupt values the resolver tolerates.
    for (const stored of [null, [], 'joint', 42]) {
      expect(() =>
        summarizeFilingPlan({
          taxFilingPlan: stored as unknown as TaxFilingPlan,
          hasSecondaryMember: true,
          taxYear: 2030,
        }),
      ).not.toThrow();
    }
  });
});

describe('unresolvedFilingDetail (domain predicate)', () => {
  it('should_flag_a_two_member_Single_scalar', () => {
    expect(
      unresolvedFilingDetail({ filingStatusOverride: 'Single', hasSecondaryMember: true }),
    ).toBeDefined();
  });

  it('should_not_flag_a_resolvable_one_member_HoH_scalar', () => {
    expect(
      unresolvedFilingDetail({ filingStatusOverride: 'HoH', hasSecondaryMember: false }),
    ).toBeUndefined();
  });

  it('should_not_flag_a_stored_plan', () => {
    expect(
      unresolvedFilingDetail({
        taxFilingPlan: { kind: 'joint' },
        filingStatusOverride: 'Single',
        hasSecondaryMember: true,
      }),
    ).toBeUndefined();
  });
});
