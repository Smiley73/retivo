/**
 * Workspace settings view (Settings → Workspace). Route shell + card layout
 * only; each settings card is its own component (see the `*Card` siblings in
 * this directory). The page owns the top-of-page error notice slot and the
 * paired-card grid; behavior lives in the cards.
 *
 * Hosts the data + workspace cards: the Data card (export / import / restore)
 * and the Workspace tools card (load demo / reload / clear / delete workspace).
 * Credential + account cards live on the Security page.
 */
import React, { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Alert } from '../components/Alert';
import { PageHeader } from '../components/PageHeader';
import { CardPair } from './profile-page-chrome';
import { DataCard } from './DataCard';
import { WorkspaceToolsCard } from './WorkspaceToolsCard';
import { DiagnosticsCard } from './DiagnosticsCard';

export const WorkspacePage: React.FC = () => {
  const { me, householdId } = useAuth();

  // Top-of-page error notice, surfaced by the Data card's flows. Kept on the
  // page so it renders above the card rows.
  const [error, setError] = useState<string | null>(null);

  if (!me) return null;

  const email = me.email ?? '';

  return (
    <section aria-labelledby="workspace-heading">
      <PageHeader
        title={<span id="workspace-heading">Workspace</span>}
        subtitle="Export, import, and manage your workspace data."
      />


      {error && <Alert tone="error">{error}</Alert>}

      <CardPair>
        <DataCard householdId={householdId} email={email} onError={setError} />

        <WorkspaceToolsCard
          householdId={householdId}
          email={email}
          me={{ email: me.email, displayName: me.displayName || me.email }}
        />
      </CardPair>

      {/* Second row: the Diagnostics card mounts in the left column;
          the right column is intentionally empty for now. */}
      <CardPair>
        <DiagnosticsCard householdId={householdId} email={email} />
      </CardPair>
    </section>
  );
};
