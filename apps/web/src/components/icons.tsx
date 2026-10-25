/**
 * Shared 14px `currentColor` outline glyphs; decorative (`aria-hidden`), the surrounding text is the accessible name.
 */
import React from 'react';

const ICON = 'size-3.5 shrink-0';
const svg = (children: React.ReactNode): React.ReactElement => (
  <svg
    aria-hidden="true"
    className={ICON}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

// ── Universal action glyphs ──
export const PlusIcon = (): React.ReactElement =>
  svg(<><path d="M12 5v14M5 12h14" /></>);
export const CheckIcon = (): React.ReactElement =>
  svg(<><path d="M4 12.5l5 5L20 6" /></>);
export const TrashIcon = (): React.ReactElement =>
  svg(<><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" /><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" /></>);
export const RefreshIcon = (): React.ReactElement =>
  svg(<><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></>);
export const StarIcon = (): React.ReactElement =>
  svg(<><path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9 6.8 19.2l1-5.8L3.5 9.2l5.9-.9z" /></>);
export const PlayIcon = (): React.ReactElement =>
  svg(<><path d="M7 5l11 7-11 7z" /></>);
export const PencilIcon = (): React.ReactElement =>
  svg(<><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z" /><path d="M13.5 6.5l3 3" /></>);
export const XIcon = (): React.ReactElement =>
  svg(<><path d="M6 6l12 12M18 6L6 18" /></>);
export const LinkIcon = (): React.ReactElement =>
  svg(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" /></>);
export const SlidersIcon = (): React.ReactElement =>
  svg(<><circle cx="9" cy="7" r="2.2" /><path d="M3 7h4M11 7h10" /><circle cx="15" cy="17" r="2.2" /><path d="M3 17h10M17 17h4" /></>);

// ── Profile data / credential glyphs (shared so Profile stays DRY) ──
export const DownloadIcon = (): React.ReactElement =>
  svg(<><path d="M12 3v12" /><path d="M8 11l4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>);
export const UploadIcon = (): React.ReactElement =>
  svg(<><path d="M12 16V4" /><path d="M8 8l4-4 4 4" /><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>);
export const HistoryIcon = (): React.ReactElement =>
  svg(<><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l3 2" /></>);
export const SparklesIcon = (): React.ReactElement =>
  svg(<><path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7z" /><path d="M5 16l.8 2 2 .8-2 .8L5 22l-.8-2.4-2-.8 2-.8z" /></>);
export const KeyIcon = (): React.ReactElement =>
  svg(<><circle cx="8" cy="15" r="4" /><path d="M10.85 12.15L20 3" /><path d="M17 6l2 2M14 9l2 2" /></>);
export const FingerprintIcon = (): React.ReactElement =>
  svg(<><path d="M5 12a7 7 0 0 1 14 0" /><path d="M8.5 13a3.5 3.5 0 0 1 7 0c0 3-.8 5-1 5.5" /><path d="M12 13v2c0 2-.5 4-1 5.5" /><path d="M7.5 19c.6-1.4 1-3 1-5a3.5 3.5 0 0 1 .3-1.4" /></>);
export const LockOpenIcon = (): React.ReactElement =>
  svg(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.7-1.5" /></>);

export const WarningIcon = (): React.ReactElement =>
  svg(<><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>);

export const InfoIcon = (): React.ReactElement =>
  svg(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>);

// ── Scenario override-group glyphs (one per plain-English topic group) ──
// Timing & longevity — clock.
export const ClockIcon = (): React.ReactElement =>
  svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
// Income & expenses — wallet.
export const WalletIcon = (): React.ReactElement =>
  svg(<><path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2" /><rect x="3" y="7" width="18" height="12" rx="2" /><path d="M16 12h.01" /></>);
// Savings & investments — trending-up chart.
export const TrendingUpIcon = (): React.ReactElement =>
  svg(<><path d="M3 17l6-6 4 4 7-7" /><path d="M17 7h4v4" /></>);
// Withdrawals & taxes — balance scale.
export const ScaleIcon = (): React.ReactElement =>
  svg(<><path d="M12 3v18" /><path d="M7 21h10" /><path d="M3 8h18" /><path d="M3 8l-2 5a3 3 0 0 0 6 0z" /><path d="M21 8l2 5a3 3 0 0 1 -6 0z" /></>);
