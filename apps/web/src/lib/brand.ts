/**
 * Single source of truth for the PRODUCT brand strings — the RETIVO name,
 * tagline, and public repo address.
 *
 * Framework-free `.ts` constants so React components
 * (sidebar, auth chrome, print headers) AND the framework-free PDF builder
 * `pdf-export/build-pdf.ts` share one definition. These are MUTABLE product UI
 * strings.
 *
 * Casing rule: `APP_NAME` is the all-caps wordmark for visual lockups; use
 * `APP_NAME_PROSE` inside sentences.
 */

/** Wordmark, for logo lockups and the document title. */
export const APP_NAME = 'RETIVO';

/**
 * Cache-versioned browser mark used by every React lockup. The favicon
 * contract test keeps this URL aligned with the static link in `index.html`.
 */
export const BRAND_MARK_URL = '/favicon.svg?v=4';

/** The product name as written in running text. */
export const APP_NAME_PROSE = 'Retivo';

/** Product tagline, shown under the wordmark on auth pages. */
export const APP_TAGLINE = 'Model your retirement. See the possibilities.';

/** The public source repository — the one definition of its address. */
export const REPO_URL = 'https://github.com/Smiley73/retivo';

/** `REPO_URL` without the scheme, for compact footers. */
export const REPO_HOST_PATH = REPO_URL.replace(/^https:\/\//, '');

/** Where to report a problem, built from `REPO_URL`. */
export const ISSUES_URL = `${REPO_URL}/issues`;

/** The owner-fixed open-source line (all-caps RETIVO by decision). */
export const OPEN_SOURCE_TEXT = 'RETIVO is open source';

/** The owner-fixed text of every link to the issue tracker. */
export const REPORT_ISSUE_TEXT = 'Report an issue on GitHub';
