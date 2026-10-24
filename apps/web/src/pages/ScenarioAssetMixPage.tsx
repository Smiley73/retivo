/** Per-scenario per-account asset-mix overrides, mirroring ScenarioReturnsPage: an "override?" toggle and stocks / bonds / cash percent inputs per account, with first-ancestor-wins baseline resolution through the parent chain. */
import React, { useEffect, useMemo, useState } from 'react';
import { textLinkClass } from '../components/TextLink';
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { getAggregate, listAggregates } from '../db/store';
import type {
  AccountPayload,
  Aggregate,
  AssetMix,
  ScenarioPayload,
} from '../db/types';
import { ASSET_MIX_SUM_TOLERANCE } from '../db/types';
import { queueLocalMutation } from '../sync/mutation-queue';
import { resolveAccountAssetMixForScenario } from '../lib/scenario-resolution';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { formatPercent, PercentInput } from '../components/PercentInput';
import { PageHeader } from '../components/PageHeader';
import { LoadingState } from '../components/Skeleton';
import { TableScroll } from '../components/TableScroll';
import {
  btnPrimarySmClass,
  btnSecondarySmClass,
  tableClass,
  thStickyClass,
  thStickyNumClass,
  tdClass,
  tdNumClass,
  breadcrumbNavClass,
} from './scenarios-page-chrome';

interface DraftRow {
  accountId: string;
  name: string;
  override: boolean;
  stocks: number;
  bonds: number;
  cash: number;
  inherited: AssetMix;
}

function sumOk(stocks: number, bonds: number, cash: number): boolean {
  return Math.abs(stocks + bonds + cash - 100) <= ASSET_MIX_SUM_TOLERANCE;
}

