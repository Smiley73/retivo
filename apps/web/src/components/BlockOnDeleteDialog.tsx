/**
 * Shared "can't delete/disable, still referenced" dialog; the caller supplies the copy and the full list, and the
 * dialog caps the rows and renders the "+ N more" residual.
 */
import React from 'react';
import { textLinkClass } from './TextLink';
import { Link } from 'react-router';
import { Modal } from './Modal';
import { Muted } from './Muted';
import { btnPrimaryClass } from './dialog-chrome';

const MAX_REFS_VISIBLE = 20;

export interface BlockOnDeleteDialogProps {
  title: string;
  /** Count sentence with the inline bold total, rendered inside a `<p>`. */
  lead: React.ReactNode;
  remediation: React.ReactNode;
  /** Full, uncapped, ordered reference labels; the dialog caps them to {@link MAX_REFS_VISIBLE}. */
  labels: string[];
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
