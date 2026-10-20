/**
 * AcaCoverageCard + AcaCoverageModal — unit tests.
 *
 * The health-coverage editor is a STANDALONE card + modal in the Withdrawals &
 * taxes group. Covers: card summary (on-Marketplace / other-coverage split);
 * modal lists ALL household members; per-member toggle persists
 * `acaMarketplaceOptOutMemberIds`; sparse omit when empty; gross-premium +
 * benchmark disclosure copy; Save disabled when clean; a11y smoke (card +
 * modal). It also covers the monthly health controls: the poverty-guideline region,
 * the per-member/per-year Part B / Part D / Marketplace months, the annual
 * benchmark-price override round trip, and the opted-out-member edge (no
 * prefilled Marketplace months).
 */
import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AcaCoverageCard,
  AcaCoverageModal,
} from './ScenarioWithdrawalStrategyCards';
import { clearAllStores, listPendingMutations } from '../db/store';
import { expectNoA11yViolations } from '../test/a11y';
import type {
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import { ROUGH_BENCHMARK_ASSUMPTIONS } from '../lib/aca-ptc';

const HH = 'hh-test';

function makeScenario(
  id: string,
  overrides: ScenarioPayload['overrides'] = {},
  isPrimary = false,
): ScenarioAggregate {
  return {
    id,
    householdId: HH,
    aggregateType: 'scenario',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-05-01T00:00:00Z',
    deviceId: 'dev-1',
    payload: {
      name: id,
      description: '',
      parentScenarioId: null,
      isPrimary,
      notes: '',
      overrides,
    },
  };
}

function makeMember(id: string, firstName: string, isPrimary = false): Aggregate<HouseholdMemberPayload> {
  return {
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
      lastName: 'Test',
      birthdate: '1962-01-01',
    } as HouseholdMemberPayload,
  };
}

const JOHN = makeMember('m-john', 'John', true);
const JANE = makeMember('m-jane', 'Jane');
const MEMBERS = [JOHN, JANE];

beforeEach(async () => {
  await clearAllStores();
});
afterEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
});

describe('AcaCoverageCard', () => {
  it('summarizes everyone on the Marketplace by default', () => {
    const scenario = makeScenario('sc-card');
    render(
      <AcaCoverageCard
        scenario={scenario}
        scenarios={[scenario]}
        members={MEMBERS}
        onConfigure={vi.fn()}
      />,
    );
    expect(screen.getByText(/On Marketplace: John, Jane/)).toBeInTheDocument();
  });

  it('splits on-Marketplace vs other-coverage when a member is opted out', () => {
    const scenario = makeScenario('sc-card2', {
      acaMarketplaceOptOutMemberIds: ['m-jane'],
    });
    render(
      <AcaCoverageCard
        scenario={scenario}
        scenarios={[scenario]}
        members={MEMBERS}
        onConfigure={vi.fn()}
      />,
    );
    expect(screen.getByText(/On Marketplace: John · Other coverage: Jane/)).toBeInTheDocument();
  });

  it('summarizes the region, the coverage years set, and the benchmark prices entered', () => {
    const scenario = makeScenario('sc-card3', {
      acaFplRegion: 'hawaii',
      healthCoverageMonths: {
        perMember: {
          'm-john': { 2030: { partBMonths: 7 }, 2031: { partBMonths: 12 } },
          'm-jane': { 2032: { marketplaceMonths: 6 } },
        },
      },
      acaPtcBenchmark: [{ taxYear: 2030, annualSlcspDollars: 9_600 }],
    });
    render(
      <AcaCoverageCard
        scenario={scenario}
        scenarios={[scenario]}
        members={MEMBERS}
        onConfigure={vi.fn()}
      />,
    );
    expect(screen.getByText(/Hawaii poverty guidelines/)).toBeInTheDocument();
    expect(screen.getByText(/3 coverage years set/)).toBeInTheDocument();
    expect(screen.getByText(/1 benchmark price entered/)).toBeInTheDocument();
  });

  it('says nothing extra when only the defaults apply', () => {
    const scenario = makeScenario('sc-card4', { acaFplRegion: 'contiguous' });
    render(
      <AcaCoverageCard
        scenario={scenario}
        scenarios={[scenario]}
        members={MEMBERS}
        onConfigure={vi.fn()}
      />,
    );
    // The mainland guidelines are the default, so the card stays quiet about
    // them; no coverage years and no benchmark prices are mentioned either.
    expect(screen.getByText('On Marketplace: John, Jane')).toBeInTheDocument();
    expect(screen.queryByText(/poverty guidelines/)).toBeNull();
    expect(screen.queryByText(/coverage year/)).toBeNull();
    expect(screen.queryByText(/benchmark price/)).toBeNull();
  });
});

