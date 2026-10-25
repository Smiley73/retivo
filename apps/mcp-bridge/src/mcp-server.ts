/**
 * The MCP face of the bridge: the protocol package's whole tool registry and
 * prompts, declared once before the server connects and never changed, so no
 * `list_changed` notification is ever sent and nothing about tools comes from
 * the tab. Each tool hands its call to the relay.
 */
import { McpServer, fromJsonSchema, type CallToolResult, type ProgressToken } from '@modelcontextprotocol/server';
import {
  PAIRING_ENTRY_PATH,
  PROMPTS,
  TOOL_REGISTRY,
  toMcpPromptDeclaration,
  toMcpToolDeclaration,
  type PromptEntry,
  type ToolEntry,
  type ToolResult,
} from '@retirement/assistant-protocol';
import type { Relay } from './relay.js';

export interface McpServerDeps {
  relay: Relay;
  bridgeVersion: string;
  /** Overridable for tests; the registries by default. */
  tools?: readonly ToolEntry[];
  prompts?: readonly PromptEntry[];
}

/** Where the person types the code; the protocol's instructions name the page, this names the card. */
const SETTINGS_CARD_HINT = `The page is Retivo's Settings (${PAIRING_ENTRY_PATH}); look for the "AI assistants" card.`;

/**
 * Maps the protocol's tool result onto an MCP `tools/call` result. `NOT_PAIRED` is a normal result, not an
 * error: clients tend to summarize or hide errors and the person has to see the code.
 */
function toCallToolResult(result: ToolResult): CallToolResult {
  const structuredContent = result as unknown as Record<string, unknown>;
  if (result.ok) {
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent };
  }
  const { error } = result;
  if (error.code === 'NOT_PAIRED') {
    const hint = error.state === 'awaiting-code' ? `\n\n${SETTINGS_CARD_HINT}` : '';
    return { content: [{ type: 'text', text: `${error.instructions}${hint}` }], structuredContent };
  }
  return { content: [{ type: 'text', text: `${error.code}: ${error.message}` }], structuredContent, isError: true };
}

/** Progress must increase on every notification; a tab that repeats a fraction still gets a monotonic stream. */
function progressNotifier(
  token: ProgressToken,
  notify: (notification: { method: 'notifications/progress'; params: Record<string, unknown> }) => Promise<void>,
): (progress: { fraction?: number; message?: string }) => void {
  let last = 0;
  return ({ fraction, message }) => {
    const progress = Math.max(fraction === undefined ? last : fraction * 100, last + 0.01);
    last = progress;
    void notify({
      method: 'notifications/progress',
      params: { progressToken: token, progress, ...(progress <= 100 && { total: 100 }), ...(message !== undefined && { message }) },
    }).catch(() => undefined);
  };
}

export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer(
    { name: 'retivo', version: deps.bridgeVersion },
    { capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } } },
  );
  for (const entry of deps.tools ?? TOOL_REGISTRY) {
    const declaration = toMcpToolDeclaration(entry);
    server.registerTool(
      entry.name,
      {
        description: declaration.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(declaration.inputSchema),
        outputSchema: fromJsonSchema(declaration.outputSchema),
      },
      async (args, ctx) => {
        const token = ctx.mcpReq._meta?.progressToken;
        const result = await deps.relay.callTool(entry, args, {
          signal: ctx.mcpReq.signal,
          ...(token !== undefined && { onProgress: progressNotifier(token, ctx.mcpReq.notify) }),
        });
        return toCallToolResult(result);
      },
    );
  }
  for (const prompt of deps.prompts ?? PROMPTS) {
    const declaration = toMcpPromptDeclaration(prompt);
    server.registerPrompt(prompt.name, { description: declaration.description }, () => ({
      messages: prompt.messages.map((message) => ({ role: message.role, content: { type: 'text' as const, text: message.text } })),
    }));
  }
  return server;
}
