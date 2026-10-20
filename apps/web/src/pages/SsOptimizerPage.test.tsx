/**
 * SsOptimizerPage tests — render paths + Apply flow + metric toggle +
 * disabled-MC-with-tooltip. Drives IndexedDB through
 * `fake-indexeddb` and asserts the page's wiring around the engine,
 * the worker dispatch (called inline via `runOptimizerForScenario`),
 * and the saveScenario mutation queue.
 */
import 'fake-indexeddb/auto';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllStores, putAggregate } from '../db/store';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import { expectNoA11yViolations } from '../test/a11y';

vi.mock('../auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../sync/SyncContext', () => ({ useSync: vi.fn() }));

// Mock saveScenario so the Apply path can be asserted without a real
// mutation-queue dependency. The other scenario-mutations exports
// (event constants) pass through.
vi.mock('../lib/scenario-mutations', async () => {
  const actual = await vi.importActual<
    typeof import('../lib/scenario-mutations')
  >('../lib/scenario-mutations');
  return {
    ...actual,
    saveScenario: vi.fn(async () => undefined),
  };
});

// Mock the `?worker` import with a fake `Worker`-like class that
// dispatches each `{ kind: 'run' }` message through a settable
// `runImpl` (defaults to the real `runOptimizerForScenario` from the
// worker module). Keeps the page → worker → page protocol exercised
// end-to-end while running compute in-process under jsdom (no real
// Worker available); individual tests can override `runImpl` to seed a
// deterministic result without exercising the real engine.
type OptimizerRunFn = typeof import('../workers/claim-age-optimizer.worker')['runOptimizerForScenario'];
let workerRunImpl: OptimizerRunFn | null = null;
function setOptimizerWorkerRunImpl(fn: OptimizerRunFn | null): void {
  workerRunImpl = fn;
}
vi.mock('../workers/claim-age-optimizer.worker.ts?worker', async () => {
  const { runOptimizerForScenario } = await vi.importActual<
    typeof import('../workers/claim-age-optimizer.worker')
  >('../workers/claim-age-optimizer.worker');
  class FakeOptimizerWorker {
    private listeners = new Map<string, Set<(ev: Event) => void>>();
    addEventListener(type: string, fn: (ev: Event) => void): void {
      let set = this.listeners.get(type);
      if (!set) {
        set = new Set();
        this.listeners.set(type, set);
      }
      set.add(fn);
    }
    removeEventListener(type: string, fn: (ev: Event) => void): void {
      this.listeners.get(type)?.delete(fn);
    }
    postMessage(msg: unknown): void {
      const m = msg as { kind: string; runId: string; input: unknown };
      if (m.kind !== 'run') return;
      const impl = workerRunImpl ?? runOptimizerForScenario;
      void impl(
        m.runId,
        m.input as Parameters<typeof runOptimizerForScenario>[1],
      ).then((out) => {
        const ev = new MessageEvent('message', { data: out });
        this.listeners.get('message')?.forEach((fn) => fn(ev));
      });
    }
    terminate(): void {
      this.listeners.clear();
    }
  }
  return { default: FakeOptimizerWorker };
});

// Mock the MC runner so SsOptimizerPage MC-path integration tests
// can stub progress callbacks + winners without exercising the real
// `monte-carlo.worker.ts`. The fake invokes `onProgress` to drive the
// live status label, then resolves a `Map<scenarioId, OptimizerMcOutcome>`.
type RunMcFn = typeof import('../lib/optimizer-mc-runner')['runOptimizerMonteCarlo'];
let mcRunImpl: RunMcFn | null = null;
function setMcRunImpl(fn: RunMcFn | null): void {
  mcRunImpl = fn;
}
vi.mock('../lib/optimizer-mc-runner', async () => {
  const actual = await vi.importActual<
    typeof import('../lib/optimizer-mc-runner')
  >('../lib/optimizer-mc-runner');
  return {
    ...actual,
    runOptimizerMonteCarlo: ((args: Parameters<RunMcFn>[0]) => {
      const impl = mcRunImpl ?? actual.runOptimizerMonteCarlo;
      return impl(args);
    }) as RunMcFn,
  };
});

import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { saveScenario } from '../lib/scenario-mutations';
import {
  SsOptimizerPage,
  METRIC_STORAGE_KEY,
  PROGRESS_LABEL_FORMAT,
} from './SsOptimizerPage';
import { PATH_COUNT_STORAGE_KEY } from './ss-optimizer-path-count';

/** Budget for this file's `waitFor` polls. These wait on the optimizer's async
 *  MC work to settle and render; v8 coverage instrumentation plus a fully
 *  parallel local coverage run (maxWorkers is CI-only since 2026-08-13) can
 *  starve that work past a flat 5s, which surfaced as a rendered-value query
 *  failing rather than a test timeout. Non-coverage runs keep 5s so a genuine
 *  hang still fails fast. */
const WAIT_TIMEOUT_MS = process.env.VITEST_COVERAGE === '1' ? 30_000 : 5000;

const HH = 'hh-test';

function setupContexts(): void {
  (useAuth as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    householdId: HH,
    me: { email: 'me@example.test', displayName: 'Me', roles: [], userId: 'u-1' },
    isAuthenticated: true,
  });
  (useSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    notifyPending: vi.fn(),
    state: { kind: 'synced', lastSyncedAt: null },
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SsOptimizerPage />
    </MemoryRouter>,
  );
}

async function seedMember(
  id: string,
  isPrimary: boolean,
  firstName: string,
  birthYear: number,
): Promise<void> {
  const m: Aggregate<HouseholdMemberPayload> = {
    id,
    householdId: HH,
    aggregateType: 'householdMember',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      isPrimary,
      firstName,
      lastName: 'Demo',
      email: `${id}@example.test`,
      birthdate: `${birthYear}-01-01`,
    },
  };
  await putAggregate('householdMember', m);
}

async function seedSsBenefit(memberId: string, pia: number | null): Promise<void> {
  const ss: Aggregate<SocialSecurityBenefitPayload> = {
    id: `ss-${memberId}`,
    householdId: HH,
    aggregateType: 'socialSecurityBenefit',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      householdMemberId: memberId,
      pia,
      piaAsOfDate: '2026-01-15',
      notes: null,
    },
  };
  await putAggregate('socialSecurityBenefit', ss);
}

async function seedScenario(
  id: string,
  name: string,
  opts: {
    primaryAge?: number;
    secondaryAge?: number;
    isPrimary?: boolean;
    parentId?: string | null;
    benefitReductionPct?: number;
    colaPct?: number;
  } = {},
): Promise<void> {
  const payload: ScenarioPayload = {
    name,
    description: '',
    parentScenarioId: opts.parentId ?? null,
    isPrimary: opts.isPrimary ?? true,
    notes: '',
    overrides: {
      socialSecurity:
        opts.primaryAge !== undefined
          ? {
              primary: { ageYears: opts.primaryAge, ageMonths: 0 },
              ...(opts.secondaryAge !== undefined
                ? { secondary: { ageYears: opts.secondaryAge, ageMonths: 0 } }
                : {}),
              ...(opts.benefitReductionPct !== undefined
                ? { benefitReductionPct: opts.benefitReductionPct }
                : {}),
              ...(opts.colaPct !== undefined ? { colaPct: opts.colaPct } : {}),
            }
          : undefined,
      retirementAge: {
        primary: { ageYears: 67, ageMonths: 0 },
        secondary: { ageYears: 67, ageMonths: 0 },
      },
      inflation: { ratePct: 0 },
      lifeExpectancy: { primary: 95, secondary: 95 },
    },
  };
  await putAggregate('scenario', {
    id,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload,
  });
}

async function seedAccount(): Promise<void> {
  const acc: Aggregate<AccountPayload> = {
    id: 'a1',
    householdId: HH,
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
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
  await putAggregate('account', acc);
  const bal: Aggregate<AccountBalancePayload> = {
    id: 'b1',
    householdId: HH,
    aggregateType: 'accountBalance',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
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
  await putAggregate('accountBalance', bal);
}

beforeEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
  window.localStorage.clear();
  setupContexts();
});

afterEach(async () => {
  await clearAllStores();
});

