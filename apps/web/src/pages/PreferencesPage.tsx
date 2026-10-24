/** Preferences view (Settings → Preferences): route shell and card layout with the Appearance theme picker, the Beta features switch and, when the build offers it, the AI assistants card. The route path stays /profile for back-compat. */
import React, { useId } from 'react';
import { useAuth } from '../auth/AuthContext';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import { ToggleSwitch } from '../components/ToggleSwitch';
import { useTheme } from '../contexts/ThemeContext';
import { useBetaFeatures } from '../contexts/BetaFeaturesContext';
import { useAssistant } from '../assistant/AssistantContext';
import { Card } from '../components/Card';
import { Muted } from '../components/Muted';
import { PageHeader } from '../components/PageHeader';
import { AssistantSettingsCard } from './AssistantSettingsCard';
import { CardPair, SettingsCard } from './profile-page-chrome';

// Decorative theme-picker glyphs: SegmentedRadioGroup renders them aria-hidden, so each option's accessible name stays its label.
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

// The "Show beta features" switch; renders nothing when the build offers no beta features, since a switch that controls nothing would only confuse.
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
  const { offered: assistantOffered } = useAssistant();

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
          {/* The card title is the label, so the group's accessible name rides ariaLabel="Theme". */}
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
      {assistantOffered && (
        <div className="mb-6 [&>*]:mb-0">
          <AssistantSettingsCard />
        </div>
      )}
    </section>
  );
};
