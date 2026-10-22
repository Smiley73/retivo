/** The Add Medicare premiums helper on the demo household (its Medicare rows
 *  carry the helper's fixed names) and the attribution rules it cannot show. */
import { describe, expect, it } from 'vitest';
import type {
  Aggregate,
  ExpenseCategoryPayload,
  ExpensePayload,
  HouseholdMemberPayload,
} from '../db/types';
import { demoExpenseDefs } from '../lib/demo-data-defs';
import { latestMedicarePremiums } from '../lib/medicare-premiums';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import {
  buildMedicarePremiumPreview,
  buildPremiumPayloads,
  isRowIncluded,
  premiumCheckExpenses,
  type MedicarePremiumPreview,
  type PremiumMemberGroup,
  type PremiumRow,
} from './medicare-premium-helper';

const HH = 'hh-test';

function aggregate<T extends Record<string, unknown>>(
  id: string,
  type: Aggregate['aggregateType'],
  payload: T,
): Aggregate<T> {
  return {
    id,
    householdId: HH,
    aggregateType: type,
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload,
  } as Aggregate<T>;
}

function member(
  id: string,
  firstName: string,
  isPrimary: boolean,
  birthdate = '1960-03-01',
): Aggregate<HouseholdMemberPayload> {
  return aggregate(id, 'householdMember', {
    isPrimary,
    firstName,
    lastName: 'Doe',
    email: '',
    birthdate,
  });
}

function category(
  id: string,
  name: string,
  isMedical = false,
): Aggregate<ExpenseCategoryPayload> {
  return aggregate(id, 'expenseCategory', isMedical ? { name, isMedical } : { name });
}

function expense(
  id: string,
  overrides: Partial<ExpensePayload> & { name: string },
): Aggregate<ExpensePayload> {
  return aggregate(id, 'expense', {
    amount: 100,
    frequency: 'monthly',
    classification: 'essential',
    categoryId: 'cat-medical',
    start: { kind: 'retirementStart' },
    ...overrides,
  } as ExpensePayload);
}

const JOHN = member('m-john', 'John', true);
const JANE = member('m-jane', 'Jane', false);
const CATEGORIES = [
  category('cat-medical', 'Medical', true),
  category('cat-insurance', 'Insurance'),
  category('cat-housing', 'Housing'),
];
const DEMO_EXPENSES = demoExpenseDefs(2026).map((d) =>
  aggregate(d.id, 'expense', d.payload),
);

function preview(
  expenses: ReadonlyArray<Aggregate<ExpensePayload>>,
  members = [JOHN, JANE],
  categories = CATEGORIES,
): MedicarePremiumPreview {
  return buildMedicarePremiumPreview({ members, expenses, categories });
}

function group(p: MedicarePremiumPreview, memberId: string): PremiumMemberGroup {
  const g = p.members.find((m) => m.memberId === memberId);
  if (!g) throw new Error(`no group for ${memberId}`);
  return g;
}

function row(p: MedicarePremiumPreview, memberId: string, part: 'B' | 'D'): PremiumRow {
  const r = group(p, memberId).rows.find((x) => x.part === part);
  if (!r) throw new Error(`no ${part} row for ${memberId}`);
  return r;
}

const names = (r: PremiumRow): string[] => r.alreadyEntered.map((m) => m.name);

