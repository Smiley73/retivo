// Inline SVG nav glyphs for Sidebar.tsx; presentational, each uses `currentColor` so it follows the row's active/hover ink.
import React from 'react';

// Nav item glyph: small, slightly dimmed, never shrinks below its box.
const NAV_ICON_CLASS = 'size-4 shrink-0 opacity-85';

export const ChevronIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props} aria-hidden="true">
    <polyline points="6 3 11 8 6 13" />
  </svg>
);

export const DashboardIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </svg>
);

export const ProfileIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6" />
  </svg>
);

export const HouseholdIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </svg>
);

export const AssetsIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="M2 10h20" />
    <path d="M6 16h4" />
  </svg>
);

export const BalancesIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <ellipse cx="12" cy="6" rx="8" ry="2.5" />
    <path d="M4 6v5c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V6" />
    <path d="M4 11v5c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-5" />
  </svg>
);

export const ScenariosIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v18" />
    <path d="M5 7h7" />
    <path d="M5 14h7" />
    <path d="M19 11h-7" />
    <path d="M19 18h-7" />
  </svg>
);

export const SocialSecurityIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="4 10 12 5 20 10" />
    <line x1="4" y1="10" x2="20" y2="10" />
    <line x1="6" y1="17" x2="6" y2="10" />
    <line x1="10" y1="17" x2="10" y2="10" />
    <line x1="14" y1="17" x2="14" y2="10" />
    <line x1="18" y1="17" x2="18" y2="10" />
    <line x1="4" y1="17" x2="20" y2="17" />
    <line x1="3" y1="20" x2="21" y2="20" />
  </svg>
);

export const PiggyBankIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 13c0-3.3 3.1-6 7-6 3.6 0 6.5 2.3 6.9 5.2L20 13v3l-1.5.4c-.4 1-1.1 1.9-2 2.6V21h-2v-1.5c-.6.1-1.3.2-2 .2s-1.4-.1-2-.2V21H8.5v-2c-1.5-1-2.5-2.5-2.5-4.5z" />
    <line x1="14.5" y1="11" x2="15" y2="11" />
    <path d="M11 7c-.3-1 .3-2.5 1.5-3 0 1 .5 1.8 1.5 2" />
    <line x1="9" y1="11" x2="11" y2="11" />
  </svg>
);

export const ProjectionIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="3 17 9 11 13 15 21 5" />
    <polyline points="15 5 21 5 21 11" />
  </svg>
);

export const ReceiptIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 3h14v18l-3-2-3 2-3-2-3 2-2-1.5z" />
    <line x1="8" y1="8" x2="16" y2="8" />
    <line x1="8" y1="12" x2="16" y2="12" />
    <line x1="8" y1="16" x2="13" y2="16" />
  </svg>
);

export const BanknoteIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <circle cx="12" cy="12" r="2.5" />
    <line x1="6" y1="10" x2="6" y2="10" />
    <line x1="18" y1="14" x2="18" y2="14" />
  </svg>
);

export const TagIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12V4a1 1 0 011-1h8l9 9-9 9-9-9z" />
    <circle cx="7.5" cy="7.5" r="1.5" />
  </svg>
);

export const TargetIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
  </svg>
);

export const WrenchIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14.7 6.3a4 4 0 015.4 5.4l-2.7-1-1 2.7-2.7-1-1 2.7-2.7-1L8.7 17 4 21.3 2.7 20l4.3-4.3 2.7-1 1-2.7 2.7 1 1-2.7 2.7 1z" />
  </svg>
);

export const ShieldIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3z" />
  </svg>
);

export const SparklesIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z" />
    <path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14z" />
  </svg>
);

export const ReportIcon = () => (
  <svg className={NAV_ICON_CLASS} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="13" y2="17" />
  </svg>
);
