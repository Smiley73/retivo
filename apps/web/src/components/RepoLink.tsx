/**
 * Inline external link to the public repo, a plain `<a>` because `TextLink` is a router `<Link>`. The new-tab hint is
 * an `sr-only` sibling via `aria-describedby`, so it never joins the link's name.
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