describe('buildMedicarePremiumPreview on the demo household', () => {
  const p = preview(DEMO_EXPENSES);
  const latest = latestMedicarePremiums();

  it('should_offer_a_Part_B_and_a_Part_D_row_for_each_member_at_the_newest_year_amounts', () => {
    expect(p.year).toBe(latest.year);
    expect(p.medicalCategoryId).toBe('cat-medical');
    expect(p.members.map((g) => g.label)).toEqual(['John', 'Jane']);
    for (const id of ['m-john', 'm-jane']) {
      expect(row(p, id, 'B').monthly).toBe(latest.partBStandardMonthly);
      expect(row(p, id, 'D').monthly).toBe(latest.partDNationalBaseMonthly);
    }
    expect(row(p, 'm-john', 'B').expenseName).toBe('John Medicare Part B');
    expect(row(p, 'm-jane', 'D').expenseName).toBe('Jane Medicare Part D');
  });

  it('should_flag_both_Part_B_rows_as_already_entered_and_blocked_by_the_fixed_name', () => {
    const john = row(p, 'm-john', 'B');
    expect(names(john)).toContain('John Medicare Part B');
    expect(john.block).toEqual({
      kind: 'nameTaken',
      expense: expect.objectContaining({
        name: 'John Medicare Part B',
        categoryName: 'Medical',
      }),
    });
    expect(john.defaultIncluded).toBe(false);
    const jane = row(p, 'm-jane', 'B');
    expect(names(jane)).toEqual(['Jane Medicare Part B']);
    expect(jane.block?.kind).toBe('nameTaken');
    expect(jane.defaultIncluded).toBe(false);
  });

  it('should_leave_Jane_Part_D_free_and_attribute_the_bridge_row_to_John_only', () => {
    const janeD = row(p, 'm-jane', 'D');
    expect(janeD.block).toBeNull();
    expect(janeD.alreadyEntered).toEqual([]);
    expect(janeD.defaultIncluded).toBe(true);
    // The bridge plan matches both parts by name and is John's by its end
    // anchor: it shows on his rows, unchecked, but is no collision.
    const johnD = row(p, 'm-john', 'D');
    expect(names(johnD)).toEqual(['Private health plan (bridge to Medicare)']);
    expect(johnD.alreadyEntered[0].categoryName).toBe('Medical');
    expect(johnD.block).toBeNull();
    expect(johnD.defaultIncluded).toBe(false);
    expect(names(row(p, 'm-john', 'B'))).toContain(
      'Private health plan (bridge to Medicare)',
    );
  });

  it('should_not_match_the_Medigap_row', () => {
    for (const g of p.members) {
      for (const r of g.rows) {
        expect(names(r)).not.toContain('Medigap supplement (both)');
      }
    }
  });

  it('should_be_all_already_entered_on_a_second_run', () => {
    const written = buildPremiumPayloads(p, { 'm-john:D': true }, {}).map((payload, i) =>
      aggregate(`new-${i}`, 'expense', payload),
    );
    const second = preview([...DEMO_EXPENSES, ...written]);
    for (const g of second.members) {
      for (const r of g.rows) {
        expect(r.alreadyEntered.length).toBeGreaterThan(0);
        expect(isRowIncluded(r, {})).toBe(false);
      }
    }
  });
});

