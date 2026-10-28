/**
 * Pins the AI assistant docs to the code where drift would mislead: the tool table,
 * the never-shareable list, the consent switches and their defaults, the port, the
 * guide's links and the browser matrix. It reads the Markdown the way
 * `favicon.test.ts` reads its sources. It cannot tell whether the prose around a
 * pinned token is right (a switch described with the opposite default in a
 * sentence, say): that stays with the reviewer, who reads it against the
 * session, sharing and idle tests.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BRIDGE_PORT, PROMPTS, TOOL_REGISTRY } from '@retirement/assistant-protocol';
import { describe, expect, it } from 'vitest';
import * as classifications from './sharing/classification';
import type { Classification } from './sharing/classification';
import { FORBIDDEN_KEYS } from './sharing/scrub';
import { GENEROUS_DEFAULTS_STATEMENT, MODEL_PROVIDER_STATEMENT, NEVER_SHARED_ITEMS } from './sharing/sentences';
import { ANALYSIS_TOOLS_STATEMENT, CONSENT_SWITCHES } from './sharing/switches';

const here = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(here, '../../../../docs');
const guidePath = join(docsDir, 'ai-assistants.md');
const guide = readFileSync(guidePath, 'utf8');
const security = readFileSync(join(docsDir, 'security.md'), 'utf8');

/** The text under a `##` heading, subsections included, up to the next `##` heading. */
function section(markdown: string, title: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line === `## ${title}`);
  if (start === -1) throw new Error(`No "## ${title}" section`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

/** Collapses line breaks and drops bold markers, so a sentence wrapped or emphasised in the Markdown still matches. */
const flat = (text: string): string => text.replace(/\*\*/g, '').replace(/\s+/g, ' ');

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const match = !fenced && /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (match) slugs.add(slug(match[1]!));
  }
  return slugs;
}