describe('SsOptimizerPage', () => {
  it('should_render_the_save_to_scenario_sentence_in_the_page_subtitle', async () => {
    // The subtitle's closing sentence names the save action, one of the
    // surfaces the scoped action-label invariant covers. No other test in
    // this file (or in ss-optimizer-action-labels.test.tsx, which renders
    // OptimizerResultsTable with no PageHeader at all) reads the header
    // block, so without this a revert to the old "Apply writes…" wording
    // would leave the suite green. Verbatim, not a loose regex.
    await seedMember('m1', true, 'Alex', 1965);
    await seedScenario('s1', 'Base');
    const { container } = renderPage();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          name: 'Social Security claim-age comparison',
          level: 1,
        }),
      ).toBeDefined();
    });
    const header = container.querySelector('[data-testid="page-header-title-wrap"]');
    expect(header).not.toBeNull();
    const text = header?.textContent ?? '';
    expect(text).toContain(
      "Save to scenario writes a result into that scenario's Social Security override.",
    );
    // The retired wording must be gone from the subtitle entirely.
    expect(text).not.toContain('Apply writes');
  });

  it('should_render_disclaimer_with_correct_role_and_label', async () => {
    await seedMember('m1', true, 'Alex', 1965);
    await seedScenario('s1', 'Base');
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('note', { name: /Social Security claim-age comparison disclaimer/i })).toBeDefined();
    });
    const note = screen.getByRole('note', { name: /Social Security claim-age comparison disclaimer/i });
    expect(note.textContent ?? '').toContain('Illustrative only');
    // Guard the neutral body copy directly (not just the aria-label): a
    // regression to advice-toned wording would drop this phrase even if the
    // label stayed intact.
    expect(note.textContent ?? '').toMatch(/does not tell you when to claim/i);
    // The MC metric's ssByYear omits the earnings test (a disclosed
    // deferral); the standing notice must qualify Monte Carlo
    // results so users don't read the SS page's "earnings test is modeled"
    // disclosure (true of the deterministic path) as covering MC too.
    expect(note.textContent ?? '').toMatch(
      /Monte Carlo results also\s+leave out the earnings test/i,
    );
    // Verbatim, not a loose regex: this is one of the two legitimate
    // ordinary-verb uses of "apply" on this page, kept exactly as written so a
    // later Apply-sweep cannot reword or delete it unnoticed.
    expect(note.textContent ?? '').toContain(
      'only the single-path results apply it.',
    );
  });

  it('should_render_disclaimer_above_metric_toggle', async () => {
    // The disclaimer sits
    // directly under PageHeader and ABOVE the metric toggle. Verify
    // via DOM position so a layout-only regression is caught.
    await seedMember('m1', true, 'Alex', 1965);
    await seedScenario('s1', 'Base');
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('note', { name: /Social Security claim-age comparison disclaimer/i })).toBeDefined();
    });
    const note = screen.getByRole('note', { name: /Social Security claim-age comparison disclaimer/i });
    const radiogroup = screen.getByRole('radiogroup', { name: /Comparison metric/i });
    // Node.DOCUMENT_POSITION_FOLLOWING = 0x04 → set when the argument
    // comes AFTER `note` in document order.
    expect(
      note.compareDocumentPosition(radiogroup) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it('should_render_empty_state_when_no_household_members', async () => {
    await seedScenario('s1', 'Base');
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/add household members/i)).toBeDefined();
    });
  });

  it('should_render_one_row_per_non_deleted_scenario', async () => {
    // Pure wiring test (one row per scenario + Apply appears). The real
    // deterministic claim-age engine math is owned by
    // `lib/claim-age-optimizer.test.ts` + `workers/claim-age-optimizer.worker.test.ts`,
    // so stub the worker with a realistic winner to skip three live 60-yr
    // runs (keep wiring coverage, drop the duplicate engine math).
    setOptimizerWorkerRunImpl(async (runId, input) => ({
      kind: 'result',
      runId,
      scenarioId: input.scenarioId,
      winner: {
        primaryAgeYears: 67,
        secondaryAgeYears: 67,
        metricValue: 1_000_000,
        alreadyAtOptimum: false,
      },
      partial: false,
      missingPiaMembers: [],
    }));
    try {
      await seedMember('m1', true, 'Alex', 1965);
      await seedMember('m2', false, 'Sam', 1968);
      await seedSsBenefit('m1', 3500);
      await seedSsBenefit('m2', 2800);
      await seedAccount();
      await seedScenario('s1', 'Base');
      await seedScenario('s2', 'Aggressive', { isPrimary: false, parentId: 's1' });
      await seedScenario('s3', 'Conservative', { isPrimary: false, parentId: 's1' });
      renderPage();
      // 10s ceiling: the IDB seed + first render legitimately exceeds the 1s
      // waitFor default under an instrumented (coverage) run.
      await waitFor(() => {
        expect(screen.getByRole('grid', { name: /Social Security claim-age comparison results/i })).toBeDefined();
      }, { timeout: 10_000 });
      // Scenario rows populate a tick after the grid landmark mounts under
      // parallel load; `findByText` retries until each row name renders.
      expect(await screen.findByText('Base')).toBeDefined();
      expect(await screen.findByText('Aggressive')).toBeDefined();
      expect(await screen.findByText('Conservative')).toBeDefined();
      // Wait for at least one row to finish calculating so the metric
      // column populates.
      await waitFor(
        () => {
          expect(screen.queryAllByText('Save to scenario').length).toBeGreaterThan(0);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
    } finally {
      setOptimizerWorkerRunImpl(null);
    }
  });

  it('should_show_pia_not_set_link_when_member_has_no_pia', async () => {
    await seedMember('m1', true, 'Alex', 1965);
    await seedMember('m2', false, 'Sam', 1968);
    await seedSsBenefit('m1', 3500);
    await seedSsBenefit('m2', null);
    await seedAccount();
    await seedScenario('s1', 'Base');
    renderPage();
    await waitFor(
      () => {
        expect(screen.getAllByText(/PIA not set/).length).toBeGreaterThan(0);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
  });

  it('should_render_both_members_missing_pia_row_collapse', async () => {
    await seedMember('m1', true, 'Alex', 1965);
    await seedSsBenefit('m1', null);
    await seedAccount();
    await seedScenario('s1', 'Base');
    renderPage();
    await waitFor(
      () => {
        expect(screen.getByText(/Add PIAs on the/)).toBeDefined();
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
  });

  it('should_restore_mc_metric_from_localStorage_on_load', async () => {
    // Stale `mc` value from a prior session must restore — both
    // options are now selectable.
    await seedMember('m1', true, 'Alex', 1965);
    await seedScenario('s1', 'Base');
    window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('radiogroup', { name: /Comparison metric/i })).toBeDefined();
    });
    const mcRadio = screen.getByRole('radio', { name: /plan success/i });
    expect((mcRadio as HTMLInputElement).checked).toBe(true);
  });

  it('should_offer_both_balance_and_mc_metric_options', async () => {
    // Both metric options are selectable.
    await seedMember('m1', true, 'Alex', 1965);
    await seedScenario('s1', 'Base');
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('radiogroup', { name: /Comparison metric/i })).toBeDefined();
    });
    expect(screen.queryByRole('radio', { name: /plan success/i })).toBeDefined();
    expect(
      screen.getByRole('radio', { name: /end-of-plan balance/i }),
    ).toBeDefined();
  });

  it('should_render_run_button_and_click_prompt_when_mc_metric_selected', async () => {
    await seedMember('m1', true, 'Alex', 1965);
    await seedSsBenefit('m1', 3500);
    await seedAccount();
    await seedScenario('s1', 'Base');
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /plan success/i })).toBeDefined();
    });
    await userEvent.click(screen.getByRole('radio', { name: /plan success/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /run comparison/i })).toBeDefined();
    });
    expect(screen.getByText(/number of scenarios/i)).toBeDefined();
  });

  it('should_open_confirm_dialog_on_apply_click', async () => {
    await seedMember('m1', true, 'Alex', 1965);
    await seedMember('m2', false, 'Sam', 1968);
    await seedSsBenefit('m1', 3500);
    await seedSsBenefit('m2', 2800);
    await seedAccount();
    await seedScenario('s1', 'Base');
    renderPage();
    await waitFor(
      () => {
        const buttons = screen
          .getAllByRole('button', { name: 'Save to scenario' })
          .filter((b) => !b.hasAttribute('disabled'));
        expect(buttons.length).toBeGreaterThan(0);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    const applyBtn = screen
      .getAllByRole('button', { name: 'Save to scenario' })
      .find((b) => !b.hasAttribute('disabled'));
    if (!applyBtn) throw new Error('No enabled Apply button rendered');
    await userEvent.click(applyBtn);
    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeDefined();
    });
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Save claim ages to scenario')).toBeDefined();
    expect(within(dialog).getByText(/Set Alex's claim age to/)).toBeDefined();
  });

  it('should_call_saveScenario_with_merged_override_payload_on_confirm', async () => {
    await seedMember('m1', true, 'Alex', 1965);
    await seedMember('m2', false, 'Sam', 1968);
    await seedSsBenefit('m1', 3500);
    await seedSsBenefit('m2', 2800);
    await seedAccount();
    await seedScenario('s1', 'Base', {
      primaryAge: 65,
      secondaryAge: 65,
      benefitReductionPct: 25,
      colaPct: 1.5,
    });
    renderPage();
    await waitFor(
      () => {
        const buttons = screen
          .getAllByRole('button', { name: 'Save to scenario' })
          .filter((b) => !b.hasAttribute('disabled'));
        expect(buttons.length).toBeGreaterThan(0);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    const applyBtn = screen
      .getAllByRole('button', { name: 'Save to scenario' })
      .find((b) => !b.hasAttribute('disabled'));
    if (!applyBtn) throw new Error('No enabled Apply button');
    await userEvent.click(applyBtn);
    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeDefined();
    });
    // Confirm: the ConfirmDialog autoFocuses the primary action, so a
    // simple Enter or click on the "Apply" confirm button fires.
    const confirmBtn = within(screen.getByRole('alertdialog')).getByRole(
      'button',
      { name: 'Save' },
    );
    await userEvent.click(confirmBtn);
    await waitFor(() => {
      expect(saveScenario).toHaveBeenCalled();
    });
    const call = (saveScenario as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { payload: ScenarioPayload };
    const ss = call.payload.overrides.socialSecurity;
    expect(ss).toBeDefined();
    if (!ss) return;
    expect(ss.primary.ageMonths).toBe(0);
    // Preserved fields survive the merge:
    expect(ss.benefitReductionPct).toBe(25);
    expect(ss.colaPct).toBe(1.5);
  });

  it('should_route_apply_prompt_member_names_through_memberLabel_fallback', async () => {
    // Empty firstName → memberLabel falls back to lowercase 'primary' /
    // 'secondary' per the member-label rule ("Form controls" in docs/ui-conventions.md).
    await seedMember('m1', true, '', 1965);
    await seedMember('m2', false, '', 1968);
    await seedSsBenefit('m1', 3500);
    await seedSsBenefit('m2', 2800);
    await seedAccount();
    await seedScenario('s1', 'Base');
    renderPage();
    await waitFor(
      () => {
        const buttons = screen
          .getAllByRole('button', { name: 'Save to scenario' })
          .filter((b) => !b.hasAttribute('disabled'));
        expect(buttons.length).toBeGreaterThan(0);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    const applyBtn = screen
      .getAllByRole('button', { name: 'Save to scenario' })
      .find((b) => !b.hasAttribute('disabled'));
    if (!applyBtn) throw new Error('No enabled Apply button');
    await userEvent.click(applyBtn);
    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeDefined();
    });
    expect(
      within(screen.getByRole('alertdialog')).getByText(
        /Set primary's claim age/,
      ),
    ).toBeDefined();
  });

  it('should_render_single_native_thead_descendant_of_TableScroll', async () => {
    // Sticky-pin tripwire: a future React Aria release injecting a
    // wrapper between `<table>` and `<thead>` is caught here.
    await seedMember('m1', true, 'Alex', 1965);
    await seedMember('m2', false, 'Sam', 1968);
    await seedSsBenefit('m1', 3500);
    await seedSsBenefit('m2', 2800);
    await seedAccount();
    await seedScenario('s1', 'Base');
    const { container } = renderPage();
    await waitFor(
      () => {
        expect(container.querySelector('table')).not.toBeNull();
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    const scroll = container.querySelector('[role="region"]');
    expect(scroll).not.toBeNull();
    if (!scroll) return;
    // RA Table can briefly mount a transient second <thead> while the grid
    // settles under parallel load; poll until exactly one remains so the
    // tripwire asserts the settled DOM, not a mid-render frame.
    await waitFor(() => {
      expect(scroll.querySelectorAll('thead').length).toBe(1);
    });
    // The thead must be a direct child of the <table> (sticky-pin
    // selector requires it).
    const table = scroll.querySelector('table');
    expect(table).not.toBeNull();
    if (!table) return;
    expect(table.children[0]?.tagName.toLowerCase()).toBe('thead');
  });

  it('PROGRESS_LABEL_FORMAT_matches_verbatim_shape', () => {
    // The live MC progress label uses this string. Pin the format here so the
    // constant doesn't drift from what the MC orchestrator reports.
    expect(
      PROGRESS_LABEL_FORMAT(3, 12, { scenarios: 8, pairs: 81 }),
    ).toBe('scenario 3 / 8, pair 12 / 81');
  });

  it('should_render_user_facing_message_for_no_retirement_date_empty_state', async () => {
    // Member with no valid birthdate → resolveMemberRetirementDates
    // returns null for the primary → buildPreparedInputs returns null
    // → worker returns `{ kind: 'empty', reason: 'no-retirement-date' }`.
    // The page renders the EmptyReasonRow's user-facing copy from
    // ss-optimizer-row-variants.tsx (NOT the raw machine code).
    const noBirthdate: Aggregate<HouseholdMemberPayload> = {
      id: 'm1',
      householdId: HH,
      aggregateType: 'householdMember',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        isPrimary: true,
        firstName: 'Alex',
        lastName: 'Demo',
        email: 'm1@example.test',
        birthdate: '', // invalid → date math throws → returns null.
      },
    };
    await putAggregate('householdMember', noBirthdate);
    await seedScenario('s1', 'Base');
    renderPage();
    // Wait for the actual EmptyReasonRow copy — proves the row
    // resolved (not "still loading") AND lands on the user-facing
    // message rather than the raw `no-retirement-date` reason code.
    await waitFor(
      () => {
        expect(
          screen.getByText(/Set a primary retirement age/i),
        ).toBeDefined();
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    // Raw machine codes must never reach the DOM (regression guard
    // against a future rewrite that falls back to `${reason}`).
    expect(screen.queryByText(/no-retirement-date/)).toBeNull();
    expect(screen.queryByText(/no-primary-member/)).toBeNull();
  });

  it('should_render_past_window_when_single_member_past_70', async () => {
    // Born 1955 → ~age 71 in 2026 → empty grid → past-window row.
    await seedMember('m1', true, 'Alex', 1955);
    await seedSsBenefit('m1', 3500);
    await seedAccount();
    await seedScenario('s1', 'Base');
    renderPage();
    await waitFor(
      () => {
        expect(screen.getByText(/past claim-age window/i)).toBeDefined();
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    // Apply is disabled (mirrors BothMissingPiaRow). Not "Calculating…".
    expect(screen.queryByText(/calculating/i)).toBeNull();
  });

  it('should_render_past_window_when_both_members_past_70', async () => {
    // Both born 1955 → both past 70 → empty grid for both members.
    await seedMember('m1', true, 'Alex', 1955);
    await seedMember('m2', false, 'Sam', 1955);
    await seedSsBenefit('m1', 3500);
    await seedSsBenefit('m2', 2800);
    await seedAccount();
    await seedScenario('s1', 'Base');
    renderPage();
    await waitFor(
      () => {
        expect(screen.getByText(/past claim-age window/i)).toBeDefined();
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    expect(screen.queryByText(/calculating/i)).toBeNull();
  });

  it('should_render_partial_secondary_prompt_when_secondary_past_70', async () => {
    // Primary born 1965 (~62 in 2026 → grid OK); secondary born 1955
    // (~71 → empty grid → past-window for secondary only).
    await seedMember('m1', true, 'Alex', 1965);
    await seedMember('m2', false, 'Sam', 1955);
    await seedSsBenefit('m1', 3500);
    await seedSsBenefit('m2', 2800);
    await seedAccount();
    await seedScenario('s1', 'Base', {
      primaryAge: 65,
      secondaryAge: 67,
      benefitReductionPct: 12,
      colaPct: 2,
    });
    renderPage();
    await waitFor(
      () => {
        const buttons = screen
          .getAllByRole('button', { name: 'Save to scenario' })
          .filter((b) => !b.hasAttribute('disabled'));
        expect(buttons.length).toBeGreaterThan(0);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    const applyBtn = screen
      .getAllByRole('button', { name: 'Save to scenario' })
      .find((b) => !b.hasAttribute('disabled'));
    if (!applyBtn) throw new Error('No enabled Apply button rendered');
    await userEvent.click(applyBtn);
    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeDefined();
    });
    const dialog = screen.getByRole('alertdialog');
    expect(
      within(dialog).getByText(
        /Sam is past the claim-age window, keeping their current setting/,
      ),
    ).toBeDefined();
    // Confirm + assert mutation payload preserves the existing secondary.
    const confirmBtn = within(dialog).getByRole('button', { name: 'Save' });
    await userEvent.click(confirmBtn);
    await waitFor(() => {
      expect(saveScenario).toHaveBeenCalled();
    });
    const call = (saveScenario as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { payload: ScenarioPayload };
    const ss = call.payload.overrides.socialSecurity;
    expect(ss).toBeDefined();
    if (!ss) return;
    // Existing secondary preserved.
    expect(ss.secondary?.ageYears).toBe(67);
    expect(ss.secondary?.ageMonths).toBe(0);
  });

  it('should_disable_apply_with_tooltip_when_resolved_equals_optimum', async () => {
    // Deterministic fixture: the worker mock returns a winner with
    // `alreadyAtOptimum: true`. This is the contract the ApplyButton
    // consumes (ss-optimizer-page-chrome.tsx); whatever engine output
    // produces `alreadyAtOptimum: true`, the page MUST render Apply as
    // disabled + `aria-disabled="true"`. Asserting unconditionally
    // proves the row resolved (no "Calculating…" false-pass) AND that
    // the disabled-tooltip path is wired.
    setOptimizerWorkerRunImpl(async (runId, input) => ({
      kind: 'result',
      runId,
      scenarioId: input.scenarioId,
      winner: {
        primaryAgeYears: 70,
        secondaryAgeYears: null,
        metricValue: 1_000_000,
        alreadyAtOptimum: true,
      },
      partial: false,
      missingPiaMembers: [],
    }));
    try {
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base', { primaryAge: 70 });
      renderPage();
      await waitFor(
        () => {
          expect(
            screen.getAllByRole('button', { name: 'Already set' }).length,
          ).toBeGreaterThan(0);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      const rowApply = screen.getAllByRole('button', { name: 'Already set' })[0];
      // Unconditional assertions — no `if (button.disabled)` wrapper.
      // `alreadyAtOptimum: true` from the engine MUST surface as the
      // disabled-Apply state. Native `disabled` is the single source of
      // truth; the redundant `aria-disabled` was dropped.
      expect(rowApply.hasAttribute('disabled')).toBe(true);
    } finally {
      setOptimizerWorkerRunImpl(null);
    }
  });

  it('should_prompt_secondary_has_no_PIA_recorded_when_secondary_missing_pia', async () => {
    // Primary HAS PIA; secondary missing PIA. `mergeSsOverride`
    // preserves the secondary's existing setting unchanged, so the
    // prompt MUST say so — the prior "Set Alex's claim age to X and
    // Sam's to X" copy misrepresented Apply behaviour.
    await seedMember('m1', true, 'Alex', 1965);
    await seedMember('m2', false, 'Sam', 1968);
    await seedSsBenefit('m1', 3500);
    await seedSsBenefit('m2', null);
    await seedAccount();
    await seedScenario('s1', 'Base');
    renderPage();
    await waitFor(
      () => {
        const buttons = screen
          .getAllByRole('button', { name: 'Save to scenario' })
          .filter((b) => !b.hasAttribute('disabled'));
        expect(buttons.length).toBeGreaterThan(0);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    const applyBtn = screen
      .getAllByRole('button', { name: 'Save to scenario' })
      .find((b) => !b.hasAttribute('disabled'));
    if (!applyBtn) throw new Error('No enabled Apply button rendered');
    await userEvent.click(applyBtn);
    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeDefined();
    });
    const dialog = screen.getByRole('alertdialog');
    expect(
      within(dialog).getByText(
        /Sam has no PIA recorded, keeping their current setting/,
      ),
    ).toBeDefined();
    // Must NOT mention setting Sam's claim age — only Alex's.
    expect(within(dialog).queryByText(/and Sam's to/)).toBeNull();
  });

  it('should_prompt_primary_has_no_PIA_recorded_when_primary_missing_pia', async () => {
    // Mirror of the secondary-missing-PIA prompt path: primary missing
    // PIA → `mergeSsOverride` preserves primary's existing setting; the
    // engine returns the unchanged primary age and the secondary's
    // winning age. The prompt MUST say so explicitly — falling through
    // to the generic "Set Alex's claim age to X and Sam's to Y" copy
    // misrepresents Apply behaviour.
    setOptimizerWorkerRunImpl(async (runId, input) => ({
      kind: 'result',
      runId,
      scenarioId: input.scenarioId,
      winner: {
        primaryAgeYears: 67,
        secondaryAgeYears: 70,
        metricValue: 1_000_000,
        alreadyAtOptimum: false,
      },
      partial: false,
      missingPiaMembers: ['m1'],
    }));
    try {
      await seedMember('m1', true, 'Alex', 1965);
      await seedMember('m2', false, 'Sam', 1968);
      await seedSsBenefit('m1', null);
      await seedSsBenefit('m2', 2800);
      await seedAccount();
      await seedScenario('s1', 'Base', { primaryAge: 67, secondaryAge: 65 });
      renderPage();
      await waitFor(
        () => {
          const buttons = screen
            .getAllByRole('button', { name: 'Save to scenario' })
            .filter((b) => !b.hasAttribute('disabled'));
          expect(buttons.length).toBeGreaterThan(0);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      const applyBtn = screen
        .getAllByRole('button', { name: 'Save to scenario' })
        .find((b) => !b.hasAttribute('disabled'));
      if (!applyBtn) throw new Error('No enabled Apply button rendered');
      await userEvent.click(applyBtn);
      await waitFor(() => {
        expect(screen.getByRole('alertdialog')).toBeDefined();
      });
      const dialog = screen.getByRole('alertdialog');
      expect(
        within(dialog).getByText(
          /Alex has no PIA recorded, keeping their current setting/,
        ),
      ).toBeDefined();
      // Must NOT mention setting Alex's claim age — only Sam's.
      expect(within(dialog).queryByText(/Set Alex's claim age/)).toBeNull();
    } finally {
      setOptimizerWorkerRunImpl(null);
    }
  });

  it('should_render_unsupported_row_for_cbp_unconfigured_reason', async () => {
    // `cbp-unconfigured` is the only Unsupported reason — the
    // four other reasons (`cbp-linked-income`, `pre-primary-targeted-
    // deposits`, `annuity-cbp-fold`, `post-primary-contributions`) are
    // routed through `runBalanceProjection` and produce real winners.
    setOptimizerWorkerRunImpl(async (runId, input) => ({
      kind: 'unsupported',
      runId,
      scenarioId: input.scenarioId,
      reason: 'cbp-unconfigured',
    }));
    try {
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      renderPage();
      await waitFor(
        () => {
          expect(
            screen.getByText(/Cash Balance Pension account whose election/i),
          ).toBeDefined();
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      const link = screen.getByRole('link', { name: /balance projection/i });
      expect(link.getAttribute('href')).toBe('/balance-projection');
    } finally {
      setOptimizerWorkerRunImpl(null);
    }
  });

  it('should_dispatch_scenario_compute_to_the_optimizer_worker', async () => {
    // Page integration: at least one Apply button appears, which only
    // happens after the worker's `{ kind: 'result' }` reply is wired
    // back into row state. If the worker dispatch path were broken
    // (no postMessage / no listener removal / no scenarioId filter)
    // the row would stay at "Calculating…" and no Apply button would
    // render.
    await seedMember('m1', true, 'Alex', 1965);
    await seedSsBenefit('m1', 3500);
    await seedAccount();
    await seedScenario('s1', 'Base');
    renderPage();
    await waitFor(
      () => {
        expect(
          screen.getAllByRole('button', { name: 'Save to scenario' }).length,
        ).toBeGreaterThan(0);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
  });

  it('expectNoA11yViolations_on_disclaimer_and_radiogroup', async () => {
    await seedMember('m1', true, 'Alex', 1965);
    await seedScenario('s1', 'Base');
    const { container } = renderPage();
    await waitFor(() => {
      expect(screen.getByRole('note', { name: /Social Security claim-age comparison disclaimer/i })).toBeDefined();
    });
    await expectNoA11yViolations(container);
  });

  // MC-path integration tests. Mock `runOptimizerMonteCarlo` so
  // the test can drive `onProgress` callbacks + return a winner map
  // synchronously, then assert Run + progress label + Cancel + partial
  // accumulator render on the live DOM.
  describe('MC path', () => {
    afterEach(() => setMcRunImpl(null));

    it('should_populate_table_with_winners_after_Run_click', async () => {
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      // Fake MC runner: invoke a progress tick then resolve a winner.
      setMcRunImpl(async (args) => {
        args.onProgress?.({
          scenarioIdx: 1,
          pairIdx: 1,
          cumulativeIdx: 3,
          totals: { scenarios: 1, pairs: 9, totalPairs: 9 },
        });
        return new Map([
          [
            's1',
            {
              kind: 'result' as const,
              winner: {
                primaryAgeYears: 70,
                secondaryAgeYears: null,
                metricValue: 0.85,
              },
              partial: false,
              missingPiaMembers: [],
              alreadyAtOptimum: false,
            },
          ],
        ]);
      });
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      renderPage();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run comparison/i })).toBeDefined();
      });
      await userEvent.click(screen.getByRole('button', { name: /run comparison/i }));
      // Wait for the table to populate with the mocked winner row.
      await waitFor(
        () => {
          expect(screen.getByRole('grid', { name: /Social Security claim-age comparison results/i })).toBeDefined();
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      // Plan-success% formatted from metricValue × 100. findBy*, not getBy*:
      // the grid resolving above does not mean its ROWS have rendered.
      expect(await screen.findByText(/85\.0%/)).toBeDefined();
    });

    it('should_show_current_to_recommended_transition_when_they_differ', async () => {
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      // Current claim age 62; optimizer recommends 65 → "62 → 65".
      await seedScenario('s1', 'Base', { primaryAge: 62 });
      setMcRunImpl(async () => new Map([
        [
          's1',
          {
            kind: 'result' as const,
            winner: {
              primaryAgeYears: 65,
              secondaryAgeYears: null,
              metricValue: 0.85,
            },
            partial: false,
            missingPiaMembers: [],
            alreadyAtOptimum: false,
          },
        ],
      ]));
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      renderPage();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run comparison/i })).toBeDefined();
      });
      await userEvent.click(screen.getByRole('button', { name: /run comparison/i }));
      await waitFor(
        () => {
          // Current age and recommended age both render in the cell.
          expect(screen.getByText('62')).toBeDefined();
          expect(screen.getByText('65')).toBeDefined();
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      // Not yet applied → Apply is enabled.
      const apply = screen
        .getAllByRole('button', { name: 'Save to scenario' })
        .find((b) => !b.hasAttribute('disabled'));
      expect(apply).toBeDefined();
    });

    // 15s ceiling: the seed + full MC-path render legitimately exceeds the
    // 5s default when the whole suite contends for CPU (same class of
    // false-timeout the API jest config documents for its 30s ceiling).
    it('should_show_only_the_number_and_Applied_when_current_already_matches', { timeout: 15_000 }, async () => {
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      // Current claim age already equals the recommendation.
      await seedScenario('s1', 'Base', { primaryAge: 65 });
      setMcRunImpl(async () => new Map([
        [
          's1',
          {
            kind: 'result' as const,
            winner: {
              primaryAgeYears: 65,
              secondaryAgeYears: null,
              metricValue: 0.85,
            },
            partial: false,
            missingPiaMembers: [],
            // Engine flag is irrelevant — the UI derives applied state
            // live from current-vs-recommended, fixing the MC tab which
            // never re-runs after an Apply.
            alreadyAtOptimum: false,
          },
        ],
      ]));
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      renderPage();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run comparison/i })).toBeDefined();
      });
      await userEvent.click(screen.getByRole('button', { name: /run comparison/i }));
      await waitFor(
        () => {
          expect(
            screen.getAllByRole('button', { name: 'Already set' }).length,
          ).toBeGreaterThan(0);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      // Matched → no transition arrow, just the number.
      expect(screen.queryByText('→')).toBeNull();
      expect(screen.getByText('65')).toBeDefined();
      expect(
        screen.getAllByRole('button', { name: 'Already set' })[0].hasAttribute('disabled'),
      ).toBe(true);
    });

    it('should_show_current_to_recommended_on_the_balance_tab_too', async () => {
      // Default metric is the deterministic End-of-plan balance tab.
      setOptimizerWorkerRunImpl(async (runId, input) => ({
        kind: 'result',
        runId,
        scenarioId: input.scenarioId,
        winner: {
          primaryAgeYears: 65,
          secondaryAgeYears: null,
          metricValue: 1_000_000,
          alreadyAtOptimum: false,
        },
        partial: false,
        missingPiaMembers: [],
      }));
      try {
        await seedMember('m1', true, 'Alex', 1965);
        await seedSsBenefit('m1', 3500);
        await seedAccount();
        await seedScenario('s1', 'Base', { primaryAge: 62 });
        renderPage();
        await waitFor(
          () => {
            expect(screen.getAllByText('62').length).toBeGreaterThan(0);
            expect(screen.getAllByText('65').length).toBeGreaterThan(0);
          },
          { timeout: WAIT_TIMEOUT_MS },
        );
      } finally {
        setOptimizerWorkerRunImpl(null);
      }
    });

    it('should_render_progress_bar_with_verbatim_aria_label_during_mc_run', async () => {
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      // Fake runner: tick progress, then stall until the test releases
      // the promise so the live progress UI has time to render.
      let release: () => void = () => undefined;
      const released = new Promise<void>((r) => {
        release = r;
      });
      setMcRunImpl(async (args) => {
        args.onProgress?.({
          scenarioIdx: 1,
          pairIdx: 3,
          cumulativeIdx: 3,
          totals: { scenarios: 1, pairs: 9, totalPairs: 9 },
        });
        await released;
        return new Map();
      });
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      renderPage();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run comparison/i })).toBeDefined();
      });
      await userEvent.click(screen.getByRole('button', { name: /run comparison/i }));
      // Visual progress bar uses the verbatim label as its aria-label
      // (text still readable to screen readers); the visible "Scenario
      // X of Y" line is a separate sighted-user cue.
      await waitFor(
        () => {
          const bar = screen.getByRole('progressbar', {
            name: PROGRESS_LABEL_FORMAT(1, 3, { scenarios: 1, pairs: 9 }),
          });
          expect(bar).toBeDefined();
          // Bar uses the global cumulativeIdx + totalPairs so
          // 1-D fallback scenarios don't overshoot. cumulativeIdx is
          // pinned to 3 in the test runner, totalPairs to 9.
          expect(bar.getAttribute('aria-valuenow')).toBe('3');
          expect(bar.getAttribute('aria-valuemax')).toBe('9');
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      // Sighted line now carries a visible % alongside "Scenario X of Y".
      expect(screen.getByText(/Scenario 1 of 1 · \d+%/)).toBeDefined();
      release();
    });

    it('should_show_running_notice_during_mc_run_then_hide_on_completion', async () => {
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      let release: () => void = () => undefined;
      const released = new Promise<void>((r) => {
        release = r;
      });
      setMcRunImpl(async () => {
        await released;
        return new Map();
      });
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      renderPage();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run comparison/i })).toBeDefined();
      });
      // Notice is absent before the run starts.
      expect(screen.queryByText(/Keep this screen open/i)).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: /run comparison/i }));
      // Banner shows while the sweep is in flight.
      await screen.findByText(/Keep this screen open/i);
      // …and clears once the run resolves.
      release();
      await waitFor(() => {
        expect(screen.queryByText(/Keep this screen open/i)).toBeNull();
      });
    });

    it('should_render_per_scenario_path_progress_bar_in_the_computing_row', async () => {
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      // Fake runner: emit a smooth per-scenario path-progress tick, then
      // stall so the in-flight row's bar stays mounted for the assertion.
      let release: () => void = () => undefined;
      const released = new Promise<void>((r) => {
        release = r;
      });
      setMcRunImpl(async (args) => {
        args.onScenarioProgress?.('s1', { done: 250, total: 1000 });
        await released;
        return new Map();
      });
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      renderPage();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run comparison/i })).toBeDefined();
      });
      await userEvent.click(screen.getByRole('button', { name: /run comparison/i }));
      // The computing row renders a determinate McProgressBar whose
      // verbatim aria-label reports path counts (250 of 1,000).
      await waitFor(
        () => {
          const bar = screen.getByRole('progressbar', {
            name: /Calculating: 250 of 1,000 paths/i,
          });
          expect(bar.getAttribute('aria-valuenow')).toBe('250');
          expect(bar.getAttribute('aria-valuemax')).toBe('1000');
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      release();
    });

    it('should_cancel_run_via_abort_and_render_partial', async () => {
      await seedMember('m1', true, 'Alex', 1965);
      await seedMember('m2', false, 'Sam', 1968);
      await seedSsBenefit('m1', 3500);
      await seedSsBenefit('m2', 2800);
      await seedAccount();
      await seedScenario('s1', 'A');
      await seedScenario('s2', 'B', { isPrimary: false, parentId: 's1' });
      // Fake runner: capture the signal, partially populate a result
      // for s1, wait until aborted, then return the partial map.
      let capturedSignal: AbortSignal | undefined;
      setMcRunImpl(async (args) => {
        capturedSignal = args.signal;
        // Yield once so the page can render the Cancel button.
        await new Promise<void>((r) => setTimeout(r, 0));
        args.onProgress?.({
          scenarioIdx: 1,
          pairIdx: 1,
          cumulativeIdx: 1,
          totals: { scenarios: 2, pairs: 9, totalPairs: 18 },
        });
        // Wait until the abort fires.
        await new Promise<void>((resolve) => {
          if (capturedSignal?.aborted) {
            resolve();
            return;
          }
          capturedSignal?.addEventListener('abort', () => resolve());
        });
        // Simulate the orchestrator's behaviour — s1 has a
        // winner, s2 is `kind: 'cancelled'` (not `winner: null` which
        // the page would render as past-window).
        return new Map([
          [
            's1',
            {
              kind: 'result' as const,
              winner: {
                primaryAgeYears: 67,
                secondaryAgeYears: 67,
                metricValue: 0.72,
              },
              partial: false,
              missingPiaMembers: [],
              alreadyAtOptimum: false,
            },
          ],
          ['s2', { kind: 'cancelled' as const }],
        ]);
      });
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      renderPage();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run comparison/i })).toBeDefined();
      });
      await userEvent.click(screen.getByRole('button', { name: /run comparison/i }));
      // Wait for Cancel button to appear (signals the run has started).
      await waitFor(
        () => {
          expect(screen.getByRole('button', { name: /cancel/i })).toBeDefined();
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
      // Assert that abort fired AND the partial accumulator renders s1.
      await waitFor(() => {
        expect(capturedSignal?.aborted).toBe(true);
      });
      await waitFor(
        () => {
          expect(screen.getByText(/72\.0%/)).toBeDefined();
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      // Unprocessed scenarios must NOT render as
      // past-window ("Past claim-age window") and must NOT keep showing
      // "Calculating…" forever — the cancelled outcome routes to the
      // CancelledRow variant which emits em-dashes + "Cancelled".
      expect(screen.queryByText(/past claim-age window/i)).toBeNull();
      expect(screen.getByText(/^Cancelled$/)).toBeDefined();
      expect(screen.queryAllByText(/Calculating…/i).length).toBe(0);
    });

    it('should_disable_apply_on_resolved_rows_while_mc_run_is_in_flight', async () => {
      // Regression: clicking Apply mid-run saved the scenario, which
      // bumped the aggregate revision and aborted the in-flight sweep.
      // The fix disables every Apply while a run is in flight. Resolve
      // s1's row mid-run so its Apply renders, then assert it's disabled
      // until the sweep finishes.
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      // Current 62, recommended 65 → differs → Apply would be ENABLED if
      // the run were not in flight (rules out an alreadyAtOptimum false-pass).
      await seedScenario('s1', 'Base', { primaryAge: 62 });
      let release: () => void = () => undefined;
      const released = new Promise<void>((r) => {
        release = r;
      });
      const winnerOutcome = {
        kind: 'result' as const,
        winner: { primaryAgeYears: 65, secondaryAgeYears: null, metricValue: 0.85 },
        partial: false,
        missingPiaMembers: [],
        alreadyAtOptimum: false,
      };
      setMcRunImpl(async (args) => {
        args.onScenarioResult?.('s1', winnerOutcome);
        await released;
        return new Map([['s1', winnerOutcome]]);
      });
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      renderPage();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run comparison/i })).toBeDefined();
      });
      await userEvent.click(screen.getByRole('button', { name: /run comparison/i }));
      // s1 resolved → an Apply renders, but the run is still in flight
      // (Cancel visible) so every Apply must be disabled.
      await waitFor(
        () => {
          expect(screen.getByRole('button', { name: /cancel/i })).toBeDefined();
          expect(
            screen.getAllByRole('button', { name: 'Save to scenario' }).length,
          ).toBeGreaterThan(0);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      for (const btn of screen.getAllByRole('button', { name: 'Save to scenario' })) {
        expect(btn.hasAttribute('disabled')).toBe(true);
      }
      // Clicking the disabled Apply must not open the confirm dialog
      // (i.e. the sweep is never interrupted by a save).
      await userEvent.click(screen.getAllByRole('button', { name: 'Save to scenario' })[0]);
      expect(screen.queryByRole('alertdialog')).toBeNull();
      // Releasing the run re-enables Apply.
      release();
      await waitFor(
        () => {
          const enabled = screen
            .getAllByRole('button', { name: 'Save to scenario' })
            .filter((b) => !b.hasAttribute('disabled'));
          expect(enabled.length).toBeGreaterThan(0);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
    });
  });

  describe('dual-method deterministic tab (Planned + TWR)', () => {
    afterEach(() => setOptimizerWorkerRunImpl(null));

    it('should_dispatch_worker_twice_per_scenario_one_per_method', async () => {
      // The deterministic tab now posts one message per (scenario,
      // method) tuple — two ScenarioRows × two methods = 4 calls when
      // there are 2 scenarios. Assert via the impl's seen
      // `projectionMethod`.
      const posted: Array<'planned' | 'twr' | undefined> = [];
      setOptimizerWorkerRunImpl(async (runId, input) => {
        posted.push(input.projectionMethod);
        return {
          kind: 'result',
          runId,
          scenarioId: input.scenarioId,
          winner: {
            primaryAgeYears: 67,
            secondaryAgeYears: null,
            metricValue: 1234,
            alreadyAtOptimum: false,
          },
          partial: false,
          missingPiaMembers: [],
        };
      });
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'A');
      await seedScenario('s2', 'B', { isPrimary: false, parentId: 's1' });
      renderPage();
      await waitFor(
        () => {
          expect(posted.length).toBe(4);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      expect(posted.filter((m) => m === 'planned').length).toBe(2);
      expect(posted.filter((m) => m === 'twr').length).toBe(2);
    });

    it('should_render_Ending_Balance_column_header_on_balance_metric', async () => {
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      renderPage();
      await waitFor(
        () => {
          expect(
            screen.getByRole('columnheader', { name: /Ending Balance/ }),
          ).toBeDefined();
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
    });

    it('should_render_grouped_planned_and_twr_child_rows_per_scenario', async () => {
      // Two yearly balances → TWR available. Per-method dispatch
      // resolves both children with the canned winner.
      setOptimizerWorkerRunImpl(async (runId, input) => ({
        kind: 'result',
        runId,
        scenarioId: input.scenarioId,
        winner: {
          primaryAgeYears: 68,
          secondaryAgeYears: null,
          metricValue: 1234,
          alreadyAtOptimum: false,
        },
        partial: false,
        missingPiaMembers: [],
      }));
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      renderPage();
      await waitFor(
        () => {
          // Planned + TWR child-row labels both rendered.
          expect(screen.getByText('Planned')).toBeDefined();
          expect(screen.getByText('Historical')).toBeDefined();
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      // Two Apply buttons (one per method); parent row has the scenario
      // name only.
      const applyButtons = screen.getAllByRole('button', { name: 'Save to scenario' });
      expect(applyButtons.length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('Base')).toBeDefined();
    });

    it('renders the ending-balance current→recommended transition in compact form', async () => {
      // The deterministic MethodChildRow metric cell shows the baseline →
      // recommended ending balance in compact $k/$M form, with no
      // death-age disclosure.
      setOptimizerWorkerRunImpl(async (runId, input) => ({
        kind: 'result',
        runId,
        scenarioId: input.scenarioId,
        winner: {
          primaryAgeYears: 68,
          secondaryAgeYears: null,
          metricValue: 1_300_000,
          alreadyAtOptimum: false,
        },
        partial: false,
        missingPiaMembers: [],
        baselineMetricValue: 1_100_000,
      }));
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      renderPage();
      await waitFor(
        () => {
          // Planned + TWR child rows each render baseline → recommended.
          expect(screen.getAllByText(/\$1\.1M/).length).toBeGreaterThanOrEqual(2);
          expect(screen.getAllByText(/\$1\.3M/).length).toBeGreaterThanOrEqual(2);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      // The death-age disclosure is gone.
      expect(screen.queryByText(/assumes you live to age/i)).toBeNull();
    });

    it('should_render_Insufficient_history_for_twr_when_worker_returns_twr_insufficient', async () => {
      // Worker mock: planned → real winner, twr → 'twr-insufficient'.
      setOptimizerWorkerRunImpl(async (runId, input) => {
        if (input.projectionMethod === 'twr') {
          return {
            kind: 'twr-insufficient',
            runId,
            scenarioId: input.scenarioId,
          };
        }
        return {
          kind: 'result',
          runId,
          scenarioId: input.scenarioId,
          winner: {
            primaryAgeYears: 67,
            secondaryAgeYears: null,
            metricValue: 999,
            alreadyAtOptimum: false,
          },
          partial: false,
          missingPiaMembers: [],
        };
      });
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      renderPage();
      await waitFor(
        () => {
          expect(screen.getByText(/Insufficient history/i)).toBeDefined();
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      // Planned child row still resolves with an Apply button.
      const applyButtons = screen.getAllByRole('button', { name: 'Save to scenario' });
      expect(applyButtons.length).toBe(1);
    });

    it('should_mount_deterministic_progress_bar_with_scenario_X_of_Y_method_label_during_run', async () => {
      // Stall the worker so the live progress bar has time to render.
      let release: () => void = () => undefined;
      const released = new Promise<void>((r) => {
        release = r;
      });
      setOptimizerWorkerRunImpl(async (runId, input) => {
        await released;
        return {
          kind: 'result',
          runId,
          scenarioId: input.scenarioId,
          winner: {
            primaryAgeYears: 67,
            secondaryAgeYears: null,
            metricValue: 1,
            alreadyAtOptimum: false,
          },
          partial: false,
          missingPiaMembers: [],
        };
      });
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      renderPage();
      // Progress bar mounts with aria-label "scenario 1 / 1, method Planned"
      // before any worker reply lands.
      await waitFor(
        () => {
          expect(
            screen.getByRole('progressbar', {
              name: /scenario 1 \/ 1, method Planned/i,
            }),
          ).toBeDefined();
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      release();
    });

    it('should_route_per_method_Apply_through_buildApplyConfirmArgs_with_TWR_winner_ages', async () => {
      // Planned and TWR mocks return distinct winner ages so the
      // confirm dialog's message can be checked against the right one.
      setOptimizerWorkerRunImpl(async (runId, input) => ({
        kind: 'result',
        runId,
        scenarioId: input.scenarioId,
        winner: {
          primaryAgeYears: input.projectionMethod === 'twr' ? 70 : 65,
          secondaryAgeYears: null,
          metricValue: 1,
          alreadyAtOptimum: false,
        },
        partial: false,
        missingPiaMembers: [],
      }));
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      renderPage();
      // Wait for both child rows to land.
      await waitFor(
        () => {
          expect(screen.getByText('Planned')).toBeDefined();
          expect(screen.getByText('Historical')).toBeDefined();
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      // Click the TWR child's Apply (it's the second Apply button).
      const applyButtons = screen
        .getAllByRole('button', { name: 'Save to scenario' })
        .filter((b) => !b.hasAttribute('disabled'));
      expect(applyButtons.length).toBe(2);
      await userEvent.click(applyButtons[1]);
      await waitFor(() => {
        expect(screen.getByRole('alertdialog')).toBeDefined();
      });
      const dialog = screen.getByRole('alertdialog');
      // TWR's winner age was 70 → prompt copy must reference 70.
      expect(within(dialog).getByText(/claim age to 70/)).toBeDefined();
    });

    it('should_disable_method_apply_while_balance_run_is_in_flight', async () => {
      // Planned resolves immediately (its child Apply renders) while TWR
      // stalls, so the deterministic run stays in flight (detRunning) and
      // the Planned Apply must be disabled until the sweep completes.
      let release: () => void = () => undefined;
      const released = new Promise<void>((r) => {
        release = r;
      });
      setOptimizerWorkerRunImpl(async (runId, input) => {
        if (input.projectionMethod === 'twr') await released;
        return {
          kind: 'result',
          runId,
          scenarioId: input.scenarioId,
          winner: {
            primaryAgeYears: 65,
            secondaryAgeYears: null,
            metricValue: 1_000_000,
            alreadyAtOptimum: false,
          },
          partial: false,
          missingPiaMembers: [],
        };
      });
      try {
        await seedMember('m1', true, 'Alex', 1965);
        await seedSsBenefit('m1', 3500);
        await seedAccount();
        // Current 62 vs recommended 65 → not already-at-optimum, so the
        // child Apply is a real "Apply" (not "Applied").
        await seedScenario('s1', 'Base', { primaryAge: 62 });
        renderPage();
        // Planned child resolves → its Apply renders while TWR is pending.
        await waitFor(
          () => {
            expect(screen.getByText('Planned')).toBeDefined();
            expect(
              screen.getAllByRole('button', { name: 'Save to scenario' }).length,
            ).toBeGreaterThan(0);
          },
          { timeout: WAIT_TIMEOUT_MS },
        );
        for (const btn of screen.getAllByRole('button', { name: 'Save to scenario' })) {
          expect(btn.hasAttribute('disabled')).toBe(true);
        }
        // Completing TWR ends the run → Apply re-enables.
        release();
        await waitFor(
          () => {
            const enabled = screen
              .getAllByRole('button', { name: 'Save to scenario' })
              .filter((b) => !b.hasAttribute('disabled'));
            expect(enabled.length).toBeGreaterThan(0);
          },
          { timeout: WAIT_TIMEOUT_MS },
        );
      } finally {
        release();
        setOptimizerWorkerRunImpl(null);
      }
    });
  });

  describe('cross-metric race + unmount cleanup', () => {
    afterEach(() => {
      setOptimizerWorkerRunImpl(null);
      setMcRunImpl(null);
    });

    it('should_drop_stale_deterministic_setRows_when_metric_switches_to_mc_mid_run', async () => {
      // Regression: while the deterministic worker dispatch loop
      // is in flight, the user flips metric balance → mc and clicks
      // Run. The MC path seeds rows via `onRunMc`; the pending
      // deterministic reply must NOT splice a balance result onto the
      // MC-initialised rows. Pre-fix the effect bumped only
      // `mcRunIdRef` on metric → mc, leaving `runIdRef` stale so the
      // deterministic loop's `setRows` ran on top of MC rows.
      let releaseWorker: () => void = () => undefined;
      const released = new Promise<void>((r) => {
        releaseWorker = r;
      });
      // Tag the balance-derived result with a sentinel value the MC
      // mock does not produce so any leak is detectable.
      const BALANCE_SENTINEL = 999_999_999;
      setOptimizerWorkerRunImpl(async (runId, input) => {
        await released;
        return {
          kind: 'result',
          runId,
          scenarioId: input.scenarioId,
          winner: {
            primaryAgeYears: 67,
            secondaryAgeYears: null,
            metricValue: BALANCE_SENTINEL,
            alreadyAtOptimum: false,
          },
          partial: false,
          missingPiaMembers: [],
        };
      });
      // MC mock: emit a winner whose metricValue (× 100) is a
      // distinct, recognisable percent so the page reflects the MC
      // path, not the leaked balance result.
      setMcRunImpl(async () =>
        new Map([
          [
            's1',
            {
              kind: 'result' as const,
              winner: {
                primaryAgeYears: 70,
                secondaryAgeYears: null,
                metricValue: 0.42,
              },
              partial: false,
              missingPiaMembers: [],
              alreadyAtOptimum: false,
            },
          ],
        ]),
      );
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      // Start in balance mode (default) — deterministic dispatch
      // fires immediately and stalls on `released`.
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByRole('radio', { name: /end-of-plan balance/i }),
        ).toBeDefined();
      });
      // Flip metric to mc while the deterministic worker is mid-flight.
      await userEvent.click(screen.getByRole('radio', { name: /plan success/i }));
      // Click Run — `onRunMc` calls `setRows(initial)` and awaits the
      // MC outcome. The MC mock resolves immediately so the page
      // populates 42.0% before we release the deterministic promise.
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run comparison/i })).toBeDefined();
      });
      await userEvent.click(screen.getByRole('button', { name: /run comparison/i }));
      await waitFor(
        () => {
          expect(screen.getByText(/42\.0%/)).toBeDefined();
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      // Now release the deterministic worker reply. Pre-fix this
      // overwrites the MC row with `BALANCE_SENTINEL`; post-fix the
      // bumped `runIdRef` drops the stale write.
      releaseWorker();
      // Drain microtasks so the stale `setRows` (if any) lands.
      await new Promise((r) => setTimeout(r, 50));
      // MC row remains intact; no balance result leaked through.
      expect(screen.getByText(/42\.0%/)).toBeDefined();
      expect(
        screen.queryByText(String(BALANCE_SENTINEL)),
      ).toBeNull();
    });

    it('should_re_enable_mc_apply_after_switching_from_an_in_flight_balance_run', async () => {
      // Regression: flipping Balance → Plan success while
      // the automatic deterministic run is in flight bumps `runIdRef`, so
      // the stale run's guarded `finally` never clears `detRunning`. Since
      // the Apply-disabled prop is `mcRunning || detRunning`, a completed
      // MC row stayed disabled forever. The metric effect must clear
      // `detRunning` when it supersedes a run.
      let releaseDet: () => void = () => undefined;
      const detReleased = new Promise<void>((r) => {
        releaseDet = r;
      });
      // Deterministic worker stalls → the balance run stays in flight
      // (detRunning true) across the metric switch.
      setOptimizerWorkerRunImpl(async (runId, input) => {
        await detReleased;
        return {
          kind: 'result',
          runId,
          scenarioId: input.scenarioId,
          winner: {
            primaryAgeYears: 65,
            secondaryAgeYears: null,
            metricValue: 1,
            alreadyAtOptimum: false,
          },
          partial: false,
          missingPiaMembers: [],
        };
      });
      // MC mock resolves immediately with a winner whose age (65) differs
      // from the current claim age (62) → Apply would be ENABLED but for a
      // stranded detRunning.
      setMcRunImpl(async () =>
        new Map([
          [
            's1',
            {
              kind: 'result' as const,
              winner: {
                primaryAgeYears: 65,
                secondaryAgeYears: null,
                metricValue: 0.85,
              },
              partial: false,
              missingPiaMembers: [],
              alreadyAtOptimum: false,
            },
          ],
        ]),
      );
      try {
        await seedMember('m1', true, 'Alex', 1965);
        await seedSsBenefit('m1', 3500);
        await seedAccount();
        await seedScenario('s1', 'Base', { primaryAge: 62 });
        // Start in balance mode (default) → deterministic run dispatches
        // and stalls; its progress bar mounts (proves detRunning true).
        renderPage();
        await screen.findByRole('progressbar', {
          name: /scenario 1 \/ 1, method Planned/i,
        });
        // Flip to Plan success while the balance run is still in flight.
        await userEvent.click(screen.getByRole('radio', { name: /plan success/i }));
        await waitFor(() => {
          expect(
            screen.getByRole('button', { name: /run comparison/i }),
          ).toBeDefined();
        });
        await userEvent.click(
          screen.getByRole('button', { name: /run comparison/i }),
        );
        // MC finished. detRunning must have been cleared on the switch, so
        // the completed MC row's Apply is ENABLED (not stranded disabled).
        await waitFor(
          () => {
            const enabled = screen
              .getAllByRole('button', { name: 'Save to scenario' })
              .filter((b) => !b.hasAttribute('disabled'));
            expect(enabled.length).toBeGreaterThan(0);
          },
          { timeout: WAIT_TIMEOUT_MS },
        );
      } finally {
        releaseDet();
        setOptimizerWorkerRunImpl(null);
        setMcRunImpl(null);
      }
    });

    it('should_abort_in_flight_mc_run_on_mc_to_balance_toggle_and_leave_Run_reachable_on_return', async () => {
      // Regression: mc→balance toggle mid-MC-run must
      // (i) abort the MC `AbortController` (orchestrator can wind down),
      // (ii) populate deterministic rows after the switch, and
      // (iii) leave `Run comparison` reachable when the user switches
      //      back to MC (no stuck Cancel button).
      let capturedSignal: AbortSignal | undefined;
      setMcRunImpl(async (args) => {
        capturedSignal = args.signal;
        // Hold until aborted, then resolve a result the page would have
        // ignored anyway (run-id bumped on metric switch).
        await new Promise<void>((resolve) => {
          if (capturedSignal?.aborted) {
            resolve();
            return;
          }
          capturedSignal?.addEventListener('abort', () => resolve());
        });
        return new Map([
          [
            's1',
            {
              kind: 'result' as const,
              winner: {
                primaryAgeYears: 70,
                secondaryAgeYears: null,
                metricValue: 0.5,
              },
              partial: false,
              missingPiaMembers: [],
              alreadyAtOptimum: false,
            },
          ],
        ]);
      });
      // Deterministic mock: resolve a recognisable winner so the page
      // can populate after the toggle to balance.
      const BALANCE_SENTINEL = 123_456;
      setOptimizerWorkerRunImpl(async (runId, input) => ({
        kind: 'result',
        runId,
        scenarioId: input.scenarioId,
        winner: {
          primaryAgeYears: 67,
          secondaryAgeYears: null,
          metricValue: BALANCE_SENTINEL,
          alreadyAtOptimum: false,
        },
        partial: false,
        missingPiaMembers: [],
      }));
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      renderPage();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run comparison/i })).toBeDefined();
      });
      // Start MC run.
      await userEvent.click(screen.getByRole('button', { name: /run comparison/i }));
      // Wait for the MC mock to register the signal (Cancel rendered).
      await waitFor(() => {
        expect(capturedSignal).toBeDefined();
      });
      expect(capturedSignal?.aborted).toBe(false);
      // Mid-run: flip metric to balance.
      await userEvent.click(
        screen.getByRole('radio', { name: /end-of-plan balance/i }),
      );
      // (i) MC signal aborted by the metric-switch effect.
      await waitFor(() => {
        expect(capturedSignal?.aborted).toBe(true);
      });
      // (ii) Deterministic rows populate after the toggle. The
      // balance metric routes the winner's `metricValue` through
      // `formatCurrencyShort` → `$123k`. Two child rows (Planned + TWR)
      // both carry the same mocked winner → expect ≥ 1 instance.
      await waitFor(
        () => {
          expect(screen.getAllByText(/\$123k/).length).toBeGreaterThan(0);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      // (iii) Flip back to MC — `Run comparison` reachable (not a
      // stuck Cancel state). Pre-fix the guarded finally left
      // `mcRunning === true` permanently.
      await userEvent.click(
        screen.getByRole('radio', { name: /plan success/i }),
      );
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run comparison/i })).toBeDefined();
      });
      expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
    });

    it('should_restore_balance_cache_on_mc_to_balance_toggle_without_re_dispatching_worker', async () => {
      // Caching: a metric flip with the SAME aggregates reference
      // restores the prior balance rows from cache; the deterministic
      // worker should not be re-invoked.
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      let workerCalls = 0;
      setOptimizerWorkerRunImpl(async (runId, input) => {
        workerCalls += 1;
        return {
          kind: 'result',
          runId,
          scenarioId: input.scenarioId,
          winner: {
            primaryAgeYears: 70,
            secondaryAgeYears: null,
            metricValue: 555,
            alreadyAtOptimum: false,
          },
          partial: false,
          missingPiaMembers: [],
        };
      });
      setMcRunImpl(async () => new Map());
      renderPage();
      // Wait for the deterministic dispatch to populate the table.
      // Two child rows (Planned + TWR) both carry the same mocked
      // winner → expect ≥ 1 instance of the $555 cell.
      await waitFor(
        () => {
          expect(screen.getAllByText('$555').length).toBeGreaterThan(0);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      const callsAfterFirstDispatch = workerCalls;
      expect(callsAfterFirstDispatch).toBeGreaterThan(0);
      // Flip to mc, then back to balance. Same aggregates ref → cache hit.
      await userEvent.click(screen.getByRole('radio', { name: /plan success/i }));
      await userEvent.click(screen.getByRole('radio', { name: /end-of-plan balance/i }));
      // Balance rows render immediately from cache without a new dispatch.
      await waitFor(() => {
        expect(screen.getAllByText('$555').length).toBeGreaterThan(0);
      });
      expect(workerCalls).toBe(callsAfterFirstDispatch);
      setOptimizerWorkerRunImpl(null);
    });

    it('should_invalidate_cache_when_aggregates_reference_changes', async () => {
      // Caching: a real scenario edit (a higher-version putAggregate) fires
      // the per-store fine signal, the page's useAggregates('scenario')
      // revision dep re-fetches, the content signature changes → the row
      // cache is stale + the worker is re-dispatched.
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      let workerCalls = 0;
      setOptimizerWorkerRunImpl(async (runId, input) => {
        workerCalls += 1;
        return {
          kind: 'result',
          runId,
          scenarioId: input.scenarioId,
          winner: {
            primaryAgeYears: 67,
            secondaryAgeYears: null,
            metricValue: 777,
            alreadyAtOptimum: false,
          },
          partial: false,
          missingPiaMembers: [],
        };
      });
      setMcRunImpl(async () => new Map());
      renderPage();
      await waitFor(
        () => {
          expect(screen.getAllByText('$777').length).toBeGreaterThan(0);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      const callsAfterFirstDispatch = workerCalls;
      // External mutation: a real higher-version scenario write fires the
      // scenario store's fine signal → the page re-fetches, the content
      // signature changes (new version), and the row cache is now stale.
      await act(async () => {
        await putAggregate('scenario', {
          id: 's1',
          householdId: HH,
          aggregateType: 'scenario',
          schemaVersion: 1,
          version: 2,
          updatedAt: '2026-05-02T00:00:00Z',
          deviceId: 'dev-1',
          payload: {
            name: 'Base (edited)',
            description: '',
            parentScenarioId: null,
            isPrimary: true,
            notes: '',
            overrides: {
              retirementAge: {
                primary: { ageYears: 67, ageMonths: 0 },
                secondary: { ageYears: 67, ageMonths: 0 },
              },
              inflation: { ratePct: 0 },
              lifeExpectancy: { primary: 95, secondary: 95 },
            },
          },
        });
      });
      await waitFor(() => {
        // Worker re-dispatches because the content signature changed.
        expect(workerCalls).toBeGreaterThan(callsAfterFirstDispatch);
      });
      setOptimizerWorkerRunImpl(null);
    });

    it('should_abort_in_flight_mc_run_on_unmount', async () => {
      // Regression: page-unmount cleanup must abort the MC
      // orchestrator's `AbortController` so the MC worker stops + the
      // final `setRows(...)` doesn't fire on a torn-down component.
      // Pre-fix the cleanup terminated only the deterministic worker.
      let capturedSignal: AbortSignal | undefined;
      setMcRunImpl(async (args) => {
        capturedSignal = args.signal;
        // Stall until aborted; resolve to a result so the promise
        // settles cleanly even if the assertion runs first.
        await new Promise<void>((resolve) => {
          if (capturedSignal?.aborted) {
            resolve();
            return;
          }
          capturedSignal?.addEventListener('abort', () => resolve());
        });
        return new Map();
      });
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      const { unmount } = renderPage();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run comparison/i })).toBeDefined();
      });
      await userEvent.click(screen.getByRole('button', { name: /run comparison/i }));
      // Wait for the MC mock to register the signal AND assert it is still
      // live in the same polled tick. Under parallel load a re-render can
      // re-dispatch the run and abort the first controller before a separate
      // follow-up statement reads it; folding the not-aborted check into the
      // waitFor pins the assertion to the moment the signal first appears.
      await waitFor(() => {
        expect(capturedSignal).toBeDefined();
        expect(capturedSignal?.aborted).toBe(false);
      });
      // Unmount → cleanup hook must abort.
      unmount();
      expect(capturedSignal?.aborted).toBe(true);
    });
  });

  describe('MC path-count selector + page polish', () => {
    afterEach(() => {
      setOptimizerWorkerRunImpl(null);
      setMcRunImpl(null);
      window.localStorage.removeItem(PATH_COUNT_STORAGE_KEY);
      window.localStorage.removeItem(METRIC_STORAGE_KEY);
    });

    it('should_render_path_count_selector_with_three_options_on_mc_tab', async () => {
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByRole('radiogroup', { name: /Monte Carlo path count/i }),
        ).toBeDefined();
      });
      expect(screen.getByRole('radio', { name: /1k scenarios/i })).toBeDefined();
      expect(screen.getByRole('radio', { name: /5k scenarios/i })).toBeDefined();
      expect(screen.getByRole('radio', { name: /10k scenarios/i })).toBeDefined();
    });

    it('should_persist_path_count_to_localStorage_and_pass_to_mc_runner', async () => {
      let capturedPathCount: number | undefined;
      setMcRunImpl(async (args) => {
        capturedPathCount = args.pathCount;
        return new Map();
      });
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      renderPage();
      await waitFor(() => {
        expect(screen.getByRole('radio', { name: /5k scenarios/i })).toBeDefined();
      });
      // Pick 5k → localStorage updates, next Run posts pathCount: 5000.
      await userEvent.click(screen.getByRole('radio', { name: /5k scenarios/i }));
      expect(window.localStorage.getItem(PATH_COUNT_STORAGE_KEY)).toBe('5000');
      await userEvent.click(screen.getByRole('button', { name: /run comparison/i }));
      await waitFor(() => {
        expect(capturedPathCount).toBe(5000);
      });
    });

    it('should_default_path_count_to_1000_when_localStorage_empty', async () => {
      let capturedPathCount: number | undefined;
      setMcRunImpl(async (args) => {
        capturedPathCount = args.pathCount;
        return new Map();
      });
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      renderPage();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run comparison/i })).toBeDefined();
      });
      await userEvent.click(screen.getByRole('button', { name: /run comparison/i }));
      await waitFor(() => {
        expect(capturedPathCount).toBe(1000);
      });
    });

    it('should_NOT_render_the_old_perf_warn_banner_at_any_scenario_count', async () => {
      // The "Heads up: optimization for N scenarios can take a while"
      // banner was removed — the live progress bar is the authoritative
      // run-state signal, and the banner gave no actionable info.
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      // Seed 10 scenarios — pre-removal threshold was 5.
      for (let i = 1; i <= 10; i += 1) {
        await seedScenario(`s${i}`, `Demo scenario ${i}`);
      }
      renderPage();
      await screen.findByRole('note', {
        name: /Social Security claim-age comparison disclaimer/i,
      });
      expect(screen.queryByText(/Heads up/i)).toBeNull();
      expect(
        screen.queryByText(/balance-projection pipeline per candidate/i),
      ).toBeNull();
    });

    it('should_disable_path_count_selector_while_run_in_flight', async () => {
      // Changing pathCount mid-run would mean the cache
      // invalidation races a worker reply still posting under the
      // pre-change value; the selector blocks this by disabling.
      let capturedSignal: AbortSignal | undefined;
      setMcRunImpl(async (args) => {
        capturedSignal = args.signal;
        // Stall forever — the test only inspects the disabled state.
        await new Promise<void>((resolve) => {
          if (capturedSignal?.aborted) {
            resolve();
            return;
          }
          capturedSignal?.addEventListener('abort', () => resolve());
        });
        return new Map();
      });
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      const { unmount } = renderPage();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /run comparison/i })).toBeDefined();
      });
      // Pre-run: selector enabled.
      const groupBefore = screen.getByRole('radiogroup', {
        name: /Monte Carlo path count/i,
      });
      expect(groupBefore.getAttribute('data-disabled')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: /run comparison/i }));
      await waitFor(() => {
        expect(capturedSignal).toBeDefined();
        // React Aria RadioGroup sets data-disabled when isDisabled=true.
        const groupDuring = screen.getByRole('radiogroup', {
          name: /Monte Carlo path count/i,
        });
        expect(groupDuring.getAttribute('data-disabled')).toBe('true');
      });
      // Unmount cleanly aborts the stalled run.
      unmount();
      expect(capturedSignal?.aborted).toBe(true);
    });

    it('should_render_disclaimer_paragraph_at_text_xs_for_fineprint', async () => {
      // Disclaimer is deliberate fineprint (a typography exception)
      // — pinned to text-xs (12px); the page
      // baseline still applies to all other body copy.
      await seedMember('m1', true, 'Alex', 1965);
      await seedAccount();
      await seedScenario('s1', 'Base');
      renderPage();
      const note = await screen.findByRole('note', {
        name: /Social Security claim-age comparison disclaimer/i,
      });
      const paragraph = note.querySelector('p');
      expect(paragraph).not.toBeNull();
      expect(paragraph?.className).toContain('text-xs');
    });

    it('should_render_run_optimization_button_with_toolbar_variant_class', async () => {
      // Proves the standalone toolbar-variant class is in use (not the
      // default role class): the Run comparison button's className
      // contains `text-xs` AND lacks `font-medium`. Tailwind v4's
      // same-specificity source-order cascade means a concatenated
      // `${btnPrimaryClass} ${btnMdClass}` would still render
      // `font-medium` from the role class — this assertion catches a
      // regression to that pattern. See "Buttons and destructive actions" in docs/ui-conventions.md.
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      renderPage();
      const runBtn = await screen.findByRole('button', {
        name: /Run comparison/i,
      });
      expect(runBtn.className).toContain('text-xs');
      expect(runBtn.className).not.toContain('font-medium');
    });

    it('should_render_cancel_button_with_toolbar_variant_class', async () => {
      // Sibling to the Run-button toolbar-variant test — the
      // Cancel button (mcRunning === true branch) uses
      // `btnDangerToolbarClass` and must show the same toolbar-variant
      // signature: className contains `text-xs` AND lacks
      // `font-medium`. Tailwind v4 source-order cascade would let a
      // regression to `${btnDangerClass} ${btnMdClass}` keep
      // `font-medium`, so the negative assertion is load-bearing.
      let capturedSignal: AbortSignal | undefined;
      setMcRunImpl(async (args) => {
        capturedSignal = args.signal;
        // Stall until aborted so the Cancel button renders.
        await new Promise<void>((resolve) => {
          if (capturedSignal?.aborted) {
            resolve();
            return;
          }
          capturedSignal?.addEventListener('abort', () => resolve());
        });
        return new Map();
      });
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      const { unmount } = renderPage();
      await screen.findByRole('button', { name: /Run comparison/i });
      await userEvent.click(
        screen.getByRole('button', { name: /Run comparison/i }),
      );
      const cancelBtn = await screen.findByRole(
        'button',
        { name: /cancel/i },
        { timeout: WAIT_TIMEOUT_MS },
      );
      expect(cancelBtn.className).toContain('text-xs');
      expect(cancelBtn.className).not.toContain('font-medium');
      // Unmount cleanly aborts the stalled run.
      unmount();
      expect(capturedSignal?.aborted).toBe(true);
    });
  });

  // Plan-success current→recommended metric transition.
  describe('plan-success metric transition', () => {
    afterEach(() => {
      setMcRunImpl(null);
      window.localStorage.removeItem(METRIC_STORAGE_KEY);
    });

    async function runWithOutcome(
      outcome: Record<string, unknown>,
    ): Promise<void> {
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      // Current claim age 62 — baseline candidate so the transition shows.
      await seedScenario('s1', 'Base', { primaryAge: 62 });
      setMcRunImpl(async () => new Map([['s1', outcome as never]]));
      window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /run comparison/i }),
        ).toBeDefined();
      });
      await userEvent.click(
        screen.getByRole('button', { name: /run comparison/i }),
      );
    }

    it('renders the baseline→recommended plan-success transition', async () => {
      await runWithOutcome({
        kind: 'result',
        winner: { primaryAgeYears: 70, secondaryAgeYears: null, metricValue: 0.85 },
        partial: false,
        missingPiaMembers: [],
        alreadyAtOptimum: false,
        baselineMetricValue: 0.7,
      });
      await waitFor(
        () => {
          // Baseline (70.0%) → recommended (85.0%) both render.
          expect(screen.getByText(/70\.0%/)).toBeDefined();
          expect(screen.getByText(/85\.0%/)).toBeDefined();
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      // The death-age disclosure is gone.
      expect(screen.queryByText(/assumes you live to age/i)).toBeNull();
    });
  });
});