describe('attribution beyond the demo rows', () => {
  it('should_match_both_parts_of_an_Insurance_category_Medicare_Advantage_row', () => {
    const p = preview([
      expense('e1', {
        name: 'Medicare Advantage',
        categoryId: 'cat-insurance',
        start: { kind: 'age', memberId: 'secondary', years: 65, months: 0 },
      }),
    ]);
    const janeB = row(p, 'm-jane', 'B');
    expect(janeB.alreadyEntered).toEqual([
      { id: 'e1', name: 'Medicare Advantage', categoryName: 'Insurance' },
    ]);
    expect(names(row(p, 'm-jane', 'D'))).toEqual(['Medicare Advantage']);
    expect(row(p, 'm-john', 'B').alreadyEntered).toEqual([]);
  });

  it('should_show_an_ambiguous_Part_D_row_on_every_member_and_never_on_Part_B', () => {
    const p = preview([expense('e2', { name: 'Part D plan' })]);
    for (const id of ['m-john', 'm-jane']) {
      expect(names(row(p, id, 'D'))).toEqual(['Part D plan']);
      expect(row(p, id, 'B').alreadyEntered).toEqual([]);
    }
  });

  it('should_let_a_first_name_win_over_the_other_members_age_anchor', () => {
    const p = preview([
      expense('e3', {
        name: "Jane's Medicare drug plan",
        start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      }),
    ]);
    expect(names(row(p, 'm-jane', 'D'))).toEqual(["Jane's Medicare drug plan"]);
    expect(row(p, 'm-john', 'D').alreadyEntered).toEqual([]);
  });

  it('should_treat_a_name_naming_both_members_as_ambiguous', () => {
    const p = preview([expense('e4', { name: 'John and Jane Medicare' })]);
    expect(names(row(p, 'm-john', 'B'))).toEqual(['John and Jane Medicare']);
    expect(names(row(p, 'm-jane', 'B'))).toEqual(['John and Jane Medicare']);
  });

  it('should_skip_name_matching_for_a_member_with_an_empty_first_name_but_use_anchors', () => {
    const noName = member('m-john', '  ', true);
    const p = preview(
      [
        expense('e5', {
          name: 'Medicare Part D',
          end: { kind: 'age', years: 90, months: 0 },
        }),
      ],
      [noName, JANE],
    );
    // No age start; the end anchor has no member id, so it is the primary's.
    expect(group(p, 'm-john').label).toBe('primary');
    expect(names(row(p, 'm-john', 'D'))).toEqual(['Medicare Part D']);
    expect(row(p, 'm-jane', 'D').alreadyEntered).toEqual([]);
  });

  it('should_use_the_start_anchor_before_the_end_anchor', () => {
    const p = preview([
      expense('e6', {
        name: 'Medicare Part B',
        start: { kind: 'age', memberId: 'secondary', years: 65, months: 0 },
        end: { kind: 'age', memberId: 'primary', years: 90, months: 0 },
      }),
    ]);
    expect(names(row(p, 'm-jane', 'B'))).toEqual(['Medicare Part B']);
    expect(row(p, 'm-john', 'B').alreadyEntered).toEqual([]);
  });

  it('should_not_flag_Part_D_for_a_Part_B_row', () => {
    const p = preview([expense('e7', { name: 'John Part B' })]);
    expect(names(row(p, 'm-john', 'B'))).toEqual(['John Part B']);
    expect(row(p, 'm-john', 'D').alreadyEntered).toEqual([]);
  });

  it('should_match_a_name_with_both_parts_to_both_rows', () => {
    const p = preview([expense('e8', { name: 'John Part B and Part D' })]);
    expect(names(row(p, 'm-john', 'B'))).toEqual(['John Part B and Part D']);
    expect(names(row(p, 'm-john', 'D'))).toEqual(['John Part B and Part D']);
  });

  it('should_match_a_first_name_only_as_a_whole_word', () => {
    const p = preview([
      expense('e9', {
        name: 'Johnson Medicare plan',
        start: { kind: 'age', memberId: 'secondary', years: 65, months: 0 },
      }),
    ]);
    // "Johnson" is not John, so the secondary anchor decides.
    expect(names(row(p, 'm-jane', 'B'))).toEqual(['Johnson Medicare plan']);
    expect(row(p, 'm-john', 'B').alreadyEntered).toEqual([]);
  });
});

describe('row blocks', () => {
  it('should_block_a_case_and_space_insensitive_fixed_name_collision_in_any_category', () => {
    const p = preview([
      expense('c1', { name: '  john MEDICARE part d ', categoryId: 'cat-housing' }),
    ]);
    const r = row(p, 'm-john', 'D');
    expect(r.block).toEqual({
      kind: 'nameTaken',
      expense: { id: 'c1', name: '  john MEDICARE part d ', categoryName: 'Housing' },
    });
  });

  it('should_block_a_second_row_that_would_repeat_a_name', () => {
    const twin = member('m-jane', 'John', false);
    const p = preview([], [JOHN, twin]);
    expect(row(p, 'm-john', 'B').block).toBeNull();
    expect(row(p, 'm-jane', 'B').block).toEqual({ kind: 'nameRepeated' });
  });

  it('should_block_a_name_longer_than_sixty_characters', () => {
    const long = member('m-john', 'A'.repeat(50), true);
    const p = preview([], [long]);
    expect(row(p, 'm-john', 'B').block).toEqual({ kind: 'nameTooLong' });
  });
});

