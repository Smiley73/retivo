/**
 * Create-scenario modal — extracted from `ScenariosPage.tsx` so that page
 * stays under the ≤400-line file shape cap after the Graphite Spectrum card
 * redesign (the per-card activate/delete wiring + lazy-metrics plumbing
 * pushed the parent over the cap). The modal surfaces a name + optional
 * description + parent picker (uniqueness-validated; the parent <Select>
 * carries the indented-tree depth classes).
 */
import React, { useMemo, useState } from 'react';
import { Modal } from '../components/Modal';
import { TextInput } from '../components/TextInput';
import { Field } from '../components/Field';
import { Select } from '../components/Select';
import { cryptoUuid } from '../lib/crypto-uuid';
import { createScenario } from '../lib/scenario-mutations';
import { buildScenarioTreeOptions } from '../lib/scenario-tree-options';
import {
  btnPrimaryClass,
  btnSecondaryClass,
  inputClass,
  errorTextClass,
} from './scenarios-page-chrome';
import type { ScenarioAggregate } from '../lib/scenario-resolution';

const MAX_NAME = 40;
const MAX_DESCRIPTION = 200;

interface CreateScenarioModalProps {
  open: boolean;
  householdId: string;
  scenarios: ScenarioAggregate[];
  onClose: () => void;
  onCreated: () => void;
}

export const CreateScenarioModal: React.FC<CreateScenarioModalProps> = ({
  open,
  householdId,
  scenarios,
  onClose,
  onCreated,
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState<string>(() => {
    return scenarios.find((s) => s.payload.isPrimary)?.id ?? '';
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const lower = trimmed.toLocaleLowerCase();
  const nameCollides = useMemo(
    () =>
      scenarios.some(
        (s) =>
          (s.payload.name ?? '').trim().toLocaleLowerCase() === lower &&
          lower.length > 0,
      ),
    [scenarios, lower],
  );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (trimmed.length === 0) {
      setError('Name is required.');
      return;
    }
    if (trimmed.length > MAX_NAME) {
      setError(`Name is too long (max ${MAX_NAME}).`);
      return;
    }
    if (nameCollides) {
      setError('A scenario with that name already exists.');
      return;
    }
    if (!parentId) {
      setError('Pick a parent scenario.');
      return;
    }
    if (description.length > MAX_DESCRIPTION) {
      setError(`Description is too long (max ${MAX_DESCRIPTION}).`);
      return;
    }
    setSubmitting(true);
    try {
      await createScenario({
        id: cryptoUuid('scen'),
        name: trimmed,
        description: description.trim(),
        parentScenarioId: parentId,
        householdId,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create scenario.');
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Create scenario" size="md">
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field htmlFor="create-scenario-name" label="Name">
          <TextInput
            id="create-scenario-name"
            type="text"
            value={name}
            maxLength={MAX_NAME}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field htmlFor="create-scenario-description" label="Description (optional)">
          <TextInput
            id="create-scenario-description"
            type="text"
            value={description}
            maxLength={MAX_DESCRIPTION}
            placeholder="Single-line summary of this scenario's intent"
            onChange={(e) => setDescription(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field htmlFor="create-scenario-parent" label="Parent scenario">
          <Select
            id="create-scenario-parent"
            ariaLabel="Parent scenario"
            value={parentId}
            onChange={setParentId}
            options={buildScenarioTreeOptions(scenarios).map(({ scenario: s, depth }) => ({
              value: s.id,
              label: `${s.payload.name}${s.payload.isPrimary ? ' (Base)' : ''}`,
              depth,
            }))}
          />
        </Field>
        {error && <p className={errorTextClass} role="alert">{error}</p>}
        {/* Left-aligned, primary action first — AGENTS modal rule. */}
        <div className="flex justify-start gap-2">
          <button type="submit" className={btnPrimaryClass} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create'}
          </button>
          <button
            type="button"
            className={btnSecondaryClass}
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
};
