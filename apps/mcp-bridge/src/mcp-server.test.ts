import { afterEach, describe, expect, it } from 'vitest';
import {
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_ATTEMPTS,
  PROMPTS,
  TOOL_REGISTRY,
  toMcpPromptDeclaration,
  toMcpToolDeclaration,
  toolResultSchema,
  type PromptEntry,
  type ToolEntry,
} from '@retirement/assistant-protocol';
import { startHarness, type Harness } from './test-support/harness.js';

let h: Harness;
afterEach(async () => {
  await h.close();
});

const ARGS: Record<string, unknown> = { scenarioId: 's1', otherScenarioId: 'b', metric: 'plan_success', baseScenarioId: 's1', overrides: {} };
/** Valid arguments for a registry tool, built from the properties its schema declares. */
function argsFor(entry: ToolEntry): Record<string, unknown> {
  const properties = Object.keys(toMcpToolDeclaration(entry).inputSchema.properties as Record<string, unknown>);
  return Object.fromEntries(properties.map((name) => [name, ARGS[name]]));
}

function errorOf(result: { structuredContent?: Record<string, unknown> }): Record<string, unknown> {
  return (result.structuredContent as { error: Record<string, unknown> }).error;
}

describe('the declared lists', () => {
  it('declares the whole registry right after initialize, with the registry JSON Schemas', async () => {
    h = await startHarness();
    const { tools } = (await h.client.request('tools/list')) as { tools: unknown[] };
    expect(tools).toEqual(TOOL_REGISTRY.map(toMcpToolDeclaration));
  });

  it('identifies itself and promises no list changes', async () => {
    h = await startHarness({ initialize: false });
    const result = (await h.client.initialize()) as { serverInfo: unknown; capabilities: Record<string, unknown> };
    expect(result.serverInfo).toEqual({ name: 'retivo', version: '0.0.0-test' });
    expect(result.capabilities).toEqual({ tools: { listChanged: false }, prompts: { listChanged: false } });
  });

  it('declares the prompt descriptors and serves their messages without the tab', async () => {
    const prompts: PromptEntry[] = [
      { name: 'retivo_plan_review', description: 'Review the plan.', messages: [{ role: 'user', text: 'Review my plan.' }] },
    ];
    h = await startHarness({ prompts });
    expect(((await h.client.request('prompts/list')) as { prompts: unknown[] }).prompts).toEqual(prompts.map(toMcpPromptDeclaration));
    const got = (await h.client.request('prompts/get', { name: 'retivo_plan_review' })) as { messages: unknown[] };
    expect(got.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Review my plan.' } }]);
  });

  it('lists the shipped prompts', async () => {
    h = await startHarness();
    expect(((await h.client.request('prompts/list')) as { prompts: unknown[] }).prompts).toEqual(PROMPTS.map(toMcpPromptDeclaration));
  });

  it('sends no list_changed and keeps the same lists across pairing, calls, tab close and re-pairing', async () => {
    h = await startHarness();
    const listing = async () => [await h.client.request('tools/list'), await h.client.request('prompts/list')];
    const before = await listing();
    const first = await h.pairedTab();
    const call = h.client.callToolRaw('retivo_status');
    const frame = await first.next();
    first.send({ type: 'result', id: frame.id, result: { ok: true, payload: {}, disclosure: {} } });
    await call.response;
    first.close();
    await h.waitForLog('session_ended');
    await h.pairedTab();
    expect(await listing()).toEqual(before);
    const methods = h.client.notifications.map((message) => message.method);
    expect(methods.filter((method) => method?.endsWith('list_changed'))).toEqual([]);
  });
});

describe('NOT_PAIRED', () => {
  it('answers every registry tool with a non-error result holding the grouped code and the Settings card', async () => {
    h = await startHarness();
    for (const entry of TOOL_REGISTRY) {
      const result = await h.client.callTool(entry.name, argsFor(entry));
      expect(result.isError).toBeUndefined();
      const parsed = toolResultSchema.safeParse(result.structuredContent);
      expect(parsed.success).toBe(true);
      const error = errorOf(result);
      expect(error).toMatchObject({ code: 'NOT_PAIRED', state: 'awaiting-code', enterAt: 'https://app.example.com/profile' });
      expect(error.pairingCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
      const text = result.content[0]!.text;
      expect(text).toContain(error.pairingCode as string);
      expect(text).toContain('Settings');
      expect(text).toContain('AI assistants');
    }
  });

  it('returns the same code to two calls in a row', async () => {
    h = await startHarness();
    const first = await h.mintCode();
    expect(await h.mintCode()).toBe(first);
    expect(errorOf(await h.client.callTool('retivo_list_scenarios')).expiresAt).toBe(new Date(h.clock.now() + PAIRING_CODE_TTL_MS).toISOString());
  });

  it('mints a different code after expiry', async () => {
    h = await startHarness();
    const first = await h.mintCode();
    h.clock.advance(PAIRING_CODE_TTL_MS);
    expect(await h.mintCode()).not.toBe(first);
  });

  it('mints a different code once attempts are exhausted', async () => {
    h = await startHarness();
    const first = await h.mintCode();
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i += 1) {
      const tab = await h.newTab();
      await tab.pair(first, { proof: 'c'.repeat(64) });
      await tab.closed;
    }
    expect(await h.mintCode()).not.toBe(first);
  });

  it('mints a different code after a completed session', async () => {
    h = await startHarness();
    const first = await h.mintCode();
    const tab = await h.pairedTab();
    tab.close();
    await h.waitForLog('session_ended');
    const next = await h.client.callTool('retivo_status');
    expect(errorOf(next)).toMatchObject({ code: 'NOT_PAIRED', state: 'awaiting-code' });
    expect(errorOf(next).pairingCode).not.toBe(first);
  });

  it('reports that consent is pending, without any code, between pairing and ready', async () => {
    h = await startHarness();
    const tab = await h.newTab();
    await tab.pair(await h.mintCode());
    const result = await h.client.callTool('retivo_status');
    expect(result.isError).toBeUndefined();
    expect(errorOf(result)).toMatchObject({ code: 'NOT_PAIRED', state: 'awaiting-consent' });
    expect(errorOf(result).pairingCode).toBeUndefined();
    expect(tab.received).toBe(2); // hello and paired; no call frame
  });

  it('rejects arguments that break the registry schema without involving the relay', async () => {
    h = await startHarness();
    const result = await h.client.callTool('retivo_get_scenario', {});
    expect(result.isError).toBe(true);
    expect(h.logs.some((entry) => entry.event === 'tool_not_paired')).toBe(false);
  });
});
