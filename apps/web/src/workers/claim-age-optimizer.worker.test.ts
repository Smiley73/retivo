/**
 * Worker tests (updated for the brand-check refactor).
 * Instead of relying on the worker file's import-time
 * `self.addEventListener` (which the brand check makes a no-op in
 * jsdom), the test imports the explicitly exported
 * `registerOptimizerWorkerListener` and drives it against a fake
 * `self`: an `addEventListener` that captures the registered handler
 * and a `postMessage` spy. Tests then invoke the captured handler
 * with a fake `MessageEvent` and assert against the spy.
 *
 * No actual `Worker` constructor is invoked (Vitest's jsdom env has no
 * real Web Worker).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import {
  registerOptimizerWorkerListener,
  type OptimizerWorkerInbound,
  type OptimizerWorkerInput,
  type OptimizerWorkerOutbound,
} from './claim-age-optimizer.worker';

type CapturedHandler = (ev: MessageEvent<OptimizerWorkerInbound>) => void;

let capturedHandler: CapturedHandler | null = null;
let postMessageSpy: ReturnType<typeof vi.fn>;

function setupFakeSelf(): {
  handler: CapturedHandler;
  postMessage: ReturnType<typeof vi.fn>;
} {
  capturedHandler = null;
  postMessageSpy = vi.fn();
  const fakeTarget = {
    addEventListener: ((
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => {
      if (type === 'message' && typeof listener === 'function') {
        capturedHandler = listener as CapturedHandler;
      }
    }) as typeof self.addEventListener,
    postMessage: postMessageSpy as unknown as typeof self.postMessage,
  };
  registerOptimizerWorkerListener(fakeTarget);
  if (!capturedHandler) {
    throw new Error('Worker did not register a message listener on registerOptimizerWorkerListener');
  }
  return { handler: capturedHandler, postMessage: postMessageSpy };
}

afterEach(() => {
  capturedHandler = null;
});

const TODAY_ISO = '2026-05-19T00:00:00Z';

function member(
  id: string,
  isPrimary: boolean,
  firstName: string,
  birthYear: number,
): Aggregate<HouseholdMemberPayload> {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'householdMember',
    payload: {
      isPrimary,
      firstName,
      lastName: 'Doe',
      email: '',
      birthdate: `${birthYear}-01-01`,
    },
  };
}

function ssBenefit(
  memberId: string,
  pia: number | null,
): Aggregate<SocialSecurityBenefitPayload> {
  return {
    id: `ss-${memberId}`,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'socialSecurityBenefit',
    payload: { householdMemberId: memberId, pia, piaAsOfDate: '2026-01-01', notes: null },
  };
}

function scenarioWithAge(
  id: string,
  primaryAge: number,
  secondaryAge: number,
): ScenarioAggregate {
  return {
    id,
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'scenario',
    payload: {
      name: 'Base',
      description: '',
      parentScenarioId: null,
      isPrimary: true,
      notes: '',
      overrides: {
        socialSecurity: {
          primary: { ageYears: primaryAge, ageMonths: 0 },
          secondary: { ageYears: secondaryAge, ageMonths: 0 },
        },
        retirementAge: {
          primary: { ageYears: 67, ageMonths: 0 },
          secondary: { ageYears: 67, ageMonths: 0 },
        },
        inflation: { ratePct: 0 },
        lifeExpectancy: { primary: 95, secondary: 95 },
      },
    },
  };
}

function makeAccount(): Aggregate<AccountPayload> {
  return {
    id: 'a1',
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'account',
    payload: {
      name: 'Brokerage',
      type: 'BROKERAGE',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'POST_TAX',
      ownerId: 'm1',
      institution: 'Vanguard',
      notes: '',
      planningReturnPct: 5,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}

function makeBalance(): Aggregate<AccountBalancePayload> {
  return {
    id: 'b1',
    householdId: 'h',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-19T00:00:00Z',
    deviceId: 'd',
    aggregateType: 'accountBalance',
    payload: {
      accountId: 'a1',
      year: 2025,
      lastUpdated: '2025-12-31',
      startingBalance: 700_000,
      startingBalancePreTax: null,
      startingBalancePostTax: null,
      contributionsPreTax: null,
      contributionsPostTax: null,
      companyContributions: 0,
      companyContributionsPreTax: null,
      companyContributionsPostTax: null,
      rollover: 0,
      distributions: 0,
      endingBalance: 800_000,
      endingBalancePreTax: null,
      endingBalancePostTax: null,
      totalContributions: 0,
      comment: null,
    },
  };
}

function makeInput(): OptimizerWorkerInput {
  return {
    scenarioId: 's',
    scenarios: [scenarioWithAge('s', 67, 67)],
    accounts: [makeAccount()],
    balances: [makeBalance()],
    members: [member('m1', true, 'Alex', 1965), member('m2', false, 'Sam', 1968)],
    ssBenefits: [ssBenefit('m1', 3500), ssBenefit('m2', 2800)],
    expenses: [],
    incomeStreams: [],
    todayIso: TODAY_ISO,
  };
}

/**
 * A scenario that sets BOTH a per-account withdrawal strategy AND a
 * retirementAllocation override. The mutual-exclusion gate is RETIRED —
 * allocation now routes through the per-account path with every strategy — so
 * this is a valid scenario the optimizer runs (no error row).
 */
