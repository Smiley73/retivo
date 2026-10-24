// Account-type and tax-treatment enums, display labels and ownership rules.

export type AccountType =
  | 'RETIREMENT_401K'
  | 'RETIREMENT_IRA'
  | 'RETIREMENT_ROTH_IRA'
  | 'RETIREMENT_ROTH_401K'
  | 'RETIREMENT_ROTH_403B'
  | 'RETIREMENT_ROTH_457B'
  | 'RETIREMENT_ROTH_TSP'
  | 'RETIREMENT_CASH_BALANCE'
  | 'RETIREMENT_403B'
  | 'RETIREMENT_457B'
  | 'RETIREMENT_TSP'
  | 'SAVINGS'
  | 'MONEY_MARKET'
  | 'BROKERAGE'
  | 'CD'
  | 'HSA'
  | 'OTHER';

export type AccountTaxTreatment =
  | 'PRE_TAX'
  | 'POST_TAX'
  | 'MIXED'
  | 'HSA'
  | 'ROTH';

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  RETIREMENT_401K: '401(k)',
  RETIREMENT_IRA: 'Traditional IRA',
  RETIREMENT_ROTH_IRA: 'Roth IRA',
  RETIREMENT_ROTH_401K: 'Roth 401(k)',
  RETIREMENT_ROTH_403B: 'Roth 403(b)',
  RETIREMENT_ROTH_457B: 'Roth 457(b)',
  RETIREMENT_ROTH_TSP: 'Roth TSP',
  RETIREMENT_CASH_BALANCE: 'Cash Balance Pension',
  RETIREMENT_403B: '403(b)',
  RETIREMENT_457B: '457(b)',
  RETIREMENT_TSP: 'TSP',
  SAVINGS: 'Savings',
  MONEY_MARKET: 'Money Market',
  BROKERAGE: 'Brokerage',
  CD: 'CD',
  HSA: 'HSA',
  OTHER: 'Other',
};

export const TAX_TREATMENT_LABELS: Record<AccountTaxTreatment, string> = {
  PRE_TAX: 'Tax-deferred',
  POST_TAX: 'Taxable',
  MIXED: 'Mixed',
  HSA: 'Tax-free (HSA)',
  ROTH: 'Tax-free (Roth)',
};

/** Allowed tax treatments per account type; a single element means locked. */
export const TAX_TREATMENT_RULES: Record<AccountType, AccountTaxTreatment[]> = {
  RETIREMENT_401K: ['PRE_TAX', 'MIXED'],
  RETIREMENT_IRA: ['PRE_TAX'],
  RETIREMENT_ROTH_IRA: ['ROTH'],
  RETIREMENT_ROTH_401K: ['ROTH'],
  RETIREMENT_ROTH_403B: ['ROTH'],
  RETIREMENT_ROTH_457B: ['ROTH'],
  RETIREMENT_ROTH_TSP: ['ROTH'],
  RETIREMENT_CASH_BALANCE: ['PRE_TAX'],
  RETIREMENT_403B: ['PRE_TAX', 'MIXED'],
  RETIREMENT_457B: ['PRE_TAX', 'MIXED'],
  RETIREMENT_TSP: ['PRE_TAX', 'POST_TAX', 'MIXED'],
  SAVINGS: ['POST_TAX'],
  MONEY_MARKET: ['POST_TAX'],
  BROKERAGE: ['POST_TAX'],
  CD: ['POST_TAX'],
  HSA: ['HSA'],
  OTHER: ['PRE_TAX', 'POST_TAX', 'MIXED'],
};

/** Types that cannot be jointly owned: every retirement account is individual. */
export const INDIVIDUAL_ONLY_TYPES: AccountType[] = [
  'RETIREMENT_401K',
  'RETIREMENT_IRA',
  'RETIREMENT_ROTH_IRA',
  'RETIREMENT_ROTH_401K',
  'RETIREMENT_ROTH_403B',
  'RETIREMENT_ROTH_457B',
  'RETIREMENT_ROTH_TSP',
  'RETIREMENT_CASH_BALANCE',
  'RETIREMENT_403B',
  'RETIREMENT_457B',
  'RETIREMENT_TSP',
  'HSA',
];
