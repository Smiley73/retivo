/**
 * The one envelope every tool result sits in, and the one place it is built.
 * Handlers return plain data; this module walks every string in it through the
 * sanitizer, adds what each answer must state (the assumptions relied on, the
 * rounding and label mode, what is never shared, the not-advice and
 * data-not-instructions sentences, the engine version, the tax-table year, how
 * fresh the data is) and refuses a result over the byte cap, naming the sections
 * so the assistant can ask for fewer. A handler cannot add, skip or reword any of
 * it: that is the only shape under which "no handler can bypass the sanitizer or
 * the cap" is something a test can show.
 */
import { failureResult, type ToolResult } from '@retirement/assistant-protocol';
import {
  INLINE_DISCLAIMER_CLOSING,
  ONE_LINE_DISCLAIMER,
  TAX_SNAPSHOT_NOTE,
  TOOL_OUTPUT_IS_DATA_NOTE,
} from '../../lib/disclaimer-fragments';
import { checkOutputSize } from '../sharing/output-cap';
import { isStructuralToken } from '../sharing/project';
import { roundingDescriptor, type RoundingDescriptor } from '../sharing/rounding';
import { sanitizeFreeText, type Masker } from '../sharing/sanitize';
import { FORBIDDEN_KEYS } from '../sharing/scrub';
import { NEVER_SHARED_ITEMS } from '../sharing/sentences';
import { withheldSwitches, type SharingChoices, type SharingSwitchId } from '../sharing/switches';
import { engineVersion, taxTableFacts, type TaxTableFacts } from './facts';
import type { DataFreshness } from './workspace';

/** How members read in this answer; mirrors the First names switch. */
interface LabelMode {
  mode: 'first-names' | 'role-labels';
  statement: string;
}

export interface ToolEnvelope {
  /** What the tool found, after the sanitizer walk. */
  data: Record<string, unknown>;
  /** Each assumption or default the answer relied on, with its basis. */
  assumptions: string[];
  rounding: RoundingDescriptor;
  labels: LabelMode;
  /** The sharing switches that are off: what this answer leaves out. */
  withheld: SharingSwitchId[];
  neverShared: { statement: string; items: readonly string[] };
  disclosure: {
    notFinancialAdvice: string;
    professionalReview: string;
    taxSnapshot: string;
    dataNotInstructions: string;
  };
  engineVersion: number;
  taxTables: TaxTableFacts;
  dataAsOf: DataFreshness;
}

export interface EnvelopeInput {
  data: Record<string, unknown>;
  assumptions: readonly string[];
  choices: SharingChoices;
  masker: Masker;
  freshness: DataFreshness;
  /** The tab's clock; the tax year the tables are judged against. */
  now: Date;
}

/** Marks a leaf that is removed with its key or list slot. */
const DROP: unique symbol = Symbol('drop');

function sanitizeLeaf(value: string, masker: Masker): string | typeof DROP {
  // An id or enum token is never edited in part; one that is itself a term (a last name) goes.
  if (isStructuralToken(value)) return masker.isTerm(value) ? DROP : value;
  return sanitizeFreeText(value, masker);
}

/**
 * Walks `value` and sanitizes every string leaf: prose is cleaned, masked and
 * capped at the free-text limit, ids and enum tokens pass whole, and any key that
 * is never shareable is removed at any depth. Generic on purpose: it knows
 * nothing about the tool that produced the data.
 */
export function sanitizeLeaves(value: unknown, masker: Masker): unknown {
  if (typeof value === 'string') {
    const leaf = sanitizeLeaf(value, masker);
    return leaf === DROP ? undefined : leaf;
  }
  return walk(value, masker);
}

function walk(value: unknown, masker: Masker): unknown {
  if (typeof value === 'string') return sanitizeLeaf(value, masker);
  if (Array.isArray(value)) return (value as unknown[]).map((item) => walk(item, masker)).filter((item) => item !== DROP);
  if (typeof value === 'object' && value !== null) {
    const entries: [string, unknown][] = [];
    for (const [key, inner] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      const walked = walk(inner, masker);
      if (walked !== DROP && walked !== undefined) entries.push([key, walked]);
    }
    // fromEntries defines own data properties, so a key like `__proto__` cannot reach the prototype.
    return Object.fromEntries(entries);
  }
  return value;
}

function labelMode(choices: SharingChoices): LabelMode {
  return choices.firstNames
    ? { mode: 'first-names', statement: 'Household members appear by first name.' }
    : { mode: 'role-labels', statement: 'Household members appear as Primary and Secondary, not by name.' };
}

const NEVER_SHARED_STATEMENT = `Never shared, whatever the person chose: ${NEVER_SHARED_ITEMS.join('; ')}.`;

/** The envelope around `input.data`, before the byte cap. */
function wrapInEnvelope(input: EnvelopeInput): ToolEnvelope {
  const data = walk(input.data, input.masker) as Record<string, unknown>;
  return {
    data,
    assumptions: input.assumptions.map((line) => sanitizeLeaves(line, input.masker) as string),
    rounding: roundingDescriptor(input.choices.exactDollars),
    labels: labelMode(input.choices),
    withheld: withheldSwitches(input.choices),
    neverShared: { statement: NEVER_SHARED_STATEMENT, items: NEVER_SHARED_ITEMS },
    disclosure: {
      notFinancialAdvice: ONE_LINE_DISCLAIMER,
      professionalReview: INLINE_DISCLAIMER_CLOSING,
      taxSnapshot: TAX_SNAPSHOT_NOTE,
      dataNotInstructions: TOOL_OUTPUT_IS_DATA_NOTE,
    },
    engineVersion: engineVersion(),
    taxTables: taxTableFacts(input.now.getFullYear()),
    dataAsOf: input.freshness,
  };
}

/** Wraps `input` in the envelope, or answers `OUTPUT_TOO_LARGE` naming the sections that made it too big. */
export function buildEnvelope(tool: string, input: EnvelopeInput): ToolResult {
  const envelope = wrapInEnvelope(input);
  const result: ToolResult = {
    ok: true,
    payload: envelope,
    disclosure: {
      assumptions: envelope.assumptions,
      rounding: envelope.rounding.statement,
      framing: `${envelope.disclosure.notFinancialAdvice} ${envelope.disclosure.dataNotInstructions}`,
    },
  };
  const size = checkOutputSize(result);
  if (size.ok) return result;
  const sections = Object.keys(envelope.data);
  return failureResult(
    'OUTPUT_TOO_LARGE',
    `${tool} produced more data than can be sent in one result. ` +
      `Sections present: ${sections.length === 0 ? 'none' : sections.join(', ')}. Ask for fewer sections.`,
  );
}
