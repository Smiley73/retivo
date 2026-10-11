/**
 * Preferences view (Settings → Preferences). Route shell + card layout only.
 * Holds the Appearance theme picker and the Beta features switch; the
 * security/account and data/workspace cards moved to the Security and
 * Workspace pages. The route path stays `/profile` for back-compat; the nav
 * label and page heading read "Preferences".
 */
import React, { useId } from 'react';
import { useAuth } from '../auth/AuthContext';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { useTheme } from '../contexts/ThemeContext';
import { useBetaFeatures } from '../contexts/BetaFeaturesContext';
import { Card } from '../components/Card';
import { Muted } from '../components/Muted';
import { PageHeader } from '../components/PageHeader';
import { CardPair, SettingsCard } from './profile-page-chrome';

// Theme-picker glyphs for the Appearance SegmentedRadioGroup (mock
// `.seg button svg` sun / moon / monitor, 14px, currentColor so they
// inherit the option's ink — accent-ink when checked). Decorative: the
// SegmentedRadioGroup renders them aria-hidden, so each option's
// accessible name stays its label ("Light" / "Dark" / "System").
const themeIconClass = 'size-3.5';

const SunIcon = () => (
  <svg className={themeIconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);

const MoonIcon = () => (
  <svg className={themeIconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const MonitorIcon = () => (
  <svg className={themeIconClass} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

/**
 * The Beta features card: the "Show beta features" switch plus a plain
 * disclaimer about what beta means. Renders nothing when this build offers no
 * beta features (the config list is `none`) — a switch that controls nothing
 * would only confuse.
 */
const BetaFeaturesCard: React.FC = () => {
  const { showBetaFeatures, setShowBetaFeatures, offeredBetaFeatures } = useBetaFeatures();
  const disclaimerId = useId();
  if (offeredBetaFeatures.length === 0) return null;
  return (
    <SettingsCard
      title="Beta features"
      subtitle="Try features that are still being finished."
    >
      <ToggleSwitch
        id="show-beta-features"
        label="Show beta features"
        checked={showBetaFeatures}
        onChange={setShowBetaFeatures}
        ariaDescribedBy={disclaimerId}
      />
      <Muted as="p" id={disclaimerId} className="m-0 mt-3 text-xs">
        Beta features are still being tested. They may not work perfectly, may
        change, or may be removed again.
      </Muted>
    </SettingsCard>
  );
};

export const PreferencesPage: React.FC = () => {
  const { me } = useAuth();
  const { theme, setTheme } = useTheme();

  if (!me) return null;

  return (
    <section aria-labelledby="preferences-heading">
      <PageHeader
        title={<span id="preferences-heading">Preferences</span>}
        subtitle="How the app looks and behaves."
      />


      <CardPair>
        <Card>
          <h2 className="m-0 mb-2 text-lg font-semibold text-ink">
            Appearance
          </h2>
          <p className="m-0 mb-4 text-xs text-muted">
            Choose your preferred theme.
          </p>
          {/* Mock `.seg` icon-segmented theme picker (replaces the prior
              <Select> dropdown). The "Appearance" card title is the label,
              so the group's accessible name rides `ariaLabel="Theme"`.
              Wired to useTheme() — selecting an option persists identically
              to the dropdown (setTheme → localStorage, no behavior change). */}
          <SegmentedRadioGroup
            ariaLabel="Theme"
            size="sm"
            value={theme}
            onChange={(v) => setTheme(v as 'light' | 'dark' | 'system')}
            options={[
              { value: 'light', label: 'Light', icon: <SunIcon /> },
              { value: 'dark', label: 'Dark', icon: <MoonIcon /> },
              { value: 'system', label: 'System', icon: <MonitorIcon /> },
            ]}
          />
        </Card>
        <BetaFeaturesCard />
      </CardPair>
    </section>
  );
};
