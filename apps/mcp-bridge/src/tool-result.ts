/** Maps the protocol's tool result onto an MCP `tools/call` result. */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { PAIRING_ENTRY_PATH, type ToolResult } from '@retirement/assistant-protocol';

/** Where the person types the code; the protocol's instructions name the page, this names the card. */
const SETTINGS_CARD_HINT = `The page is Retivo's Settings (${PAIRING_ENTRY_PATH}); look for the "AI assistants" card.`;

/**
 * `NOT_PAIRED` is a normal result, not an error: clients tend to summarize or
 * hide errors and the person has to see the code. Every other failure is
 * `isError` with the code and message untouched; a success returns the whole
 * envelope (payload and disclosure) as JSON text and as structured content.
 */
export function toCallToolResult(result: ToolResult): CallToolResult {
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
