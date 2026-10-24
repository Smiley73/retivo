/** Per-member benefits table for the Social Security page; render-only, the page owns reads, modal state and the delete confirm. */
import React from 'react';
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { NotesIndicator } from '../components/NotesIndicator';
import { TableScroll } from '../components/TableScroll';
import { formatDate } from '../lib/format-date';
import { formatCurrency } from '../lib/format-currency';
import {
  btnPrimarySmClass,
  tableClass,
  thClass,
  tdClass,
} from './profile-page-chrome';
import {
  PencilIcon,
  TrashIcon,
  iactEditClass,
  iactDeleteClass,
} from './accounts-page-chrome';

interface SocialSecurityTableMemberView {
  id: string;
  isPrimary: boolean;
  firstName: string;
}

interface SocialSecurityTableBenefitView {
  id: string;
  version: number;
  householdMemberId: string;
  memberDisplayName: string;
  pia: number | null;
  piaAsOfDate: string | null;
  notes: string | null;
  fraMonths: number;
  monthlyBenefitAt62: number | null;
  monthlyBenefitAtFra: number | null;
  monthlyBenefitAt70: number | null;
}

export interface SocialSecurityTableProps {
  adultMembers: SocialSecurityTableMemberView[];
  benefits: SocialSecurityTableBenefitView[];
  onOpenModal: (
    memberId: string,
    existing: SocialSecurityTableBenefitView | undefined,
  ) => void;
  onRemoveBenefit: (benefit: SocialSecurityTableBenefitView) => void;
}

const renderAmount = (v: number | null): React.ReactNode =>
  v === null ? <span aria-label="not entered">—</span> : formatCurrency(v);

export const SocialSecurityTable: React.FC<SocialSecurityTableProps> = ({
  adultMembers,
  benefits,
  onOpenModal,
  onRemoveBenefit,
}) => (
  // scroll={false}: the rows carry the hover-revealed .row-actions cluster, and an overflow wrapper triggers WebKit's stuck-:hover bug (see TableScroll).
  <TableScroll
    label="Social Security benefits per household member"
    scroll={false}
  >
    <Table
      className={tableClass}
      aria-label="Social Security benefits per household member"
    >
      <TableHeader>
        <Column isRowHeader className={thClass}>Member</Column>
        <Column className={`${thClass} text-right`}>At 62</Column>
        <Column className={`${thClass} text-right`}>At FRA</Column>
        <Column className={`${thClass} text-right`}>At 70</Column>
        <Column className={thClass}>SSA statement date</Column>
        <Column className={thClass}>
          <span className="sr-only">Actions</span>
        </Column>
      </TableHeader>
      <TableBody>
        {adultMembers.map((member) => {
          const benefit = benefits.find(
            (b) => b.householdMemberId === member.id,
          );
          const memberLabel = `${member.firstName}${member.isPrimary ? ' (primary)' : ''}`;
          return (
            <Row key={member.id} id={member.id} className="group/row">
              <Cell className={tdClass}>
                <span className="inline-flex items-center gap-1.5">
                  {memberLabel}
                  <NotesIndicator notes={benefit?.notes} />
                </span>
              </Cell>
              <Cell className={`${tdClass} text-right font-mono tabular-nums`}>
                {benefit ? (
                  renderAmount(benefit.monthlyBenefitAt62)
                ) : (
                  <span aria-label="not entered">—</span>
                )}
              </Cell>
              <Cell className={`${tdClass} text-right font-mono tabular-nums`}>
                {benefit ? (
                  renderAmount(benefit.monthlyBenefitAtFra)
                ) : (
                  <span aria-label="not entered">—</span>
                )}
              </Cell>
              <Cell className={`${tdClass} text-right font-mono tabular-nums`}>
                {benefit ? (
                  renderAmount(benefit.monthlyBenefitAt70)
                ) : (
                  <span aria-label="not entered">—</span>
                )}
              </Cell>
              <Cell className={tdClass}>
                {benefit?.piaAsOfDate ? (
                  formatDate(benefit.piaAsOfDate)
                ) : (
                  <span aria-label="not entered">—</span>
                )}
              </Cell>
              <Cell className={tdClass}>
                {benefit ? (
                  <div className="row-actions items-center">
                    <button
                      type="button"
                      className={iactEditClass}
                      onClick={() => onOpenModal(member.id, benefit)}
                      aria-label={`Edit ${memberLabel}`}
                    >
                      <PencilIcon />
                    </button>
                    <button
                      type="button"
                      className={iactDeleteClass}
                      onClick={() => onRemoveBenefit(benefit)}
                      aria-label={`Delete ${memberLabel}`}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                ) : (
                  // The empty state keeps an always-visible Add affordance, not a hover-hidden one.
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      className={btnPrimarySmClass}
                      onClick={() => onOpenModal(member.id, undefined)}
                    >
                      Add
                    </button>
                  </div>
                )}
              </Cell>
            </Row>
          );
        })}
      </TableBody>
    </Table>
  </TableScroll>
);
