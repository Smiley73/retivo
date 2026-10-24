// useBalanceProjectionData `expenseCategory` slice: gated into `ready` but not into the page-level `error`, so a category read failure degrades the cashflow toggle to Total-only instead of blanking the page. `useAggregates` is mocked so each slice's `ready`/`error` can be driven independently.
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AggregateType } from '../db/types';

const slice = (
  over: { ready?: boolean; error?: Error | null } = {},
): { aggregates: never[]; ready: boolean; error: Error | null } => ({
  aggregates: [],
  ready: over.ready ?? true,
  error: over.error ?? null,
});

const sliceByType = new Map<
  AggregateType,
  { aggregates: never[]; ready: boolean; error: Error | null }
>();

vi.mock('../lib/use-aggregates', () => ({
  useAggregates: (type: AggregateType) => sliceByType.get(type) ?? slice(),
}));

vi.mock('../db/store', () => ({
  readSelectedScenario: () => Promise.resolve(null),
}));

import { useBalanceProjectionData } from './use-balance-projection-data';

function wrapper({ children }: { children: ReactNode }) {
  return createElement(MemoryRouter, null, children);
}

beforeEach(() => {
  sliceByType.clear();
});

describe('useBalanceProjectionData — expenseCategory gating', () => {
  it('an expenseCategory read error does NOT set the page-level error', () => {
    sliceByType.set('expenseCategory', slice({ error: new Error('boom') }));
    const { result } = renderHook(() => useBalanceProjectionData(), { wrapper });
    expect(result.current.error).toBeNull();
    expect(result.current.expenseCategories).toEqual([]);
    expect(result.current.ready).toBe(true);
  });

  it('an unsettled expenseCategory slice keeps the page not-ready (gated into ready)', () => {
    sliceByType.set('expenseCategory', slice({ ready: false }));
    const { result } = renderHook(() => useBalanceProjectionData(), { wrapper });
    expect(result.current.ready).toBe(false);
  });

  it('a core slice error DOES set the page-level error (control)', () => {
    sliceByType.set('account', slice({ error: new Error('boom') }));
    const { result } = renderHook(() => useBalanceProjectionData(), { wrapper });
    expect(result.current.error).toBe('Failed to load projection data.');
  });
});
