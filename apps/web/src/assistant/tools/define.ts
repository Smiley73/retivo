/**
 * How a tool becomes a dispatcher handler. A tool is a function from validated
 * arguments and a `ToolEnv` to plain data; `toHandler` is the single place that
 * loads the workspace, runs the tool, builds the envelope (sanitizer walk,
 * disclosures, byte cap) and turns a thrown error into a result. Nothing a tool
 * does can reach the wire except through here.
 */
import { TOOL_REGISTRY, failureResult, type ErrorCode, type ToolResult } from '@retirement/assistant-protocol';
import { ZodError } from 'zod';
import { CbpUnconfiguredError, NoPrimaryRetirementError } from '../../lib/balance-projection-runner';
import { friendlyProjectionErrorMessage } from '../../lib/tax-integration';
import type { ToolCallContext, ToolHandler } from '../dispatcher';
import type { ShareView } from '../sharing/view';
import { maskTermsFor } from '../sharing/view';
import { buildMasker, type Masker } from '../sharing/sanitize';
import type { SharingChoices } from '../sharing/switches';
import { buildEnvelope } from './envelope';
import { loadWorkspace, shareSourceOf, type Workspace } from './workspace';

/** What a tool hands back: the data, and the assumptions it relied on. */
interface ToolOutcome {
  data: Record<string, unknown>;
  assumptions?: readonly string[];
}

/** Everything a tool may use; there is no way to reach the store or the consent record around it. */
export interface ToolEnv {
  workspace: Workspace;
  choices: SharingChoices;
  /** Masks the terms a tool must never say. */
  masker: Masker;
  /** The tab's clock for this call. */
  now: Date;
  context: ToolCallContext;
  /** The share view of the whole workspace under the session's choices. */
  view(): ShareView;
}

export type ToolRun = (args: Record<string, unknown>, env: ToolEnv) => Promise<ToolOutcome> | ToolOutcome;

/** Thrown by a tool when the arguments are well-formed but name something that does not exist. */
export class ToolArgsError extends Error {}

/** The codes a tool may answer with on purpose, beyond `INVALID_ARGS` and the generic `INTERNAL`. */
type ToolFailureCode = Extract<
  ErrorCode,
  'INVALID_ARGS' | 'CANCELLED' | 'TOO_MANY_IN_FLIGHT' | 'COMPUTE_CAP_EXCEEDED' | 'INTERNAL'
>;

/**
 * Thrown by a tool to answer with a code of its choosing. The message is the tool's own, so it must be a fixed
 * sentence or text the tool has already sanitized: nothing from a caught error goes in unread.
 */
export class ToolFailure extends Error {
  constructor(
    readonly code: ToolFailureCode,
    message: string,
  ) {
    super(message);
  }
}

/** Said when the plan cannot be projected, for the two runner errors and for a scenario the page's own gates refuse. */
export const PROJECTION_UNAVAILABLE_MESSAGE =
  'This scenario cannot be projected yet. The plan needs a primary household member with a retirement age, at least one active account, and a payout election on any cash balance plan account.';

export interface ToolDefinition {
  name: string;
  run: ToolRun;
}

export function defineTool(name: string, run: ToolRun): ToolDefinition {
  return { name, run };
}

/** `INVALID_ARGS` for a rejected argument, the tool's own code for a `ToolFailure`, `INTERNAL` for anything else, never carrying a message from an unexpected failure. */
function failureFor(tool: string, error: unknown): ToolResult {
  if (error instanceof ToolArgsError) return failureResult('INVALID_ARGS', error.message);
  if (error instanceof ToolFailure) return failureResult(error.code, error.message);
  // The two ways the runner says the plan cannot run; the page words them the same way.
  if (error instanceof NoPrimaryRetirementError || error instanceof CbpUnconfiguredError) {
    return failureResult('INVALID_ARGS', friendlyProjectionErrorMessage(error) ?? PROJECTION_UNAVAILABLE_MESSAGE);
  }
  if (error instanceof ZodError) return failureResult('INVALID_ARGS', `The arguments for ${tool} are not valid.`);
  return failureResult('INTERNAL', `${tool} failed unexpectedly.`);
}

export function toHandler(definition: ToolDefinition): ToolHandler {
  const entry = TOOL_REGISTRY.find((candidate) => candidate.name === definition.name);
  if (entry === undefined) throw new Error(`${definition.name} is not a tool in the registry`);
  return async (rawArgs, context) => {
    try {
      const args = entry.inputSchema.parse(rawArgs) as Record<string, unknown>;
      const workspace = await loadWorkspace();
      const { choices } = context.share.consent;
      const source = shareSourceOf(workspace);
      const masker = buildMasker(maskTermsFor(source, choices));
      const env: ToolEnv = {
        workspace,
        choices,
        masker,
        now: context.now,
        context,
        view: () => context.share.buildView(source),
      };
      const outcome = await definition.run(args, env);
      return buildEnvelope(definition.name, {
        data: outcome.data,
        assumptions: outcome.assumptions ?? [],
        choices,
        masker,
        freshness: workspace.freshness,
        now: context.now,
      });
    } catch (error) {
      return failureFor(definition.name, error);
    }
  };
}