describe('members and categories', () => {
  it('should_explain_instead_of_offering_rows_for_a_member_without_a_birthdate', () => {
    const p = preview([], [JOHN, member('m-jane', 'Jane', false, '')]);
    expect(group(p, 'm-john').rows).toHaveLength(2);
    expect(group(p, 'm-jane')).toMatchObject({ missingBirthdate: true, rows: [] });
  });

  it('should_include_a_member_already_past_65', () => {
    const p = preview([], [member('m-john', 'John', true, '1950-01-01')]);
    expect(group(p, 'm-john').rows).toHaveLength(2);
    expect(buildPremiumPayloads(p, {}, {})[0]).toMatchObject({
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      end: { kind: 'lifetime', whose: 'primary' },
    });
  });

  it('should_prefer_the_category_named_Medical_else_the_first_medical_one', () => {
    const cats = [
      category('cat-a', 'Care', true),
      category('cat-b', 'medical ', true),
    ];
    expect(preview([], [JOHN], cats).medicalCategoryId).toBe('cat-b');
    expect(
      preview([], [JOHN], [category('cat-a', 'Care', true), category('cat-c', 'Dental', true)])
        .medicalCategoryId,
    ).toBe('cat-a');
  });

  it('should_offer_no_rows_when_no_category_is_medical', () => {
    const p = preview([], [JOHN], [category('cat-x', 'Medical')]);
    expect(p.medicalCategoryId).toBeNull();
    expect(p.members).toEqual([]);
    expect(buildPremiumPayloads(p, {}, {})).toEqual([]);
  });
});

describe('buildPremiumPayloads', () => {
  const p = preview([]);

  it('should_write_the_fixed_name_monthly_essential_hsa_eligible_to_the_medical_category', () => {
    const payloads = buildPremiumPayloads(p, {}, {});
    expect(payloads).toHaveLength(4);
    expect(payloads[0]).toEqual({
      name: 'John Medicare Part B',
      amount: latestMedicarePremiums().partBStandardMonthly,
      frequency: 'monthly',
      classification: 'essential',
      categoryId: 'cat-medical',
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      end: { kind: 'lifetime', whose: 'primary' },
      hsaQualified: true,
    });
    expect(payloads[3]).toMatchObject({
      name: 'Jane Medicare Part D',
      start: { kind: 'age', memberId: 'secondary', years: 65, months: 0 },
      end: { kind: 'lifetime', whose: 'secondary' },
    });
  });

  it('should_write_only_the_included_unblocked_rows_with_edited_amounts', () => {
    const withDemo = preview(DEMO_EXPENSES);
    const payloads = buildPremiumPayloads(
      withDemo,
      // Part B rows are blocked: switching them on changes nothing.
      { 'm-john:B': true, 'm-jane:B': true, 'm-john:D': true, 'm-jane:D': false },
      { 'm-john:D': 41.239, 'm-jane:B': 5 },
    );
    expect(payloads.map((x) => [x.name, x.amount])).toEqual([['John Medicare Part D', 41.24]]);
  });
});

