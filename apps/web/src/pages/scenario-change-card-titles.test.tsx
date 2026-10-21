/**
 * Label drift guard: every card title `SCENARIO_CHANGE_SETTINGS` emits must be
 * a heading the scenario detail page renders in the same group, so the Compare
 * tab's "what changed" list names cards the person can actually find.
 */
import 'fake-indexeddb/auto';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllStores } from '../db/store';
import { loadDemoData } from '../lib/demo-data-loader';
import { SCENARIO_CHANGE_SETTINGS } from '../lib/scenario-change-list';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { ScenarioDetailPage } from './ScenarioDetailPage';

const GROUP_TESTID = {
  'Timing & longevity': 'scenario-group-timing',
  'Income & expenses': 'scenario-group-income',
  'Savings & investments': 'scenario-group-savings',
  'Withdrawals & taxes': 'scenario-group-withdrawals',
} as const;
/** Edited on its own route; the detail page has no card for it. */
const NO_DETAIL_CARD = new Set(['Account asset mix']);

describe('scenario change-list card titles', () => {
  beforeEach(async () => {
    await clearAllStores();
    vi.mocked(useAuth).mockReturnValue({
      householdId: 'hh-test',
      me: { email: 'me@example.test', displayName: 'Me', roles: [], userId: 'u-1' },
      isAuthenticated: true,
    } as never);
    vi.mocked(useSync).mockReturnValue({
      notifyPending: vi.fn(),
      state: { kind: 'synced', lastSyncedAt: null },
    } as never);
    await loadDemoData({ householdId: 'hh-test', email: 'demo@example.test', displayName: 'Demo User' });
  });
  afterEach(clearAllStores);

  it('are all rendered as card headings in their own group on the demo dataset', async () => {
    render(
      <MemoryRouter initialEntries={['/scenarios/demo-scenario-early']}>
        <Routes>
          <Route path="/scenarios/:id" element={<ScenarioDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const headingsOf = async (testId: string): Promise<string[]> =>
      Array.from((await screen.findByTestId(testId)).querySelectorAll('h3')).map(
        (h) => h.textContent ?? '',
      );
    const rendered = {
      'Timing & longevity': await headingsOf(GROUP_TESTID['Timing & longevity']),
      'Income & expenses': await headingsOf(GROUP_TESTID['Income & expenses']),
      'Savings & investments': await headingsOf(GROUP_TESTID['Savings & investments']),
      'Withdrawals & taxes': await headingsOf(GROUP_TESTID['Withdrawals & taxes']),
    };
    for (const setting of Object.values(SCENARIO_CHANGE_SETTINGS)) {
      if (setting === null || NO_DETAIL_CARD.has(setting.card)) continue;
      expect(rendered[setting.group], setting.card).toContain(setting.card);
    }
  });
});
