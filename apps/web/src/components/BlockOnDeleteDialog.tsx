/**
 * Shared "can't delete/disable — it's still referenced" dialog.
 *
 * One dialog shape for every block-on-reference guard: the expense
 * category delete guard and the income-linked account delete/disable guard.
 * The caller supplies the verb/noun copy (`lead`, `remediation`) so the
 * wording fits its domain; the dialog owns the reference-list cap so a
 * single place decides how many rows to show and renders the "+ N more"
 * residual itself (DRY — callers always pass the full, uncapped list).
 */
import React from 'react';
import { textLinkClass } from './TextLink';
import { Link } from 'react-router';
import { Modal } from './Modal';
import { Muted } from './Muted';
import { btnPrimaryClass } from './dialog-chrome';

/** Reference rows shown before the list is truncated with "+ N more". */
const MAX_REFS_VISIBLE = 20;

export interface BlockOnDeleteDialogProps {
  /** Modal title, e.g. `Cannot delete "Housing"`. */
  title: string;
  /** Count sentence with the inline bold total, rendered inside a `<p>`
   *  (e.g. `It's used by <strong>3</strong> expenses:`). */
  lead: React.ReactNode;
  /** "Fix it first, then retry" copy, rendered inside a muted `<p>`. */
  remediation: React.ReactNode;
  /** Full, uncapped, already-ordered reference labels. The dialog caps
   *  to {@link MAX_REFS_VISIBLE} and derives the residual itself. */
  labels: string[];
  /** Optional deep-link to the resolution page (rendered after Close). */
  footerLink?: { to: string; label: string };
  onClose: () => void;
}

export const BlockOnDeleteDialog: React.FC<BlockOnDeleteDialogProps> = ({
  title,
  lead,
  remediation,
  labels,
  footerLink,
  onClose,
}) => {
  const visible = labels.slice(0, MAX_REFS_VISIBLE);
  const residual = labels.length - visible.length;
  return (
    <Modal open title={title} onClose={onClose} size="lg" onEnter={onClose}>
      <p className="mt-0 text-ink">{lead}</p>
      <ul className="list-disc pl-5 text-muted">
        {visible.map((label, i) => (
          <li key={i}>{label}</li>
        ))}
        {residual > 0 && (
          <li>
            <em>+ {residual} more</em>
          </li>
        )}
      </ul>
      <Muted as="p">{remediation}</Muted>
      {/* Left-aligned, primary (Close) first ("Modals" in docs/ui-conventions.md). */}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={btnPrimaryClass} onClick={onClose}>
          Close
        </button>
        {footerLink && (
          <Link
            to={footerLink.to}
            className={textLinkClass}
          >
            {footerLink.label}
          </Link>
        )}
      </div>
    </Modal>
  );
};
