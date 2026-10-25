/** What's New: the in-app changelog, rendering RELEASE_NOTES in array order (no runtime sort; the ordering invariant is enforced by release-notes.test.ts) in one card per release date.
* `notes` is injectable so tests can render an empty list or a malformed entry. */
import React from 'react';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { Stack } from '../components/Stack';
import { Badge, type BadgeTone } from '../components/Badge';
import { formatDate } from '../lib/format-date';
import { RELEASE_NOTES, type ReleaseNote, type ReleaseNoteKind } from '../lib/release-notes';

const KIND_BADGE: Record<ReleaseNoteKind, { tone: BadgeTone; label: string }> = {
  new: { tone: 'success', label: 'New' },
  improved: { tone: 'scenario', label: 'Improved' },
  fixed: { tone: 'modified', label: 'Fixed' },
};

interface DateGroup {
  readonly date: string;
  readonly notes: readonly ReleaseNote[];
}

// Collapses consecutive same-date notes into one group; the non-increasing-date invariant makes them adjacent, so it never reorders.
function groupByDate(notes: readonly ReleaseNote[]): DateGroup[] {
  const groups: DateGroup[] = [];
  for (const note of notes) {
    const last = groups[groups.length - 1];
    if (last && last.date === note.date) {
      (last.notes as ReleaseNote[]).push(note);
    } else {
      groups.push({ date: note.date, notes: [note] });
    }
  }
  return groups;
}

interface WhatsNewPageProps {
  notes?: readonly ReleaseNote[];
}

export const WhatsNewPage: React.FC<WhatsNewPageProps> = ({
  notes = RELEASE_NOTES,
}) => {
  const groups = groupByDate(notes);
  return (
    <section>
      <PageHeader
        title="What's New"
        subtitle="Recent changes to the app, newest first — in plain language."
      />
      <Stack className="gap-4">
        {groups.map((group, groupIndex) => {
          const formattedDate = formatDate(group.date);
          return (
            <Card key={`${group.date}-${groupIndex}`}>
              {formattedDate && (
                <h2 className="m-0 mb-4 text-sm font-semibold uppercase tracking-wide text-muted">
                  {formattedDate}
                </h2>
              )}
              <Stack className="gap-4">
                {group.notes.map((note, noteIndex) => {
                  // Fall back to a neutral badge for an unexpected kind so a malformed entry renders instead of throwing.
                  const badge = KIND_BADGE[note.kind] ?? {
                    tone: 'neutral' as BadgeTone,
                    label: note.kind,
                  };
                  return (
                    <div key={noteIndex}>
                      <div className="flex flex-wrap items-center gap-3">
                        <Badge
                          tone={badge.tone}
                          className="w-20 shrink-0 justify-center"
                        >
                          {badge.label}
                        </Badge>
                        <h3 className="m-0 text-base font-semibold text-ink">
                          {note.title}
                        </h3>
                      </div>
                      {note.blurb && (
                        <p className="mt-1 text-sm text-muted">{note.blurb}</p>
                      )}
                    </div>
                  );
                })}
              </Stack>
            </Card>
          );
        })}
      </Stack>
    </section>
  );
};
