/**
 * Route gate for a beta feature's page. Renders the page only while the
 * feature is visible (offered by this build AND switched on by the user —
 * see `lib/feature-flags.ts`); otherwise a short notice explains why the page
 * is not showing and where to turn it on. The sidebar already hides the entry,
 * so this is the deep-link / bookmark path.
 */
import React from 'react';
import { useBetaFeatures } from '../contexts/BetaFeaturesContext';
import { betaFeature, type BetaFeatureId } from '../lib/feature-flags';
import { EmptyState } from './EmptyState';
import { PageHeader } from './PageHeader';
import { TextLink } from './TextLink';

interface BetaFeatureGateProps {
  feature: BetaFeatureId;
  children: React.ReactNode;
}

export const BetaFeatureGate: React.FC<BetaFeatureGateProps> = ({ feature, children }) => {
  const { isBetaFeatureVisible, isBetaFeatureOffered } = useBetaFeatures();
  if (isBetaFeatureVisible(feature)) return <>{children}</>;

  const offered = isBetaFeatureOffered(feature);
  // The registry label is the page title above the notice, so the gated URL
  // still says where you are (and a rename can't drift between the two).
  const title = betaFeature(feature).label;
  return (
    <section aria-labelledby="beta-gate-heading">
      <PageHeader title={<span id="beta-gate-heading">{title}</span>} />
      <EmptyState
        action={
          offered ? (
            <TextLink to="/profile">Go to Preferences</TextLink>
          ) : (
            <TextLink to="/dashboard">Go to dashboard</TextLink>
          )
        }
      >
        {offered
          ? 'This is a beta feature. Turn on "Show beta features" under Settings → Preferences to use it.'
          : 'This feature is not available in this version of the app.'}
      </EmptyState>
    </section>
  );
};
