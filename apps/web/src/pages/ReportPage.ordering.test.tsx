import { describe, expect, it } from 'vitest';
import { buildReportPdfAccountLists } from '../lib/report-table-ordering';
import type { ReportPagePdfRenderHostProps } from './report-page-pdf-render-host';
describe('ReportPage PDF account inputs', () => {
  it('keeps the full input while filtering and sorting only by-account data', () => {
    const accounts: ReportPagePdfRenderHostProps['accounts'][number][] = [
      { id: 'ten', name: 'Account 10', ownerDisplayName: 'Alex', type: 'RETIREMENT_401K' },
      { id: 'excluded', name: 'Account 1', ownerDisplayName: 'Alex', type: 'BROKERAGE' },
      { id: 'two', name: 'Account 2', ownerDisplayName: 'Alex', type: 'SAVINGS' },
    ];
    const result = buildReportPdfAccountLists(accounts, ['excluded']);
    expect(result.allAccounts).toBe(accounts);
    expect(result.allAccounts.map(({ id }) => id)).toEqual(['ten', 'excluded', 'two']);
    expect(result.byAccountAccounts.map(({ id }) => id)).toEqual(['two', 'ten']);
  });
});
