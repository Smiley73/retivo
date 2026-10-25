/** Workspace settings view: route shell and card layout (Data, Workspace tools, Diagnostics). It owns the top-of-page error slot and the paired-card grid; behavior lives in the cards. */
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

      <CardPair>
        <DiagnosticsCard householdId={householdId} email={email} />
      </CardPair>
    </section>
  );
};