describe('scenario-only expenses', () => {
  const scenario = (
    id: string,
    parentScenarioId: string | null,
    added: Array<ExpensePayload & { _localId: string }>,
  ): ScenarioAggregate =>
    aggregate(id, 'scenario', {
      name: id,
      description: '',
      parentScenarioId,
      isPrimary: parentScenarioId === null,
      notes: '',
      overrides: { expenses: { added } },
    }) as unknown as ScenarioAggregate;
  const partB = {
    _localId: 'loc-1',
    name: 'John Medicare Part B',
    amount: 202.9,
    frequency: 'monthly',
    classification: 'essential',
    categoryId: 'cat-medical',
    start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
  } as ExpensePayload & { _localId: string };

  it('should_block_a_row_whose_name_a_scenario_only_expense_already_uses', () => {
    const scenarios = [scenario('base', null, [partB])];
    const withoutScenario = preview([]);
    expect(row(withoutScenario, 'm-john', 'B').block).toBeNull();

    const p = preview(premiumCheckExpenses([], scenarios, 'base'));
    const johnB = row(p, 'm-john', 'B');
    expect(johnB.block).toMatchObject({
      kind: 'nameTaken',
      expense: { name: 'John Medicare Part B', categoryName: 'Medical' },
    });
    expect(johnB.defaultIncluded).toBe(false);
    expect(buildPremiumPayloads(p, {}, {}).map((x) => x.name)).not.toContain(
      'John Medicare Part B',
    );
  });

  it('should_flag_a_differently_named_scenario_only_premium_as_already_entered', () => {
    const scenarios = [
      scenario('base', null, [{ ...partB, name: 'John Part B' }]),
    ];
    const p = preview(premiumCheckExpenses([], scenarios, 'base'));
    expect(row(p, 'm-john', 'B').alreadyEntered).toHaveLength(1);
    expect(row(p, 'm-john', 'B').defaultIncluded).toBe(false);
    expect(row(p, 'm-john', 'D').alreadyEntered).toEqual([]);
  });

  it('should_include_expenses_a_parent_scenario_adds', () => {
    const scenarios = [
      scenario('base', null, [partB]),
      scenario('child', 'base', []),
    ];
    expect(premiumCheckExpenses([], scenarios, 'child').map((e) => e.payload.name)).toEqual([
      'John Medicare Part B',
    ]);
  });

  it('should_add_the_selected_scenarios_expenses_and_fall_back_to_the_primary', () => {
    const scenarios = [
      scenario('base', null, [partB]),
      scenario('other', null, []),
    ];
    const names = (selected: string | null): string[] =>
      premiumCheckExpenses([], scenarios, selected).map((e) => e.payload.name);
    expect(names('base')).toEqual(['John Medicare Part B']);
    expect(names(null)).toEqual(['John Medicare Part B']);
    expect(names('gone')).toEqual(['John Medicare Part B']);
    expect(names('other')).toEqual([]);
    expect(premiumCheckExpenses([], [], 'base')).toEqual([]);
  });

  describe('a canonical expense the scenario renames', () => {
    const healthInsurance = expense('e-health', {
      name: 'Health insurance',
      amount: 202.9,
    });
    const renaming = (
      id: string,
      parentScenarioId: string | null,
      name: string,
    ): ScenarioAggregate =>
      aggregate(id, 'scenario', {
        name: id,
        description: '',
        parentScenarioId,
        isPrimary: parentScenarioId === null,
        notes: '',
        overrides: {
          expenses: { patches: { 'aggregate:e-health': { name } } },
        },
      }) as unknown as ScenarioAggregate;
    const scenarios = [
      renaming('base', null, 'Health insurance'),
      renaming('renamed', 'base', 'John Medicare Part B'),
    ];

    it('should_block_and_flag_the_row_the_scenario_name_already_covers', () => {
      const p = preview(
        premiumCheckExpenses([healthInsurance], scenarios, 'renamed'),
      );
      const johnB = row(p, 'm-john', 'B');
      expect(johnB.block).toMatchObject({
        kind: 'nameTaken',
        expense: { id: 'e-health', name: 'John Medicare Part B' },
      });
      expect(names(johnB)).toEqual(['John Medicare Part B']);
      expect(johnB.defaultIncluded).toBe(false);
      expect(buildPremiumPayloads(p, {}, {}).map((x) => x.name)).not.toContain(
        'John Medicare Part B',
      );
    });

    it('should_keep_the_canonical_name_and_skip_unrenamed_patches', () => {
      const names = (selected: string): string[] =>
        premiumCheckExpenses([healthInsurance], scenarios, selected).map(
          (e) => e.payload.name,
        );
      expect(names('renamed')).toEqual(['Health insurance', 'John Medicare Part B']);
      expect(names('base')).toEqual(['Health insurance']);
    });
  });
});