describe('AcaCoverageModal', () => {
  it('lists ALL household members with an on-Marketplace toggle each', async () => {
    const scenario = makeScenario('sc-list');
    render(
      <MemoryRouter>
        <AcaCoverageModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          members={MEMBERS}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByRole('switch', { name: /John is on the ACA Marketplace/i })).toBeChecked();
    expect(screen.getByRole('switch', { name: /Jane is on the ACA Marketplace/i })).toBeChecked();
  });

  it('shows the gross-premium + benchmark disclosure copy', async () => {
    const scenario = makeScenario('sc-copy');
    render(
      <MemoryRouter>
        <AcaCoverageModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          members={MEMBERS}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(
      screen.getByText(/enter the FULL \(unsubsidized\) premium as your Medical/i),
    ).toBeInTheDocument();
    // Each covered person is priced at their OWN age for the months they
    // are covered, replacing the oldest-member anchor the copy used to describe.
    expect(
      screen.getByText(/priced at their own age, for the months they are\s+covered/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/anchored to your oldest member/i)).toBeNull();
  });

  it('persists the opt-out set when a member is toggled to other coverage', async () => {
    const scenario = makeScenario('sc-save');
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <AcaCoverageModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          members={MEMBERS}
          onClose={onClose}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    // Toggle Jane OFF the Marketplace (→ other coverage / opted out).
    await userEvent.click(screen.getByRole('switch', { name: /Jane is on the ACA Marketplace/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const pending = await listPendingMutations();
    const payload = pending.find((p) => p.aggregateId === 'sc-save')!
      .payload as ScenarioPayload;
    expect(payload.overrides.acaMarketplaceOptOutMemberIds).toEqual(['m-jane']);
  });

  it('omits the key (sparse) when the opt-out is cleared back to empty', async () => {
    const scenario = makeScenario('sc-sparse', {
      acaMarketplaceOptOutMemberIds: ['m-jane'],
    });
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <AcaCoverageModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          members={MEMBERS}
          onClose={onClose}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    // Jane starts OFF the Marketplace (opted out); toggle her back ON → empty set.
    const janeToggle = screen.getByRole('switch', { name: /Jane is on the ACA Marketplace/i });
    expect(janeToggle).not.toBeChecked();
    await userEvent.click(janeToggle);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));

    const pending = await listPendingMutations();
    const payload = pending.find((p) => p.aggregateId === 'sc-sparse')!
      .payload as ScenarioPayload;
    // The key is still WRITTEN (it had a local override) but as an empty array —
    // the sparse rule keeps a pre-existing local key while clearing its content.
    expect(payload.overrides.acaMarketplaceOptOutMemberIds).toEqual([]);
  });

  it('disables Save when nothing changed', async () => {
    const scenario = makeScenario('sc-clean');
    render(
      <MemoryRouter>
        <AcaCoverageModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          members={MEMBERS}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('AcaCoverageModal — health facts', () => {
  /** Open the modal for a scenario and wait for the dialog. */
  async function openModal(
    id: string,
    overrides: ScenarioPayload['overrides'] = {},
    onClose = vi.fn(),
  ): Promise<{ scenario: ScenarioAggregate; onClose: ReturnType<typeof vi.fn> }> {
    const scenario = makeScenario(id, overrides);
    render(
      <MemoryRouter>
        <AcaCoverageModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          members={MEMBERS}
          onClose={onClose}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    return { scenario, onClose };
  }

  /** Save and read back the queued scenario payload. */
  async function saveAndRead(id: string, onClose: ReturnType<typeof vi.fn>): Promise<ScenarioPayload> {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    const pending = await listPendingMutations();
    return pending.find((p) => p.aggregateId === id)!.payload as ScenarioPayload;
  }

  it('discloses the rough benchmark assumptions the estimate is built from', async () => {
    await openModal('sc-p13-copy');
    expect(screen.getByText(/\$700 a month for a 60-year-old/i)).toBeInTheDocument();
    expect(screen.getByText(/rising\s+5% for each year of age/i)).toBeInTheDocument();
    expect(screen.getByText(/rough estimate, not a real quote/i)).toBeInTheDocument();
    // The estimate grows every year from its base year at the scenario's medical
    // rate, and an entered price is used exactly as entered.
    expect(
      screen.getByText(
        new RegExp(
          `From ${ROUGH_BENCHMARK_ASSUMPTIONS.baseYear}, the estimate grows every year at the scenario.s medical inflation rate`,
          'i',
        ),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/used exactly as entered, whatever the medical inflation rate/i),
    ).toBeInTheDocument();
  });

  it('seeds the poverty-guideline region and the stored coverage months', async () => {
    await openModal('sc-p13-seed', {
      acaFplRegion: 'alaska',
      healthCoverageMonths: {
        perMember: { 'm-john': { 2030: { partBMonths: 7, partDMonths: 0, marketplaceMonths: 5 } } },
      },
    });
    expect(screen.getByLabelText(/Where you live/i)).toHaveTextContent(/Alaska/);
    expect(screen.getByLabelText(/Months on Medicare Part B/i)).toHaveTextContent(/7 months/);
    expect(screen.getByLabelText(/Months on Medicare Part D/i)).toHaveTextContent(/0 months/);
    expect(screen.getByLabelText(/Months on a Marketplace plan/i)).toHaveTextContent(/5 months/);
  });

  it('shows the automatic-timing empty state when no coverage year is entered', async () => {
    await openModal('sc-p13-empty');
    expect(
      screen.getByText(/No years entered — the projection uses its own timing/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No prices entered — the rough estimate above is used/i),
    ).toBeInTheDocument();
  });

  it('shows ZERO prefilled Marketplace months for an opted-out member (no stored months)', async () => {
    // Precedence edge: an opt-out with no stated months must NOT prefill a
    // 12-month row — the member simply has no coverage-month row at all, so the
    // engine keeps resolving them to zero Marketplace months.
    await openModal('sc-p13-optout', { acaMarketplaceOptOutMemberIds: ['m-jane'] });
    expect(screen.queryByLabelText(/Months on a Marketplace plan/i)).toBeNull();
    expect(
      screen.getByRole('switch', { name: /Jane is on the ACA Marketplace/i }),
    ).not.toBeChecked();
  });

  it('round-trips a benchmark override through Save', async () => {
    const { onClose } = await openModal('sc-p13-benchmark', {
      acaPtcBenchmark: [{ taxYear: 2031, annualSlcspDollars: 9_600 }],
    });
    const amount = screen.getByLabelText(/Benchmark plan cost for the year/i);
    expect(amount).toHaveValue('9600');
    await userEvent.clear(amount);
    await userEvent.type(amount, '10200');
    const payload = await saveAndRead('sc-p13-benchmark', onClose);
    expect(payload.overrides.acaPtcBenchmark).toEqual([
      { taxYear: 2031, annualSlcspDollars: 10_200 },
    ]);
  });

  it('persists a changed poverty-guideline region and leaves the other keys sparse', async () => {
    const { onClose } = await openModal('sc-p13-region');
    await userEvent.click(screen.getByLabelText(/Where you live/i));
    await userEvent.click(await screen.findByRole('option', { name: /Hawaii/i }));
    const payload = await saveAndRead('sc-p13-region', onClose);
    expect(payload.overrides.acaFplRegion).toBe('hawaii');
    expect('healthCoverageMonths' in payload.overrides).toBe(false);
    expect('acaPtcBenchmark' in payload.overrides).toBe(false);
  });

  it('blocks Save on a coverage year that states no month at all', async () => {
    await openModal('sc-p13-prune');
    await userEvent.click(screen.getByRole('button', { name: /Add a coverage year/i }));
    // Every month stays on "Automatic" → the row carries no user intent. The
    // save path would drop it (no stored default is invented), so
    // blocking is what stops the row vanishing without explanation.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(
      screen.getByText(/coverage row does not state any months yet/i),
    ).toBeInTheDocument();
  });

  it('re-enables Save once the empty coverage row states a month', async () => {
    const { onClose } = await openModal('sc-p13-unblock');
    await userEvent.click(screen.getByRole('button', { name: /Add a coverage year/i }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/Months on Medicare Part B/i));
    await userEvent.click(await screen.findByRole('option', { name: '6 months' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    const payload = await saveAndRead('sc-p13-unblock', onClose);
    expect(payload.overrides.healthCoverageMonths).toEqual({
      perMember: { 'm-john': { [new Date().getFullYear()]: { partBMonths: 6 } } },
    });
  });

  it('blocks Save on a benchmark price left at $0', async () => {
    await openModal('sc-p13-zero-price');
    await userEvent.click(screen.getByRole('button', { name: /Add a benchmark price/i }));
    // A stored $0 reads as an explicit "this year's benchmark is zero", which
    // would silently delete the subsidy for that year.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(
      screen.getByText(/benchmark price needs an amount above \$0/i),
    ).toBeInTheDocument();
  });

  it('saves stated Part B months independently of Part D', async () => {
    const { onClose } = await openModal('sc-p13-months', {
      healthCoverageMonths: {
        perMember: { 'm-john': { 2030: { partBMonths: 12 } } },
      },
    });
    await userEvent.click(screen.getByLabelText(/Months on Medicare Part D/i));
    await userEvent.click(await screen.findByRole('option', { name: '4 months' }));
    const payload = await saveAndRead('sc-p13-months', onClose);
    expect(payload.overrides.healthCoverageMonths).toEqual({
      perMember: { 'm-john': { 2030: { partBMonths: 12, partDMonths: 4 } } },
    });
  });

  it('passes expectNoA11yViolations with every health control populated', async () => {
    const scenario = makeScenario('sc-p13-a11y', {
      acaFplRegion: 'hawaii',
      healthCoverageMonths: {
        perMember: { 'm-john': { 2030: { partBMonths: 7, marketplaceMonths: 5 } } },
      },
      acaPtcBenchmark: [{ taxYear: 2030, annualSlcspDollars: 9_600 }],
    });
    const { container } = render(
      <MemoryRouter>
        <AcaCoverageModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          members={MEMBERS}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await expectNoA11yViolations(container);
  });
});

describe('ACA coverage — a11y smoke', () => {
  it('card passes expectNoA11yViolations', async () => {
    const scenario = makeScenario('sc-a11y-card');
    const { container } = render(
      <AcaCoverageCard
        scenario={scenario}
        scenarios={[scenario]}
        members={MEMBERS}
        onConfigure={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });

  it('modal passes expectNoA11yViolations', async () => {
    const scenario = makeScenario('sc-a11y-modal');
    const { container } = render(
      <MemoryRouter>
        <AcaCoverageModal
          open
          scenario={scenario}
          scenarios={[scenario]}
          householdId={HH}
          members={MEMBERS}
          onClose={vi.fn()}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await expectNoA11yViolations(container);
  });
});