describe('SsOptimizerPage reactive re-read', () => {
  // The page reads its optimizer inputs via an imperative batch load
  // (`loadOptimizerAggregates`) keyed on the reactive `useAggregates` per-store
  // revision deps (revision-signal substitution). These tests
  // prove a mid-session store write re-fetches without a remount, on BOTH the
  // coarse `WORKSPACE_CHANGED_EVENT` channel and the per-store fine-signal
  // channel a single `putAggregate` fires.
  it('re-reads on WORKSPACE_CHANGED_EVENT without a remount', async () => {
    // Mount against an empty workspace — the "add household members" empty
    // state renders.
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Add household members/i)).toBeDefined();
    });

    // Simulate a bulk fill landing after mount, then the coarse dispatch.
    await seedMember('m1', true, 'Alex', 1965);
    const { notifyWorkspaceChanged } = await import('../lib/workspace-events');
    await act(async () => {
      notifyWorkspaceChanged();
    });

    // Same page instance re-fetched: members now present, so the empty state
    // advances to the no-scenarios copy (no remount, no route change).
    await waitFor(() => {
      expect(
        screen.getByText(/No scenarios yet. Create one on the Scenarios page./i),
      ).toBeDefined();
    });
    expect(screen.queryByText(/Add household members/i)).toBeNull();
  });

  it('re-reads on a fine-signal store write without a coarse event', async () => {
    // Mount against an empty workspace — the "add household members" empty
    // state renders.
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Add household members/i)).toBeDefined();
    });

    // A single `putAggregate('householdMember', …)` emits ONLY the per-store
    // fine signal (no `notifyWorkspaceChanged()`). The page's
    // `useAggregates('householdMember')` revision dep must still re-fetch.
    await act(async () => {
      await seedMember('m1', true, 'Alex', 1965);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/No scenarios yet. Create one on the Scenarios page./i),
      ).toBeDefined();
    });
    expect(screen.queryByText(/Add household members/i)).toBeNull();
  });

  it('does_not_re_run_the_optimizer_when_a_re_read_yields_an_identical_signature', async () => {
    // The `reload` bail-early guard (signature === ref) must drop a
    // no-op re-read so a store write that does NOT change any id/version
    // never restarts the worker dispatch. Count worker dispatches: seed a
    // runnable workspace (default balance metric → deterministic dispatch),
    // let the first run settle, then re-`putAggregate` the SAME scenario
    // (identical id + version + payload). The per-store fine signal still
    // fires the effect + `loadOptimizerAggregates`, but the matching
    // signature must short-circuit before `setAggregates`, so NO additional
    // worker dispatch fires.
    let dispatchCount = 0;
    setOptimizerWorkerRunImpl(async (runId, input) => {
      dispatchCount += 1;
      return {
        kind: 'result',
        runId,
        scenarioId: input.scenarioId,
        winner: {
          primaryAgeYears: 67,
          secondaryAgeYears: null,
          metricValue: 1_000_000,
          alreadyAtOptimum: false,
        },
        partial: false,
        missingPiaMembers: [],
      };
    });
    try {
      await seedMember('m1', true, 'Alex', 1965);
      await seedSsBenefit('m1', 3500);
      await seedAccount();
      await seedScenario('s1', 'Base');
      renderPage();
      // First run dispatches both deterministic methods (Planned + TWR).
      await waitFor(
        () => {
          expect(dispatchCount).toBe(2);
        },
        { timeout: 10_000 },
      );
      const afterFirstRun = dispatchCount;

      // Re-write the identical scenario (same id + version + payload). This
      // fires the `scenario` store's fine signal → the effect re-runs and
      // calls `loadOptimizerAggregates`, but the signature is unchanged.
      await act(async () => {
        await seedScenario('s1', 'Base');
      });
      // Give the bailed-out reload + any (incorrect) re-dispatch a chance to
      // land, then assert the dispatch count never moved.
      await new Promise((r) => setTimeout(r, 50));
      expect(dispatchCount).toBe(afterFirstRun);
    } finally {
      setOptimizerWorkerRunImpl(null);
    }
  });
});

