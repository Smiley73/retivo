// Left navigation sidebar with collapsible sections (React Aria `Disclosure`: keyboard-operable, announced; WCAG 2.2 AA).
// `aria-current="page"` comes from each item's `matchWhen` (some routes belong to an entry that isn't a path prefix).
import React from 'react';
import {
  Button,
  Disclosure,
  DisclosurePanel,
  Heading,
} from 'react-aria-components';
import { matchPath, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useBetaFeatures } from '../contexts/BetaFeaturesContext';
import type { BetaFeatureId } from '../lib/feature-flags';
import { SyncBadge } from '../sync/SyncBadge';
import { AssistantSessionBadge } from '../components/AssistantSessionBadge';
import { Badge } from '../components/Badge';
import { BrandMark } from '../components/BrandMark';
import { SidebarScenarioPicker } from '../components/SidebarScenarioPicker';
import { RepoLink } from '../components/RepoLink';
import { APP_NAME } from '../lib/brand';
import {
  ChevronIcon,
  DashboardIcon,
  ProfileIcon,
  HouseholdIcon,
  AssetsIcon,
  BalancesIcon,
  ScenariosIcon,
  SocialSecurityIcon,
  PiggyBankIcon,
  ProjectionIcon,
  ReceiptIcon,
  BanknoteIcon,
  TagIcon,
  TargetIcon,
  WrenchIcon,
  ShieldIcon,
  ReportIcon,
  SparklesIcon,
} from './sidebar-icons';

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  // Patterns counting as "selected" for routes that belong to an entry which isn't a prefix of `to` (e.g.
  // /accounts/:id/balances belongs to "Account Balances"); default: pathname === to.
  matchWhen?: string[];
  // Beta feature: hidden unless visible, badged "Beta" when shown.
  betaFeature?: BetaFeatureId;
}

interface NavSection {
  id: string;
  label: string;
  /** Whether the section is open by default on first render. */
  defaultOpen: boolean;
  items: NavItem[];
}

// Top-level link above the collapsible sections: Dashboard is every session's home view, pinned so it stays one click
// away.
const TOP_LEVEL_ITEM: NavItem = {
  to: '/dashboard',
  label: 'Dashboard',
  icon: <DashboardIcon />,
};