function strategyPlusAllocationInput(): OptimizerWorkerInput {
  const base = scenarioWithAge('s', 67, 67);
  const conflictScenario: ScenarioAggregate = {
    ...base,
    payload: {
      ...base.payload,
      overrides: {
        ...base.payload.overrides,
        withdrawalStrategy: { kind: 'taxEfficient' },
        retirementAllocation: {
          growthRatePct: 6,
          incomeRatePct: 3,
          startGrowthPct: 60,
          endGrowthPct: null,
          endYear: null,
        },
      },
    },
  };
  return { ...makeInput(), scenarios: [conflictScenario] };
}

describe('claim-age-optimizer.worker', () => {
  let handler: CapturedHandler;
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const ctx = setupFakeSelf();
    handler = ctx.handler;
    postMessage = ctx.postMessage;
  });

  it('should_register_message_listener_via_explicit_register', () => {
    // capturedHandler is set during setupFakeSelf; the beforeEach
    // throws if registerOptimizerWorkerListener fails to call
    // addEventListener.
    expect(typeof handler).toBe('function');
  });

  it('should_post_result_with_winner_for_valid_input', async () => {
    handler({
      data: { kind: 'run', runId: 'r-1', input: makeInput() },
    } as MessageEvent<OptimizerWorkerInbound>);
    // Await the worker's microtask chain so the postMessage spy
    // records the result.
    await new Promise((r) => setTimeout(r, 50));
    expect(postMessage).toHaveBeenCalled();
    const out = postMessage.mock.calls[0][0] as OptimizerWorkerOutbound;
    expect(out.kind).toBe('result');
    if (out.kind !== 'result') return;
    expect(out.scenarioId).toBe('s');
    expect(out.winner).not.toBeNull();
    expect(out.partial).toBe(false);
  });

  it('should_post_empty_when_no_primary_member', async () => {
    const input = makeInput();
    const noPrimary: OptimizerWorkerInput = {
      ...input,
      members: [member('m2', false, 'Sam', 1968)],
      ssBenefits: [ssBenefit('m2', 2800)],
    };
    handler({
      data: { kind: 'run', runId: 'r-2', input: noPrimary },
    } as MessageEvent<OptimizerWorkerInbound>);
    await new Promise((r) => setTimeout(r, 20));
    const out = postMessage.mock.calls[0][0] as OptimizerWorkerOutbound;
    expect(out.kind).toBe('empty');
    if (out.kind !== 'empty') return;
    expect(out.reason).toBe('no-primary-member');
  });

  it('should_post_scenarioId_back_in_reply', async () => {
    handler({
      data: { kind: 'run', runId: 'r-3', input: makeInput() },
    } as MessageEvent<OptimizerWorkerInbound>);
    await new Promise((r) => setTimeout(r, 50));
    const out = postMessage.mock.calls[0][0] as OptimizerWorkerOutbound;
    expect(out.scenarioId).toBe('s');
  });

  it('should_echo_runId_back_in_reply', async () => {
    handler({
      data: { kind: 'run', runId: 'unique-run-token', input: makeInput() },
    } as MessageEvent<OptimizerWorkerInbound>);
    await new Promise((r) => setTimeout(r, 50));
    const out = postMessage.mock.calls[0][0] as OptimizerWorkerOutbound;
    expect(out.runId).toBe('unique-run-token');
  });

  it('should_ignore_non_run_messages', () => {
    handler({ data: { kind: 'cancel' } as unknown } as MessageEvent<OptimizerWorkerInbound>);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('should_run_a_named_strategy_plus_allocation_scenario_without_error', async () => {
    // The mutual-exclusion gate is retired: a named strategy + allocation override is valid,
    // so the optimizer produces a result instead of an error row.
    handler({
      data: { kind: 'run', runId: 'r-strat-alloc', input: strategyPlusAllocationInput() },
    } as MessageEvent<OptimizerWorkerInbound>);
    await new Promise((r) => setTimeout(r, 50));
    const out = postMessage.mock.calls[0][0] as OptimizerWorkerOutbound;
    expect(out.kind).toBe('result');
    if (out.kind !== 'result') return;
    expect(out.winner).not.toBeNull();
  });
});