export function ScenarioAssetMixPage() {
  const { id: scenarioId } = useParams<{ id: string }>();
  const { householdId } = useAuth();
  const [scenario, setScenario] = useState<Aggregate<ScenarioPayload> | null>(null);
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!scenarioId || !householdId) return;
    (async () => {
      const sc = (await getAggregate('scenario', scenarioId)) as Aggregate<ScenarioPayload> | null;
      if (!sc) return;
      setScenario(sc);
      const allScenarios = (await listAggregates('scenario')) as Aggregate<ScenarioPayload>[];
      const accounts = (await listAggregates('account')) as Aggregate<AccountPayload>[];
      const activeAccounts = accounts.filter(
        (a) => a.payload.active && a.payload.type !== 'RETIREMENT_CASH_BALANCE',
      );
      const inheritedMap = resolveAccountAssetMixForScenario(
        scenarioId,
        allScenarios,
        activeAccounts,
      );
      const own = sc.payload.overrides.accountAssetMix?.perAccount ?? {};
      setRows(
        activeAccounts.map((a) => {
          const ownEntry = own[a.id];
          const inherited = inheritedMap.get(a.id) ?? a.payload.assetMix;
          const seed = ownEntry ?? inherited;
          return {
            accountId: a.id,
            name: a.payload.name,
            override: Boolean(ownEntry),
            stocks: seed.stocksPct,
            bonds: seed.bondsPct,
            cash: seed.cashPct,
            inherited,
          };
        }),
      );
    })();
  }, [scenarioId, householdId]);

  const anyInvalid = useMemo(() => {
    return rows.some(
      (r) => r.override && !sumOk(r.stocks, r.bonds, r.cash),
    );
  }, [rows]);

  if (!scenarioId || !scenario) {
    return <LoadingState label="Loading asset mix…" variant="rows" />;
  }

  const handleSave = async () => {
    if (!householdId || anyInvalid) return;
    setSaving(true);
    try {
      const overrides = { ...scenario.payload.overrides };
      const perAccount: Record<string, AssetMix> = {};
      for (const r of rows) {
        if (r.override) {
          perAccount[r.accountId] = {
            stocksPct: r.stocks,
            bondsPct: r.bonds,
            cashPct: r.cash,
          };
        }
      }
      if (Object.keys(perAccount).length === 0) {
        delete overrides.accountAssetMix;
      } else {
        overrides.accountAssetMix = { perAccount };
      }
      await queueLocalMutation<ScenarioPayload>({
        type: 'scenario',
        aggregateId: scenarioId,
        householdId,
        operation: 'update',
        expectedVersion: scenario.version,
        payload: { ...scenario.payload, overrides },
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Breadcrumb" className={breadcrumbNavClass}>
        <Link to={`/scenarios/${scenarioId}`}>← Back to scenario</Link>
      </nav>
      <PageHeader
        title="Asset-mix overrides"
        subtitle={
          <>
            Scenario:{' '}
            <Link
              to={`/scenarios/${scenarioId}`}
              className={textLinkClass}
            >
              {scenario.payload.name}
            </Link>
            . Set a different stocks / bonds / cash split for an account in this
            scenario. Each override replaces the account's usual mix when the
            projection tests how your savings hold up against market ups and
            downs.
          </>
        }
      />

      <TableScroll label="Per-account asset mix">
        <Table className={tableClass} aria-label="Per-account asset mix">
          <TableHeader>
            <Column isRowHeader className={thStickyClass}>Account</Column>
            <Column className={thStickyClass}>Override?</Column>
            <Column className={thStickyNumClass}>Stocks %</Column>
            <Column className={thStickyNumClass}>Bonds %</Column>
            <Column className={thStickyNumClass}>Cash %</Column>
            <Column className={thStickyNumClass}>Sum</Column>
            <Column className={thStickyNumClass}>Inherited</Column>
          </TableHeader>
          <TableBody>
            {rows.map((r, idx) => {
              const sum = r.stocks + r.bonds + r.cash;
              const valid = sumOk(r.stocks, r.bonds, r.cash);
              return (
                <Row key={r.accountId} id={r.accountId}>
                  <Cell className={tdClass}>{r.name}</Cell>
                  <Cell className={tdClass}>
                    <ToggleSwitch
                      ariaLabel={`Override asset mix for ${r.name}`}
                      checked={r.override}
                      onChange={(v) => {
                        setRows((prev) => {
                          const next = [...prev];
                          next[idx] = { ...next[idx], override: v };
                          return next;
                        });
                      }}
                    />
                  </Cell>
                  {(['stocks', 'bonds', 'cash'] as const).map((k) => (
                    <Cell className={tdNumClass} key={k}>
                      <PercentInput
                        variant="cell"
                        ariaLabel={`${r.name} ${k}`}
                        value={r[k]}
                        disabled={!r.override}
                        onChange={(v) => {
                          setRows((prev) => {
                            const next = [...prev];
                            next[idx] = { ...next[idx], [k]: v };
                            return next;
                          });
                        }}
                      />
                    </Cell>
                  ))}
                  <Cell
                    className={`${tdNumClass} ${
                      r.override && !valid
                        ? 'text-negative'
                        : 'text-muted'
                    }`}
                  >
                    {formatPercent(sum)}
                    {r.override && !valid && ' (≠ 100)'}
                  </Cell>
                  <Cell className={`${tdNumClass} text-muted`}>
                    {r.inherited.stocksPct.toFixed(0)}/
                    {r.inherited.bondsPct.toFixed(0)}/
                    {r.inherited.cashPct.toFixed(0)}
                  </Cell>
                </Row>
              );
            })}
          </TableBody>
        </Table>
      </TableScroll>

      <div className="flex gap-2">
        <button
          type="button"
          className={btnPrimarySmClass}
          disabled={anyInvalid || saving}
          onClick={handleSave}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <Link
          to={`/scenarios/${scenarioId}`}
          className={btnSecondarySmClass}
        >
          Cancel
        </Link>
      </div>
    </div>
  );
}
