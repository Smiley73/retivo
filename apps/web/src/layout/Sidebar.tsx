/**
 * Left-hand navigation sidebar with collapsible sections.
 *
 * Design choices:
 * - Sections use React Aria's `Disclosure` so collapse is
 *   keyboard-operable and announced by
 *   screen readers (WCAG 2.2 AA — see "Accessibility" in
 *   docs/ui-conventions.md). We render
 *   our own rotating chevron driven by the `data-[expanded]` state.
 * - Each item declares the pathname patterns that count as "selected" via
 *   `matchWhen`. We compute `aria-current="page"` ourselves rather than rely
 *   on NavLink's default descendant matching, because some routes belong to
 *   a sidebar entry that isn't a prefix of their path
 *   (e.g. `/accounts/:id/balances` is owned by "Account Balances", not
 *   "Accounts"). The active row gets `aria-current="page"` and the
 *   accent-wash utility classes (`navItemClass`).
 * - Admin-only items are hidden from non-admin callers. The API still
 *   enforces the policy; hiding is purely to reduce dead-end clicks.
 * - Beta items (`betaFeature`) render only while that feature is visible
 *   (offered by the build + the user's "Show beta features" switch — see
 *   lib/feature-flags.ts) and then carry a small "Beta" badge after the label.
 */
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
  // Optional override: declares which pathname patterns count as "this item is selected".
  // Used when a route logically belongs to a sidebar entry that isn't a prefix of `to`
  // (e.g. /accounts/:id/balances belongs to "Account Balances", not "Accounts").
  // When omitted, the item is active iff pathname === to.
  matchWhen?: string[];
  // Marks the item as a beta feature: hidden unless that feature is visible,
  // badged "Beta" when shown.
  betaFeature?: BetaFeatureId;
}

interface NavSection {
  id: string;
  label: string;
  /** Whether the section is open by default on first render. */
  defaultOpen: boolean;
  items: NavItem[];
}

// Top-level link shown above the collapsible sections (no Disclosure wrapper).
// Dashboard is the home view of every authenticated session; pinning it here
// keeps it one click away regardless of which sections the user has collapsed.
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
        // Detail page lives under /scenarios/:id; sub-screens under
        // /scenarios/:id/* — all should keep the entry active.
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
        // Defensive: also match nested optimizer sub-routes that may
        // appear in a future PR (none in v1).
        matchWhen: ['/optimizer', '/optimizer/*'],
      },
      {
        to: '/roth-optimizer',
        label: 'Roth conversion comparison',
        icon: <TargetIcon />,
        // Exact match — no sub-routes.
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
        // /accounts/:id/balances is owned by "Account Balances" below; keep this
        // entry's active state on the accounts list (the create/edit form is a
        // modal on /accounts now, addressed via ?new / ?edit query params).
        matchWhen: ['/accounts'],
      },
      {
        to: '/account-balances',
        label: 'Account Balances',
        icon: <BalancesIcon />,
        // Per-account balance entries page belongs here, not under "Accounts".
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
        // Add and edit forms live under /expenses/*; keep the entry active there too.
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
   * Rendered inside the React Aria `<MobileNavDrawer>` overlay (mobile).
   * In drawer mode the overlay owns positioning + the navigation
   * landmark (`aria-label` on its Dialog), so the `<aside>` drops its
   * fixed/slide-in/sticky classes and its duplicate landmark label and
   * just fills the drawer panel. Desktop renders the static column
   * (default), hidden below `lg`.
   */
  drawer?: boolean;
}

function isItemActive(item: NavItem, pathname: string): boolean {
  if (item.matchWhen) {
    return item.matchWhen.some((pattern) => matchPath({ path: pattern, end: true }, pathname) !== null);
  }
  return pathname === item.to;
}

// A section starts expanded when it is flagged `defaultOpen` (Planning) OR it
// holds the active route — so a deep-link / refresh into a default-collapsed
// section (e.g. /security under Settings) still shows the user where they are.
function isSectionDefaultExpanded(section: NavSection, pathname: string): boolean {
  return section.defaultOpen || section.items.some((item) => isItemActive(item, pathname));
}