function tableCells(row: string): string[] {
  return row
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function neverShareableFields(): Set<string> {
  const found = new Set<string>();
  const visit = (key: string, classification: Classification): void => {
    if (classification.kind === 'never') found.add(key);
    else if (classification.kind === 'object') for (const [inner, field] of Object.entries(classification.fields)) visit(inner, field);
    else if (classification.kind === 'array') visit(key, classification.item);
    else if (classification.kind === 'record') visit(key, classification.value);
    else if (classification.kind === 'gated') visit(key, classification.shape);
  };
  for (const [name, map] of Object.entries(classifications)) {
    if (!name.endsWith('_CLASSIFICATION')) continue;
    for (const [key, field] of Object.entries(map as Record<string, Classification>)) visit(key, field);
  }
  return found;
}

describe('docs/ai-assistants.md tool table', () => {
  const tools = section(guide, 'Tools and the prompt');
  const tableNames = [...tools.matchAll(/^\| `(retivo_[a-z_]+)` \|/gm)].map((match) => match[1]!);

  it('has a row for every registry tool and for nothing else', () => {
    expect([...tableNames].sort()).toEqual(TOOL_REGISTRY.map((entry) => entry.name).sort());
  });

  it('names every shipped prompt outside the tool table', () => {
    for (const prompt of PROMPTS) {
      expect(tools, prompt.name).toContain(`\`${prompt.name}\``);
      expect(tableNames, prompt.name).not.toContain(prompt.name);
    }
  });
});

describe('docs/security.md "AI assistants" section', () => {
  const assistants = section(security, 'AI assistants');

  it('lists every never-shareable field the field model and the final scrub name', () => {
    const fields = new Set([...neverShareableFields(), ...FORBIDDEN_KEYS]);
    expect(fields.size).toBeGreaterThan(0);
    for (const field of fields) expect(assistants, field).toContain(`\`${field}\``);
  });

  it('carries each never-shared item the consent dialog lists', () => {
    for (const item of NEVER_SHARED_ITEMS) expect(assistants.toLowerCase(), item).toContain(item.toLowerCase());
  });
});

describe('the data-egress statement', () => {
  it('reads the same in the guide, the security section and the consent dialog sentences', () => {
    for (const [name, text] of [
      ['the guide', guide],
      ['the security section', section(security, 'AI assistants')],
    ] as const) {
      const normalized = flat(text);
      expect(normalized, name).toContain(MODEL_PROVIDER_STATEMENT);
      expect(normalized, name).toContain(GENEROUS_DEFAULTS_STATEMENT);
    }
  });
});

describe('the analysis statement', () => {
  it('reads the same in the guide and the security section as in the consent dialog and the refused answers', () => {
    for (const [name, text] of [
      ['the guide', guide],
      ['the security section', section(security, 'AI assistants')],
    ] as const) {
      expect(flat(text), name).toContain(ANALYSIS_TOOLS_STATEMENT);
    }
  });
});

describe('the consent switches in the guide', () => {
  const consent = section(guide, 'Pair and consent');
  const rows = consent.split('\n').filter((line) => line.startsWith('| **'));

  it('names every switch with its default', () => {
    for (const definition of CONSENT_SWITCHES) {
      const row = rows.find((line) => tableCells(line)[0] === `**${definition.label}**`);
      expect(row, definition.label).toBeDefined();
      expect(tableCells(row!)[1], definition.label).toBe(definition.defaultOn ? 'On' : 'Off');
    }
  });

  it('has no switch the dialog lacks', () => {
    expect(rows.map((line) => tableCells(line)[0]!.replace(/\*\*/g, '')).sort()).toEqual(
      CONSENT_SWITCHES.map((definition) => definition.label).sort(),
    );
  });
});

describe('the bridge port in the docs', () => {
  it('is the protocol default wherever the guide and the security section state one', () => {
    for (const [name, text] of [
      ['the guide', guide],
      ['the security section', section(security, 'AI assistants')],
    ] as const) {
      const ports = [...text.matchAll(/\bport\s+`?(\d{4,5})`?/gi)].map((match) => Number(match[1]));
      expect(ports.length, name).toBeGreaterThan(0);
      for (const port of ports) expect(port, name).toBe(DEFAULT_BRIDGE_PORT);
    }
  });
});

describe('the guide’s relative links', () => {
  const links = [...guide.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]!).filter((href) => !/^[a-z]+:/i.test(href));

  it('has some links to check', () => {
    expect(links.length).toBeGreaterThan(0);
  });

  it('resolve to a file and, with a fragment, to a heading in it', () => {
    for (const href of links) {
      const [file = '', fragment] = href.split('#');
      const target = file === '' ? guidePath : resolve(docsDir, file);
      expect(existsSync(target), href).toBe(true);
      if (fragment !== undefined) {
        expect(headingSlugs(readFileSync(target, 'utf8')).has(fragment), href).toBe(true);
      }
    }
  });
});

describe('the browser matrix', () => {
  const matrix = section(guide, 'Browser support');
  const verifiedOrNot = (cell: string): boolean => /^not verified$/i.test(cell) || (/\d{4}-\d{2}-\d{2}/.test(cell) && /\d+(\.\d+)*/.test(cell));

  it('has a row for each browser, each with a version and date or "not verified"', () => {
    for (const browser of ['Chrome', 'Edge', 'Firefox', 'Brave', 'Safari']) {
      const row = matrix.split('\n').find((line) => line.startsWith(`| **${browser}** |`));
      expect(row, browser).toBeDefined();
      expect(verifiedOrNot(tableCells(row!)[2]!), browser).toBe(true);
    }
  });

  it('records each assistant as verified with a version and date, or as not verified', () => {
    for (const assistant of ['Claude Code', 'Codex']) {
      const row = guide.split('\n').find((line) => line.startsWith(`| ${assistant} |`));
      expect(row, assistant).toBeDefined();
      expect(verifiedOrNot(tableCells(row!).at(-1)!), assistant).toBe(true);
    }
  });
});