const SECTIONS: NavSection[] = [
  {
    id: 'planning',
    label: 'Planning',
    defaultOpen: true,
    items: [
      { to: '/balance-projection', label: 'Projections', icon: <ProjectionIcon /> },
      {
        to: '/scenarios',
        label: 'Scenarios',
        icon: <ScenariosIcon />,
        // The detail page and its /scenarios/:id/* sub-screens keep the entry active.
        matchWhen: [
          '/scenarios',
          '/scenarios/:id',
          '/scenarios/:id/expenses',
          '/scenarios/:id/income',
          '/scenarios/:id/contributions',
          '/scenarios/:id/returns',
          '/scenarios/:id/inflation',
          '/scenarios/:id/asset-mix',
          '/scenarios/:id/withdrawal-strategy',
          '/scenarios/:id/roth-conversions',
          '/scenarios/:id/qcd',
          '/scenarios/:id/floors',
        ],
      },
      {
        to: '/optimizer',
        label: 'Social Security claim-age',
        icon: <TargetIcon />,
        matchWhen: ['/optimizer', '/optimizer/*'],
      },
      {
        to: '/roth-optimizer',
        label: 'Roth conversion comparison',
        icon: <TargetIcon />,
        matchWhen: ['/roth-optimizer'],
      },
      {
        to: '/withdrawal-guidance',
        label: 'Projected withdrawals',
        icon: <BanknoteIcon />,
        betaFeature: 'projected-withdrawals',
      },
      {
        to: '/report',
        label: 'Report',
        icon: <ReportIcon />,
      },
      {
        to: '/guardrails',
        label: 'Guardrails today',
        icon: <ShieldIcon />,
        betaFeature: 'guardrails',
      },
    ],
  },
  {
    id: 'your-data',
    label: 'Your Data',
    defaultOpen: false,
    items: [
      { to: '/household', label: 'Household', icon: <HouseholdIcon /> },
      {
        to: '/accounts',
        label: 'Accounts',
        icon: <AssetsIcon />,
        // /accounts/:id/balances belongs to "Account Balances" below; the create/edit form is a modal on /accounts
        // (?new / ?edit).
        matchWhen: ['/accounts'],
      },
      {
        to: '/account-balances',
        label: 'Account Balances',
        icon: <BalancesIcon />,
        matchWhen: ['/account-balances', '/accounts/:id/balances'],
      },
      { to: '/account-contributions', label: 'Annual Contributions', icon: <PiggyBankIcon /> },
      {
        to: '/income',
        label: 'Income',
        icon: <BanknoteIcon />,
        matchWhen: ['/income', '/income/new', '/income/:id/edit', '/income/scenario-entry'],
      },
      {
        to: '/expenses',
        label: 'Expenses',
        icon: <ReceiptIcon />,
        matchWhen: ['/expenses', '/expenses/new', '/expenses/:id/edit', '/expenses/scenario-entry'],
      },
      {
        to: '/expense-categories',
        label: 'Expense Categories',
        icon: <TagIcon />,
      },
      { to: '/social-security', label: 'Social Security', icon: <SocialSecurityIcon /> },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    defaultOpen: false,
    items: [
      { to: '/profile', label: 'Preferences', icon: <ProfileIcon /> },
      { to: '/security', label: 'Security', icon: <ShieldIcon /> },
      { to: '/workspace', label: 'Workspace', icon: <WrenchIcon /> },
    ],
  },
  {
    id: 'help-info',
    label: 'Help & Info',
    defaultOpen: false,
    items: [
      { to: '/whats-new', label: "What's New", icon: <SparklesIcon /> },
    ],
  },
];

interface SidebarProps {
  onItemClick: () => void;
  onSignOut: () => void;
  /**
   * Rendered inside the React Aria `<MobileNavDrawer>` (mobile), which owns positioning and the navigation landmark
   * (the Dialog's `aria-label`): the `<aside>` drops its fixed/sticky classes and duplicate landmark label and just
   * fills the drawer. Desktop renders the static column, hidden below `lg`.
   */
  drawer?: boolean;
}

function isItemActive(item: NavItem, pathname: string): boolean {
  if (item.matchWhen) {
    return item.matchWhen.some((pattern) => matchPath({ path: pattern, end: true }, pathname) !== null);
  }
  return pathname === item.to;
}

// Expanded when flagged `defaultOpen` or holding the active route, so a deep link into a collapsed section (e.g.
// /security under Settings) still shows where the user is.
function isSectionDefaultExpanded(section: NavSection, pathname: string): boolean {
  return section.defaultOpen || section.items.some((item) => isItemActive(item, pathname));
}

// A nav row is a <button>, not <Link>, so the browser never shows the full URL in the status bar on hover. Active is
// the accent wash with the accent-link ink (the registered pair for accent link on a card surface; the bright lime
// accent is a fill, too light as text); idle is ink text with a sunken hover. Dark mode rides the `.dark` variable
// swap.
const NAV_ITEM_BASE =
  'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm ' +
  'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring';
const NAV_ITEM_IDLE = 'text-ink hover:bg-surface-sunken';
// Accent-link green on the wash is the registered "active-nav text on accent wash" pair (5.36:1), repointed from
// text-positive, which read muddy green-on-green once the wash turned green.
const NAV_ITEM_ACTIVE = 'bg-accent-subtle font-semibold text-accent-link';

function navItemClass(active: boolean): string {
  return `${NAV_ITEM_BASE} ${active ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE}`;
}

export const Sidebar: React.FC<SidebarProps> = ({
  onItemClick,
  onSignOut,
  drawer = false,
}) => {
  const { me } = useAuth();
  const { isBetaFeatureVisible } = useBetaFeatures();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  // Beta items drop out while their feature is hidden; BetaFeatureGate covers a deep link to the hidden page.
  const isItemShown = (item: NavItem): boolean =>
    item.betaFeature === undefined || isBetaFeatureVisible(item.betaFeature);

  // Beta items sort after every stable item in their section (a stable sort, so nothing else reorders), so a new beta
  // feature lands at the bottom without placing it by hand.
  const byBetaLast = (a: NavItem, b: NavItem): number =>
    Number(a.betaFeature !== undefined) - Number(b.betaFeature !== undefined);

  // Entries are <button>s so the URL isn't exposed on hover; navigation stays programmatic. Tradeoff: middle-click and
  // cmd-click "Open in new tab" don't work from the sidebar.
  const goTo = (to: string): void => {
    onItemClick();
    navigate(to);
  };

  return (
    <aside
      className={
        drawer
          ? // In the React Aria MobileNavDrawer overlay (it owns position, scrim and focus trap): just fill the panel.
            // `overflow-hidden`, not `overflow-y-auto`, so only the inner scroll region scrolls and the footer stays
            // pinned.
            'flex h-full flex-col border-r ' +
            'border-line bg-surface-raised p-3'
          : // Desktop: sticky full-height fixed-width column in the shell's flex row; `lg:shrink-0` keeps `w-64` from collapsing next to the fluid main.
            // Hidden below `lg` (the drawer is the mobile presentation); only the middle region scrolls, so the footer
            // (account, Sign out) stays in view.
            'hidden h-screen w-64 flex-col overflow-hidden border-r ' +
            'border-line bg-surface-raised p-3 lg:sticky lg:top-0 lg:flex ' +
            'lg:shrink-0'
      }
      aria-label={drawer ? undefined : 'Primary navigation'}
    >
      <div
        className="flex flex-none items-center gap-2 px-2.5 pb-3.5 pt-1.5 text-base font-bold tracking-tight text-ink"
        aria-label={APP_NAME}
      >
        <BrandMark className="size-3.5 shrink-0" />
        <span>{APP_NAME}</span>
      </div>

      {/* Scrollable middle (sync badge, scenario picker, nav sections): `min-h-0 overflow-y-auto` lets just this region
          scroll, so the brand header and account footer stay pinned on short viewports. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        <div className="px-2.5 pb-2">
          <SyncBadge />
          {/* The drawer never carries it: the mobile banner already does at every narrow width. */}
          {!drawer && <AssistantSessionBadge variant="sidebar" />}
        </div>

        <SidebarScenarioPicker />

        <nav aria-label="Sections">
        <div className="mb-2 mt-0.5 flex flex-col gap-px">
          <button
            type="button"
            className={navItemClass(isItemActive(TOP_LEVEL_ITEM, pathname))}
            aria-current={isItemActive(TOP_LEVEL_ITEM, pathname) ? 'page' : undefined}
            onClick={() => goTo(TOP_LEVEL_ITEM.to)}
          >
            {TOP_LEVEL_ITEM.icon}
            <span>{TOP_LEVEL_ITEM.label}</span>
          </button>
        </div>
        {SECTIONS.map((section) => (
          <Disclosure
            key={section.id}
            defaultExpanded={isSectionDefaultExpanded(section, pathname)}
            className="group mb-0.5 rounded-md"
          >
            <Heading className="m-0">
              <Button
                slot="trigger"
                className="flex w-full cursor-pointer select-none items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted outline-none hover:bg-surface-sunken hover:text-ink data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring"
              >
                <ChevronIcon className="h-2.5 w-2.5 shrink-0 transition-transform group-data-[expanded]:rotate-90" />
                <span>{section.label}</span>
              </Button>
            </Heading>
            <DisclosurePanel>
              <div className="mt-0.5 flex flex-col gap-px">
                {section.items.filter(isItemShown).sort(byBetaLast).map((item) => {
                  const active = isItemActive(item, pathname);
                  return (
                    <button
                      key={item.to}
                      type="button"
                      className={navItemClass(active)}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => goTo(item.to)}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                      {/* Beta reaches screen readers as a suffix, "Guardrails (beta)", while the visible pill is
                          hidden, so the spans never fuse into "GuardrailsBeta". The bare space text node keeps them
                          apart: a leading space inside the sr-only span would be trimmed. */}
                      {item.betaFeature !== undefined && (
                        <>
                          {' '}
                          <span className="sr-only">(beta)</span>
                          <span aria-hidden="true" className="ml-auto flex shrink-0">
                            <Badge tone="modified" size="sm">
                              Beta
                            </Badge>
                          </span>
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            </DisclosurePanel>
          </Disclosure>
        ))}
        </nav>
      </div>

      {me && (
        <div className="mt-2 flex flex-none flex-col gap-2 border-t border-line px-2.5 pb-0.5 pt-3.5">
          <div>
            <div className="text-sm font-semibold text-ink">
              {me.displayName}
            </div>
            <div className="text-xs text-muted">
              {me.roles.join(', ')}
            </div>
          </div>
          <button
            type="button"
            className="w-full rounded-md border border-line-strong px-3 py-1.5 text-sm font-medium text-accent-link outline-none transition-colors hover:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onSignOut}
          >
            Sign out
          </button>
        </div>
      )}

      {/* Open-source line, in both the desktop column and the mobile drawer. */}
      <div className="mt-2 flex-none border-t border-line px-2.5 pb-0.5 pt-3">
        <div className="text-xs">
          <RepoLink kind="open-source" />
        </div>
      </div>
    </aside>
  );
};