// A single nav row — rendered as a <button> (not <Link>) so the browser
// never exposes the full URL in the status bar on hover. Active state is
// the accent wash (lime-subtle fill + the iris accent-link ink, the
// registered "accent link on card surface" pair — the bright lime accent
// is a fill colour, too light to read as text); idle rows are ink text
// with a subtle sunken hover. Dark mode rides the `.dark` variable swap.
const NAV_ITEM_BASE =
  'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm ' +
  'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring';
const NAV_ITEM_IDLE = 'text-ink hover:bg-surface-sunken';
// Active row = the accent wash + an accent-link green label/icon (the icon
// inherits via currentColor), matching the mock's `.nav a.on`. The accent-link
// green on the wash is the registered "active-nav text on accent wash" pair
// (5.36:1) — repointed from text-positive, which read a muddy green-on-green
// once the wash itself turned green.
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

  // Beta items drop out entirely while their feature is hidden — the route
  // gate (BetaFeatureGate) covers a deep link to the hidden page.
  const isItemShown = (item: NavItem): boolean =>
    item.betaFeature === undefined || isBetaFeatureVisible(item.betaFeature);

  // Beta items sort after every stable item in their section, in their
  // SECTIONS array order — so a new beta feature lands at the bottom
  // without anyone having to remember to place its entry there by hand.
  // `Array.prototype.sort` is stable (ES2019+), so this only ever moves
  // beta items down; it never reorders within either group.
  const byBetaLast = (a: NavItem, b: NavItem): number =>
    Number(a.betaFeature !== undefined) - Number(b.betaFeature !== undefined);

  // Sidebar entries render as <button>s (not <Link>s) so the browser
  // doesn't expose the full URL in the status bar on hover. Programmatic
  // navigation keeps the SPA semantics intact. Tradeoff: middle-click /
  // cmd-click "Open in new tab" no longer works from the sidebar — the
  // user can still get there from the address bar or via the in-page
  // links inside each surface.
  const goTo = (to: string): void => {
    onItemClick();
    navigate(to);
  };

  return (
    <aside
      className={
        drawer
          ? // Inside the React Aria MobileNavDrawer overlay: just fill
            // the drawer panel (the overlay owns position + scrim +
            // focus trap). No fixed/sticky/translate, no landmark label
            // (the drawer Dialog provides the navigation landmark).
            // `overflow-hidden` here (not `overflow-y-auto`) so the
            // inner scroll region — not the whole column — scrolls; the
            // footer stays pinned (see the scroll wrapper below).
            'flex h-full flex-col border-r ' +
            'border-line bg-surface-raised p-3'
          : // Desktop: sticky, full-height fixed-width flex column (the
            // app shell is a flex row — App.tsx); `lg:shrink-0` keeps
            // the `w-64` track from collapsing next to the fluid main.
            // Hidden below `lg` — the MobileNavDrawer renders the
            // mobile presentation. The column itself does NOT scroll
            // (`overflow-hidden`); only the middle region does, so the
            // footer (account + Sign out) is always in view.
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

      {/* Scrollable middle: sync badge, scenario picker, and the nav
          sections. `flex-1 min-h-0 overflow-y-auto` lets just this
          region scroll when the link list is taller than the viewport,
          so the brand header (above) and the account footer (below)
          stay pinned — the footer no longer gets pushed off-screen on
          short viewports (the migration regression this fixes). */}
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
                      {/* Beta status reaches screen readers as a readable
                          suffix — "Guardrails (beta)" — while the visible pill
                          is hidden from the name, so the two adjacent spans
                          never fuse into "GuardrailsBeta". The bare space text
                          node is what keeps the suffix separated: a leading
                          space INSIDE the sr-only span would be trimmed away. */}
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

      {/* Open-source line — rendered in both the desktop column and the
          mobile drawer. */}
      <div className="mt-2 flex-none border-t border-line px-2.5 pb-0.5 pt-3">
        <div className="text-xs">
          <RepoLink kind="open-source" />
        </div>
      </div>
    </aside>
  );
};
