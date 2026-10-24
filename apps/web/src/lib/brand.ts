// Product brand strings (name, tagline, repo address) as framework-free constants shared by React components and the PDF builder.
// `APP_NAME` is the all-caps wordmark for lockups; use `APP_NAME_PROSE` in sentences.

export const APP_NAME = 'RETIVO';

/** Cache-versioned browser mark; the favicon contract test keeps it aligned with the static link in `index.html`. */
export const BRAND_MARK_URL = '/favicon.svg?v=4';

export const APP_NAME_PROSE = 'Retivo';

export const APP_TAGLINE = 'Model your retirement. See the possibilities.';

export const REPO_URL = 'https://github.com/Smiley73/retivo';

export const REPO_HOST_PATH = REPO_URL.replace(/^https:\/\//, '');

export const ISSUES_URL = `${REPO_URL}/issues`;

export const OPEN_SOURCE_TEXT = 'RETIVO is open source';

export const REPORT_ISSUE_TEXT = 'Report an issue on GitHub';
