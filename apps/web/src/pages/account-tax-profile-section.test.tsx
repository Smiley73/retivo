/**
 * Advanced account-tax disclosure: progressive questions, inference provenance,
 * inherited blockers, and representative accessibility coverage.
 */
import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  AccountBalancePayload,
  AccountPayload,
  AccountTaxTreatment,
  AccountType,
  Aggregate,
} from '../db/types';
import { EMPTY_TAX_PROFILE_DRAFT, type TaxProfileDraft } from '../lib/account-tax-profile';
import { expectNoA11yViolations } from '../test/a11y';
import { AccountTaxProfileSection } from './account-tax-profile-section';

function balance(
  year: number,
  over: Partial<AccountBalancePayload> = {},
): Aggregate<AccountBalancePayload> {
  return {
    id: `bal-a-${year}`,
    householdId: 'h1',
    aggregateType: 'accountBalance',
    schemaVersion: 1,
    version: 1,
    updatedAt: `${year}-12-31T00:00:00.000Z`,
    deviceId: 'dev-1',
    payload: {
      accountId: 'a',
      year,
      lastUpdated: `${year}-12-31T00:00:00.000Z`,
      startingBalance: 0,
      startingBalancePreTax: null,
      startingBalancePostTax: null,
      contributionsPreTax: null,
      contributionsPostTax: null,
      companyContributions: 0,
      companyContributionsPreTax: null,
      companyContributionsPostTax: null,
      rollover: 0,
      distributions: 0,
      endingBalance: 0,
      endingBalancePreTax: null,
      endingBalancePostTax: null,
      totalContributions: 0,
      comment: null,
      ...over,
    },
  };
}

interface ControlledProps {
  readonly type?: AccountType;
  readonly taxTreatment?: AccountTaxTreatment;
  readonly initialDraft?: TaxProfileDraft;
  readonly balances?: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly accounts?: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly hasSpouse?: boolean;
  readonly ownerBirthdate?: string;
  readonly spouseBirthdate?: string;
  readonly hasValidationError?: boolean;
}

function Controlled({
  type = 'RETIREMENT_401K',
  taxTreatment = 'MIXED',
  initialDraft = EMPTY_TAX_PROFILE_DRAFT,
  balances = [],
  accounts = [],
  hasSpouse = false,
  ownerBirthdate,
  spouseBirthdate,
  hasValidationError,
}: ControlledProps): React.ReactElement {
  const [draft, setDraft] = useState(initialDraft);
  return (
    <AccountTaxProfileSection
      accountId="a"
      type={type}
      taxTreatment={taxTreatment}
      draft={draft}
      balances={balances}
      accounts={accounts}
      ownerId="owner"
      hasSpouse={hasSpouse}
      ownerBirthdate={ownerBirthdate}
      spouseBirthdate={spouseBirthdate}
      hasValidationError={hasValidationError}
      onChange={setDraft}
    />
  );
}

