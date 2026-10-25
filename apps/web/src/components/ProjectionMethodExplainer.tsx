/**
 * Prop-less explainer modal glossing the projection figures and the dollars toggle; names and the past-performance
 * disclaimer come from `projection-method-labels.ts` so it cannot disagree with the selector.
 */
import React, { useState } from 'react';
import { Modal } from './Modal';
import { btnSecondarySmClass } from './dialog-chrome';
import {
  PAST_PERFORMANCE_DISCLAIMER,
  TWR_METHOD_LABEL,
} from '../lib/projection-method-labels';

type Entry = { term: string; explanation: string };

const INTRO =
  `Planned and ${TWR_METHOD_LABEL} each assume one fixed return rate. ` +
  'Typical, Pessimistic, and Bad-luck come from a 10,000-run market stress ' +
  'test.';

const METHODS: ReadonlyArray<Entry> = [
  {
    term: 'Planned',
    explanation:
      'Each account grows at the return % you set for it: your plan if ' +
      'your own estimates hold.',
  },
  {
    term: TWR_METHOD_LABEL,
    // The measured-return gloss closes with the past-performance disclaimer: a realized return is a
    // track record, not a prediction.
    explanation:
      'Each account grows at the rate it has actually earned in your ' +
      'balance history: a check against your real track record. ' +
      PAST_PERFORMANCE_DISCLAIMER,
  },
  {
    term: 'Typical',
    explanation:
      'The middle outcome of 10,000 simulated market histories: about ' +
      'half do better, half worse.',
  },
  {
    term: 'Pessimistic',
    explanation: 'A rough 1-in-4 bad case (the 25th-percentile outcome).',
  },
  {
    term: 'Bad-luck',
    explanation: 'A rough 1-in-10 bad case (the 10th-percentile outcome).',
  },
];

const UNITS_INTRO =
  "The Today's / Future dollars toggle next to this button changes " +
  'how every amount above is shown.';

const UNITS: ReadonlyArray<Entry> = [
  {
    term: "Today's dollars",
    explanation:
      "Adjusted for inflation and shown in today's money, so a future " +
      "amount reads at what it's worth to you now. $100k stays $100k " +
      'however distant the year.',
  },
  {
    term: 'Future dollars',
    explanation:
      'The raw projected amount for that year with inflation left in, so ' +
      'the same $100k reads larger the further out you look.',
  },
];

const TermList: React.FC<{ items: ReadonlyArray<Entry> }> = ({ items }) => (
  <dl className="mt-3 mb-0 grid grid-cols-1 gap-2">
    {items.map(({ term, explanation }) => (
      <div key={term}>
        <dt className="text-sm font-semibold text-ink">
          {term}
        </dt>
        <dd className="m-0 text-sm text-muted">
          {explanation}
        </dd>
      </div>
    ))}
  </dl>
);

export const ProjectionMethodExplainer: React.FC = () => {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        className={btnSecondarySmClass}
        onClick={() => setOpen(true)}
      >
        What do these mean?
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="How to read these figures"
        size="2xl"
      >
        <p className="mt-0 text-sm text-muted">
          {INTRO}
        </p>
        <TermList items={METHODS} />
        <p className="mt-4 text-sm text-muted">
          {UNITS_INTRO}
        </p>
        <TermList items={UNITS} />
      </Modal>
    </div>
  );
};
