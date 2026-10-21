/**
 * A minimal JSON-RPC MCP client for tests. The official client package is not a
 * dependency, and speaking the wire directly also lets a test see exactly which
 * messages (list_changed in particular) the bridge sends.
 */

export interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface ToolCallResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export class McpTestClient {
  /** Every message the server sent that is not a response (notifications). */
  readonly notifications: RpcMessage[] = [];
  private nextId = 1;
  private readonly pending = new Map<number | string, (message: RpcMessage) => void>();

  constructor(private readonly write: (message: RpcMessage) => void) {}

  /** Feed every message received from the server here. */
  receive(message: RpcMessage): void {
    const resolve = message.id === undefined ? undefined : this.pending.get(message.id);
    if (resolve !== undefined && message.id !== undefined) {
      this.pending.delete(message.id);
      resolve(message);
    } else if (message.method !== undefined) {
      this.notifications.push(message);
    }
  }

  /** Sends a request and returns the whole response, error included. */
  requestRaw(method: string, params?: Record<string, unknown>): { id: number; response: Promise<RpcMessage> } {
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise<RpcMessage>((resolve) => this.pending.set(id, resolve));
    this.write({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) });
    return { id, response };
  }

  async request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { response } = this.requestRaw(method, params);
    const message = await response;
    if (message.error !== undefined) throw new Error(`${method}: ${message.error.message}`);
    return message.result ?? {};
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, ...(params !== undefined && { params }) });
  }

  async initialize(clientInfo = { name: 'test-agent', version: '9.9.9' }): Promise<Record<string, unknown>> {
    const result = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo,
    });
    this.notify('notifications/initialized');
    return result;
  }

  callToolRaw(name: string, args: Record<string, unknown> = {}, progressToken?: string): { id: number; response: Promise<RpcMessage> } {
    return this.requestRaw('tools/call', {
      name,
      arguments: args,
      ...(progressToken !== undefined && { _meta: { progressToken } }),
    });
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const { response } = this.callToolRaw(name, args);
    const message = await response;
    if (message.error !== undefined) throw new Error(`tools/call ${name}: ${message.error.message}`);
    return message.result as unknown as ToolCallResult;
  }

  cancel(requestId: number): void {
    this.notify('notifications/cancelled', { requestId });
  }
}