describe('AccountTaxProfileSection', () => {
  it('does not render for an account without Roth or RMD details', () => {
    render(<Controlled type="BROKERAGE" taxTreatment="POST_TAX" />);
    expect(screen.queryByRole('button', { name: 'Advanced tax details' })).toBeNull();
  });

  it('starts collapsed with a specific inferred summary and offers a manual override', () => {
    render(<Controlled balances={[balance(2018, { endingBalancePostTax: 4_000 })]} />);
    expect(screen.getByText(/Roth start: 2018 from balances/)).toBeInTheDocument();
    expect(screen.getByText('2018 — inferred from balance history')).not.toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    expect(screen.getByText('2018 — inferred from balance history')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: /Enter a different year.*Year Roth contributions to this plan began/,
      }),
    );
    expect(screen.getByLabelText('Year Roth contributions to this plan began')).toBeInTheDocument();
  });

  it('states no basis default in the closed summary or the intro, only the start-year one', () => {
    // Both basis totals are derived from recorded balance history now, so the
    // section makes no claim about a blank one. The start-year default is the
    // one cautious assumption left, and it stays stated.
    render(
      <Controlled
        balances={[
          balance(2018, {
            rothInPlanRolloverTaxableAmount: 7_000,
            rothInPlanRolloverNontaxableAmount: 3_000,
          }),
        ]}
      />,
    );
    expect(screen.getByText(/Roth start: 2018 from balances/)).toBeInTheDocument();
    expect(screen.queryByText(/basis floor from known rollovers/)).toBeNull();
    expect(screen.queryByText(/regular-contribution basis/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    expect(screen.queryByText(/treated as \$0/)).toBeNull();
    expect(screen.queryByText(/supplies the basis floor/)).toBeNull();
    expect(
      screen.getByText(/A blank Roth start year uses qualifying balance history/),
    ).toBeInTheDocument();
  });

  // The four removed money labels, across every account shape that used to show
  // one. Rewritten from the assertions that pinned their presence: the point is
  // that no account type renders a Roth basis input any more, while the year
  // editor beside it is untouched.
  it.each([
    { label: 'a Roth IRA', type: 'RETIREMENT_ROTH_IRA' as const, taxTreatment: 'ROTH' as const, inherited: false },
    { label: 'an inherited Roth IRA', type: 'RETIREMENT_ROTH_IRA' as const, taxTreatment: 'ROTH' as const, inherited: true },
    { label: 'a pure designated-Roth plan', type: 'RETIREMENT_ROTH_401K' as const, taxTreatment: 'ROTH' as const, inherited: false },
    { label: 'a MIXED employer plan', type: 'RETIREMENT_401K' as const, taxTreatment: 'MIXED' as const, inherited: false },
  ])('asks for no Roth basis amount on $label', ({ type, taxTreatment, inherited }) => {
    render(
      <Controlled
        type={type}
        taxTreatment={taxTreatment}
        initialDraft={{ ...EMPTY_TAX_PROFILE_DRAFT, rmdInheritedAccount: inherited }}
        ownerBirthdate="1960-01-01"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    expect(screen.queryByLabelText('Total contributions made so far')).toBeNull();
    expect(screen.queryByLabelText("Original owner's total contributions")).toBeNull();
    expect(screen.queryByLabelText('Roth contributions in this plan')).toBeNull();
    // The paired year editor still renders (its derived-value line + override).
    const yearLabel =
      type === 'RETIREMENT_ROTH_IRA'
        ? inherited
          ? /Year the original owner first contributed to a Roth IRA/
          : /Year of your first Roth IRA contribution/
        : /Year Roth contributions to this plan began/;
    expect(
      screen.getByRole('button', { name: new RegExp(`Enter a year.*${yearLabel.source}`) }),
    ).toBeInTheDocument();
  });

  it('still saves a year typed into the surviving Roth-IRA year editor', () => {
    render(<Controlled type="RETIREMENT_ROTH_IRA" taxTreatment="ROTH" />);
    fireEvent.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: /Enter a year.*Year of your first Roth IRA contribution/,
      }),
    );
    const field = screen.getByLabelText('Year of your first Roth IRA contribution');
    fireEvent.change(field, { target: { value: '2015' } });
    expect(
      screen.getByLabelText('Year of your first Roth IRA contribution'),
    ).toHaveValue('2015');
  });

  it("shows the effective start year from another Roth IRA in the owner's pool", () => {
    const older: Aggregate<AccountPayload> = {
      id: 'older',
      householdId: 'h1',
      aggregateType: 'account',
      schemaVersion: 1,
      version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      deviceId: 'dev-1',
      payload: {
        name: 'Older Roth IRA',
        type: 'RETIREMENT_ROTH_IRA',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'ROTH',
        ownerId: 'owner',
        institution: '',
        notes: '',
        planningReturnPct: 6,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
        rothIraFirstContributionTaxYear: 2010,
      },
    };
    render(
      <Controlled
        type="RETIREMENT_ROTH_IRA"
        taxTreatment="ROTH"
        accounts={[older]}
      />,
    );
    expect(screen.getByText(/Roth start: 2010 from your Roth IRA pool/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    expect(screen.getByText('2010 — from another Roth IRA you own')).toBeInTheDocument();
  });

  it('hides owner RMD options for a POST_TAX TSP but retains inherited setup', () => {
    render(<Controlled type="RETIREMENT_TSP" taxTreatment="POST_TAX" />);
    fireEvent.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    expect(screen.getByRole('switch', { name: 'I inherited this account' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /current employer/i })).toBeNull();
    expect(screen.queryByRole('switch', { name: /Postpone my first required/i })).toBeNull();
  });

  it('reveals employer-plan follow-up questions only after current employer is enabled', () => {
    render(<Controlled type="RETIREMENT_401K" taxTreatment="PRE_TAX" />);
    fireEvent.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    expect(screen.queryByLabelText('Do I own more than 5% of this employer?')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: "This is my current employer's plan" }));
    expect(screen.getByLabelText('Do I own more than 5% of this employer?')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Does the plan require withdrawals at the statutory age anyway?'),
    ).toBeInTheDocument();
  });

  it('hides every owner-RMD option for a fully Roth account but retains inherited setup', () => {
    render(<Controlled type="RETIREMENT_ROTH_401K" taxTreatment="ROTH" />);
    fireEvent.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    expect(screen.getByRole('switch', { name: 'I inherited this account' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /current employer/i })).toBeNull();
    expect(screen.queryByRole('switch', { name: /Postpone my first required/i })).toBeNull();
    expect(screen.queryByRole('switch', { name: /only beneficiary/i })).toBeNull();
  });

  it('hides the spouse option without a spouse and explains why an unproved option is disabled', () => {
    const { rerender } = render(
      <Controlled type="RETIREMENT_IRA" taxTreatment="PRE_TAX" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    expect(screen.queryByRole('switch', { name: /only beneficiary/i })).toBeNull();

    rerender(
      <Controlled
        type="RETIREMENT_IRA"
        taxTreatment="PRE_TAX"
        hasSpouse
        ownerBirthdate="1960-01-01"
      />,
    );
    const spouseSwitch = screen.getByRole('switch', { name: /only beneficiary/i });
    expect(spouseSwitch).toBeDisabled();
    expect(spouseSwitch).toHaveAttribute(
      'aria-describedby',
      'rmdSoleSpouseBeneficiary-help',
    );
    expect(screen.getByText(/Add both dates of birth in Household/)).toBeInTheDocument();
  });

  it('enables the joint-life election only when household dates prove a gap over ten years', () => {
    render(
      <Controlled
        type="RETIREMENT_IRA"
        taxTreatment="PRE_TAX"
        hasSpouse
        ownerBirthdate="1960-01-01"
        spouseBirthdate="1971-01-02"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    expect(screen.getByRole('switch', { name: /only beneficiary/i })).toBeEnabled();
  });

  it('forces inherited blockers open and lists every missing fact', () => {
    render(
      <Controlled
        type="RETIREMENT_IRA"
        taxTreatment="PRE_TAX"
        initialDraft={{ ...EMPTY_TAX_PROFILE_DRAFT, rmdInheritedAccount: true }}
      />,
    );
    expect(
      screen.getByText(
        'This account cannot be saved while any of these inherited-account issues apply:',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Advanced tax details' })).toBeDisabled();
    expect(screen.getByText('Who inherited this account')).toBeInTheDocument();
    expect(screen.getByText("The original owner's date of death")).toBeInTheDocument();
  });

  // No on-screen string may characterise an inherited Roth IRA's five-year
  // clock: neither engine consults one, so wording that says the clock is
  // "treated as unmet" describes a treatment no code applies. This is a
  // factual-accuracy fix to descriptive copy, NOT a change to what is collected — the date
  // FIELD itself is asserted unchanged in the next test.
  it('never characterises an inherited Roth IRA’s five-year clock', () => {
    render(
      <Controlled
        type="RETIREMENT_ROTH_IRA"
        taxTreatment="ROTH"
        initialDraft={{ ...EMPTY_TAX_PROFILE_DRAFT, rmdInheritedAccount: true }}
        ownerBirthdate="1960-01-01"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    // The five surfaces that used to describe a five-year clock on this account:
    // the closed summary, the derived-value line, the field hint, the section
    // intro, and the conversion-recording note (hidden here because an inherited
    // Roth IRA can no longer receive conversions and no clock is tracked for it).
    expect(screen.queryByText(/five-year rule/i)).toBeNull();
    expect(screen.queryByText(/treated as unmet/i)).toBeNull();
    expect(screen.queryByText(/five-year clock/i)).toBeNull();
    expect(screen.getByText(/Roth start: not recorded/)).toBeInTheDocument();
  });

  // The inherited basis hint used to be the one place that
  // still described a basis ordering. Both the field and its hint are gone: the
  // intro says only that an inherited Roth IRA's withdrawals are fully tax-free,
  // and names no basis figure at all.
  it('makes no basis claim of any kind on an inherited Roth IRA', () => {
    render(
      <Controlled
        type="RETIREMENT_ROTH_IRA"
        taxTreatment="ROTH"
        initialDraft={{ ...EMPTY_TAX_PROFILE_DRAFT, rmdInheritedAccount: true }}
        ownerBirthdate="1960-01-01"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    expect(screen.queryByText(/come out tax- and penalty-free first/i)).toBeNull();
    expect(screen.queryByText(/recorded for reference only/i)).toBeNull();
    expect(screen.queryByText(/basis/i)).toBeNull();
    expect(
      screen.getByText(/Withdrawals from an inherited Roth IRA are assumed fully tax-free/),
    ).toBeInTheDocument();
  });

  it('keeps the five-year wording on a NON-inherited Roth IRA (positive contrast)', () => {
    render(<Controlled type="RETIREMENT_ROTH_IRA" taxTreatment="ROTH" />);
    fireEvent.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    expect(screen.getAllByText(/five-year rule/i).length).toBeGreaterThan(0);
    // The conversion-recording note (and its per-conversion-year clock wording)
    // still renders when the account is NOT inherited.
    expect(screen.getByText(/Each conversion year has its own five-year clock/)).toBeInTheDocument();
  });

  // The date field itself is untouched on an inherited Roth IRA: still
  // labelled, still editable, still stored.
  it('still collects the first-contribution year on an inherited Roth IRA', () => {
    render(
      <Controlled
        type="RETIREMENT_ROTH_IRA"
        taxTreatment="ROTH"
        initialDraft={{ ...EMPTY_TAX_PROFILE_DRAFT, rmdInheritedAccount: true }}
        ownerBirthdate="1960-01-01"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Advanced tax details' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: /Enter a year.*Year the original owner first contributed to a Roth IRA/,
      }),
    );
    const field = screen.getByLabelText(
      'Year the original owner first contributed to a Roth IRA',
    );
    fireEvent.change(field, { target: { value: '2015' } });
    expect(
      screen.getByLabelText('Year the original owner first contributed to a Roth IRA'),
    ).toHaveValue('2015');
  });

  it('opens on an internal validation error and has no representative a11y violations', async () => {
    const { container } = render(
      <Controlled
        type="RETIREMENT_ROTH_IRA"
        taxTreatment="ROTH"
        hasValidationError
      />,
    );
    expect(
      screen.getByRole('button', {
        name: /Enter a year.*Year of your first Roth IRA contribution/,
      }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Advanced tax details' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expectNoA11yViolations(container);
  });
});
