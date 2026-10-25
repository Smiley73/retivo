/**
 * Route gate rendering a beta feature's page only while it is offered by this build and switched on; otherwise a
 * notice says where to turn it on (the deep-link path, since the sidebar hides the entry).
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
