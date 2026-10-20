/**
 * The MCP face of the bridge: the protocol package's whole tool registry and
 * prompts, declared once before the server connects and never changed, so no
 * `list_changed` notification is ever sent and nothing about tools comes from
 * the tab. Each tool hands its call to the relay.
 */
import { McpServer, fromJsonSchema, type ProgressToken } from '@modelcontextprotocol/server';
import {
  PROMPTS,
  TOOL_REGISTRY,
  toMcpPromptDeclaration,
  toMcpToolDeclaration,
  type PromptEntry,
  type ToolEntry,
} from '@retirement/assistant-protocol';
import type { Relay } from './relay.js';
import { toCallToolResult } from './tool-result.js';

export interface McpServerDeps {
  relay: Relay;
  bridgeVersion: string;
  /** Overridable for tests; the registries by default. */
  tools?: readonly ToolEntry[];
  prompts?: readonly PromptEntry[];
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
