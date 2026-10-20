import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CLASSIFICATION,
  BALANCE_CLASSIFICATION,
  EXPENSE_CATEGORY_CLASSIFICATION,
  EXPENSE_CLASSIFICATION,
  INCOME_CLASSIFICATION,
  MEMBER_CLASSIFICATION,
  SCENARIO_CLASSIFICATION,
  SOCIAL_SECURITY_CLASSIFICATION,
  type Classification,
} from './classification';

const MAPS: Record<string, Readonly<Record<string, Classification>>> = {
  member: MEMBER_CLASSIFICATION,
  account: ACCOUNT_CLASSIFICATION,
  balance: BALANCE_CLASSIFICATION,
  expenseCategory: EXPENSE_CATEGORY_CLASSIFICATION,
  expense: EXPENSE_CLASSIFICATION,
  income: INCOME_CLASSIFICATION,
  socialSecurity: SOCIAL_SECURITY_CLASSIFICATION,
  scenario: SCENARIO_CLASSIFICATION,
};

/** Every field in a map at any depth, with the path to it and whether the Household members switch gates it. */
function fieldsOf(
  classification: Classification,
  path: string,
  gatedOnMembers: boolean,
  visit: (path: string, classification: Classification, gatedOnMembers: boolean) => void,
): void {
  visit(path, classification, gatedOnMembers);
  switch (classification.kind) {
    case 'object':
      for (const [key, inner] of Object.entries(classification.fields)) fieldsOf(inner, `${path}.${key}`, gatedOnMembers, visit);
      break;
    case 'array':
      fieldsOf(classification.item, `${path}[]`, gatedOnMembers, visit);
      break;
    case 'record':
      fieldsOf(classification.value, `${path}{}`, gatedOnMembers, visit);
      break;
    case 'gated':
      fieldsOf(classification.shape, path, gatedOnMembers || classification.category === 'members', visit);
      break;
    default:
      break;
  }
}

describe('the field model', () => {
  it('ties every birth date, wherever it is stored, to the Household members switch', () => {
    const birthDates: string[] = [];
    for (const [name, map] of Object.entries(MAPS)) {
      fieldsOf({ kind: 'object', fields: map }, name, false, (path, classification, gatedOnMembers) => {
        const leaf = path.split('.').at(-1) ?? '';
        if (!/birth/i.test(leaf) || classification.kind === 'object' || classification.kind === 'gated') return;
        birthDates.push(path);
        expect(gatedOnMembers, path).toBe(true);
      });
    }
    // The member's own date and the three on account rows; a new one is checked here the day it is classified.
    expect(birthDates.sort()).toEqual([
      'account.rmdBeneficiaryBirthdate',
      'account.rmdOriginalOwnerBirthdate',
      'account.rmdSpouseBeneficiaryBirthdate',
      'member.birthdate',
    ]);
  });
});
