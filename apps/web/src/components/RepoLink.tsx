/**
 * External link to the public repo — either the "RETIVO is open source" line or
 * the "Report an issue on GitHub" link.
 *
 * Accessibility contract (load-bearing):
 *   - Plain `<a target="_blank" rel="noopener noreferrer">` styled with
 *     `textLinkClass`. Not `TextLink`: that is a React Router `<Link>`, wrong for
 *     an off-site address, and the error screen can render outside a router.
 *   - The link's accessible NAME is exactly its visible text. The new-tab hint
 *     lives in a SIBLING `<span className="sr-only">` OUTSIDE the `<a>`,
 *     referenced via `aria-describedby`, so it is the link's accessible
 *     DESCRIPTION and never part of its name.
 *   - `newTabDescId` comes from `useId()` so two instances on one page never
 *     collide.
 *
 * Renders inline (a fragment), so it can sit inside a sentence; the call site
 * supplies any wrapper.
 */
import React, { useId } from 'react';
import {
  ISSUES_URL,
  OPEN_SOURCE_TEXT,
  REPO_URL,
  REPORT_ISSUE_TEXT,
} from '../lib/brand';
import { textLinkClass } from './TextLink';

interface RepoLinkProps {
  /** `open-source` links the repo; `issue` links its issue tracker. */
  readonly kind: 'open-source' | 'issue';
}

export const RepoLink: React.FC<RepoLinkProps> = ({ kind }) => {
  const newTabDescId = useId();
  const isIssue = kind === 'issue';

  return (
    <>
      <a
        href={isIssue ? ISSUES_URL : REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-describedby={newTabDescId}
        className={textLinkClass}
      >
        {isIssue ? REPORT_ISSUE_TEXT : OPEN_SOURCE_TEXT}
      </a>
      <span id={newTabDescId} className="sr-only">
        Opens in a new tab
      </span>
    </>
  );
};