describe('SsOptimizerPage — month-level claim ages', () => {
  const STORED_SS = {
    primary: { ageYears: 66, ageMonths: 4 },
    secondary: { ageYears: 67, ageMonths: 0 },
  };

  async function seedHousehold(): Promise<void> {
    await seedMember('m1', true, 'Alex', 1965);
    await seedMember('m2', false, 'Sam', 1968);
    await seedSsBenefit('m1', 3500);
    await seedSsBenefit('m2', 2800);
    await seedAccount();
  }

  async function seedWithOverrides(
    id: string,
    name: string,
    socialSecurity: ScenarioPayload['overrides']['socialSecurity'],
    parentId: string | null = null,
  ): Promise<void> {
    await putAggregate('scenario', {
      id,
      householdId: HH,
      aggregateType: 'scenario',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-05-01T00:00:00Z',
      deviceId: 'dev-1',
      payload: {
        name,
        description: '',
        parentScenarioId: parentId,
        isPrimary: parentId === null,
        notes: '',
        overrides: {
          ...(socialSecurity ? { socialSecurity } : {}),
          retirementAge: {
            primary: { ageYears: 67, ageMonths: 0 },
            secondary: { ageYears: 67, ageMonths: 0 },
          },
          inflation: { ratePct: 0 },
          lifeExpectancy: { primary: 95, secondary: 95 },
        },
      },
    });
  }

  /** Drive the Monte Carlo tab with a fixed outcome per scenario. The
   *  engine flag is false on purpose: the page must derive "Already set"
   *  live from the current vs recommended age, months included. */
  async function runMc(
    outcomes: Record<
      string,
      | { winner: { primaryAgeYears: number; primaryAgeMonths?: number; secondaryAgeYears: number; metricValue: number } }
      | 'empty'
    >,
  ): Promise<void> {
    setMcRunImpl(async () =>
      new Map(
        Object.entries(outcomes).map(([id, o]) => [
          id,
          o === 'empty'
            ? { kind: 'empty' as const, reason: 'no-retirement-date' as const }
            : {
                kind: 'result' as const,
                winner: o.winner,
                partial: false,
                missingPiaMembers: [],
                alreadyAtOptimum: false,
                baselineMetricValue: 0.8,
              },
        ]),
      ),
    );
    window.localStorage.setItem(METRIC_STORAGE_KEY, 'mc');
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /run comparison/i })).toBeDefined();
    });
    await userEvent.click(screen.getByRole('button', { name: /run comparison/i }));
  }

  async function openSaveDialog(): Promise<HTMLElement> {
    await waitFor(
      () => {
        expect(
          screen
            .getAllByRole('button', { name: 'Save to scenario' })
            .some((b) => !b.hasAttribute('disabled')),
        ).toBe(true);
      },
      { timeout: WAIT_TIMEOUT_MS },
    );
    const btn = screen
      .getAllByRole('button', { name: 'Save to scenario' })
      .find((b) => !b.hasAttribute('disabled'));
    if (!btn) throw new Error('No enabled Save button');
    await userEvent.click(btn);
    return await screen.findByRole('alertdialog');
  }

  const savedSs = (): ScenarioPayload['overrides']['socialSecurity'] =>
    (
      (saveScenario as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        payload: ScenarioPayload;
      }
    ).payload.overrides.socialSecurity;

  it('should_say_the_result_compares_a_fixed_set_at_one_assumed_death_age_not_advice', async () => {
    await seedHousehold();
    await seedWithOverrides('s1', 'Base', STORED_SS);
    const { container } = renderPage();
    const note = await screen.findByRole('note', {
      name: /Social Security claim-age comparison disclaimer/i,
    });
    expect(note.textContent ?? '').toMatch(
      /fixed set of options.*assumed death\s+age, the scenario's Life expectancy setting.*not a proven best age\s+and not advice/s,
    );
    expect(note.textContent ?? '').toMatch(/does not tell you when to claim/i);
    expect(note.textContent ?? '').toMatch(/divorced-spouse benefits/i);
    const subtitle =
      container.querySelector('[data-testid="page-header-title-wrap"]')?.textContent ?? '';
    expect(subtitle).toContain("one assumed death age, the scenario's Life expectancy setting");
    expect(subtitle).toContain('not a proven best age');
    expect(subtitle).not.toContain('each eligible whole-year Social Security claim age');
  });

  it('should_read_Already_set_with_the_stored_age_in_years_and_months_when_it_ranks_highest', async () => {
    await seedHousehold();
    await seedWithOverrides('s1', 'Base', STORED_SS);
    await runMc({
      s1: {
        winner: { primaryAgeYears: 66, primaryAgeMonths: 4, secondaryAgeYears: 67, metricValue: 0.8 },
      },
    });
    const already = await screen.findByRole(
      'button',
      { name: 'Already set' },
      { timeout: WAIT_TIMEOUT_MS },
    );
    expect(already.hasAttribute('disabled')).toBe(true);
    const cells = within(already.closest('tr') as HTMLElement)
      .getAllByRole('gridcell')
      .map((c) => c.textContent);
    expect(cells).toContain('66 years 4 months');
    expect(cells).toContain('67');
    expect(screen.queryByText('→')).toBeNull();
  });

  it('should_tell_the_user_the_stored_months_are_replaced_only_for_the_member_that_changes', async () => {
    await seedHousehold();
    await seedWithOverrides('s1', 'Base', STORED_SS);
    await runMc({
      s1: { winner: { primaryAgeYears: 70, secondaryAgeYears: 67, metricValue: 0.9 } },
    });
    const dialog = await openSaveDialog();
    const text = dialog.textContent ?? '';
    expect(text).toContain(
      "The months in Alex's current claim age (66 years 4 months) are replaced.",
    );
    expect(text).toContain('Sam is already set to 67, keeping their current setting');
    expect(text).not.toContain("The months in Sam's");
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveScenario).toHaveBeenCalled());
    expect(savedSs()).toMatchObject({
      primary: { ageYears: 70, ageMonths: 0 },
      secondary: { ageYears: 67, ageMonths: 0 },
    });
  });

  it('should_keep_a_carried_through_member_months_and_the_inherited_settings_on_a_child_scenario', async () => {
    await seedHousehold();
    const inherited = {
      ...STORED_SS,
      benefitReductionPct: 10,
      colaPct: 2,
      colaTracksInflation: true,
      survivor: { primary: { ageYears: 65, ageMonths: 3 } },
    };
    await seedWithOverrides('parent', 'Parent', inherited);
    await seedWithOverrides('child', 'Child', undefined, 'parent');
    await runMc({
      parent: 'empty',
      child: { winner: { primaryAgeYears: 66, primaryAgeMonths: 4, secondaryAgeYears: 68, metricValue: 0.9 } },
    });
    const dialog = await openSaveDialog();
    const text = dialog.textContent ?? '';
    expect(text).toContain(
      "Set Sam's claim age to 68 in scenario 'Child'? (Alex is already set to 66 years 4 months, keeping their current setting.)",
    );
    expect(text).not.toContain('are replaced');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveScenario).toHaveBeenCalled());
    expect(savedSs()).toEqual({
      primary: { ageYears: 66, ageMonths: 4 },
      secondary: { ageYears: 68, ageMonths: 0 },
      benefitReductionPct: 10,
      colaPct: 2,
      colaTracksInflation: true,
      survivor: { primary: { ageYears: 65, ageMonths: 3 } },
    });
  });

  it('should_show_the_stored_month_level_age_as_the_baseline_on_the_balance_tab_child_rows', async () => {
    setOptimizerWorkerRunImpl(async (runId, input) => ({
      kind: 'result',
      runId,
      scenarioId: input.scenarioId,
      winner: {
        primaryAgeYears: 70,
        secondaryAgeYears: 67,
        metricValue: 1_200_000,
        alreadyAtOptimum: false,
      },
      partial: false,
      missingPiaMembers: [],
      baselineMetricValue: 1_000_000,
    }));
    try {
      await seedHousehold();
      await seedWithOverrides('s1', 'Base', STORED_SS);
      renderPage();
      await waitFor(
        () => {
          expect(screen.getAllByText('66 years 4 months').length).toBeGreaterThan(0);
          expect(screen.getAllByText('→').length).toBeGreaterThan(0);
        },
        { timeout: WAIT_TIMEOUT_MS },
      );
      expect(screen.queryByRole('button', { name: 'Already set' })).toBeNull();
    } finally {
      setOptimizerWorkerRunImpl(null);
    }
  });
});
