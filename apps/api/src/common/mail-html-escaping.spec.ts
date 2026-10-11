/**
 * Regression guard:
 * every `${…}` interpolation inside an HTML mail body (`Html: { Data: … }`
 * on an SES `SendEmailCommand`) anywhere in the API must route through the
 * shared `escapeHtml` helper. A hand-written per-template assertion can only
 * prove today's templates are safe — it can't hold for a mail template
 * written after this test merges. This guard reads every API source file
 * that composes a `SendEmailCommand` as TEXT (the pattern already used for
 * scripts/test/csp-contract.test.mjs, colocated here instead because the
 * check belongs next to the code it guards) and fails loudly the moment a
 * new HTML body interpolates a value that isn't escaped.
 *
 * The sender-file set is discovered by searching for `SendEmailCommand`
 * usage rather than a hardcoded file list, so a future template (e.g.
 * a factor-change notice or a guessing notice) is covered automatically the
 * moment it lands, with no edit to this file.
 *
 * A genuinely constant expression (nothing attacker- or config-controlled)
 * may opt out with an inline marker comment immediately inside the
 * interpolation: `${/* html-escape-exempt: reason *\/ expr}`. Nothing in the
 * repository uses it today — see the second test below, which asserts that.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const API_SRC_ROOT = resolve(__dirname, '..'); // apps/api/src

const EXEMPT_MARKER_RE = /^\/\*\s*html-escape-exempt:.*?\*\/\s*/s;

/** Recursively list every `.ts` source file under `dir`, excluding spec files. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every API source file that composes an SES `SendEmailCommand` — the
 *  mechanical discovery rule, so a new sender file is
 *  covered with no edit here. */
function findMailSenderFiles(): string[] {
  return listSourceFiles(API_SRC_ROOT).filter((f) =>
    readFileSync(f, 'utf8').includes('SendEmailCommand'),
  );
}

/** The balanced-brace substring of `source` starting at `openBraceIndex`
 *  (the index of the `{` itself) through its matching `}`, inclusive. */
function extractBalanced(source: string, openBraceIndex: number): string {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(openBraceIndex, i + 1);
    }
  }
  throw new Error('Unbalanced braces while scanning for an `Html: { … }` block.');
}

/** Every `Html: { Data: … }` block's raw text in `source` (there may be more
 *  than one per file — most sender files have several `sendXMail` methods). */
function findHtmlBlocks(source: string): string[] {
  const blocks: string[] = [];
  const re = /\bHtml:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const openBrace = m.index + m[0].length - 1;
    blocks.push(extractBalanced(source, openBrace));
  }
  return blocks;
}

/** The raw text of the `Data:` value inside an `Html: { … }` block — from
 *  just after `Data:` through the top-level comma or the block's own closing
 *  `}`. Tracks whether each character is inside template-literal text (as
 *  opposed to code) so a comma or brace that's part of the HTML prose —
 *  `` `If you didn't request this, ignore it.` `` is exactly this shape —
 *  doesn't cut the expression short; only a `${…}` re-enters code. */
function extractDataExpression(block: string): string {
  const m = /\bData:\s*/.exec(block);
  if (!m) {
    throw new Error('An `Html: { … }` block has no `Data:` key to check the shape of.');
  }
  const start = m.index + m[0].length;
  type Frame = { mode: 'code' | 'template'; depth: number };
  const stack: Frame[] = [{ mode: 'code', depth: 0 }];
  let i = start;
  for (; i < block.length; i++) {
    const top = stack[stack.length - 1];
    const c = block[i];
    if (top.mode === 'template') {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '`') {
        stack.pop();
        continue;
      }
      if (c === '$' && block[i + 1] === '{') {
        stack.push({ mode: 'code', depth: 0 });
        i++; // consume the '{' along with the '$'
        continue;
      }
      continue; // ordinary template text — commas/braces here don't count
    }
    // top.mode === 'code'
    if (c === '`') {
      stack.push({ mode: 'template', depth: 0 });
    } else if (c === '(' || c === '[' || c === '{') {
      top.depth++;
    } else if (c === ')' || c === ']') {
      top.depth--;
    } else if (c === '}') {
      if (top.depth === 0) {
        if (stack.length === 1) break; // the Html block's own closing brace
        stack.pop(); // close a `${…}`, back to its enclosing template text
      } else {
        top.depth--;
      }
    } else if (c === ',' && top.depth === 0 && stack.length === 1) {
      break;
    }
  }
  return block.slice(start, i).trim();
}

/** True when `expr` is composed entirely of template-literal string(s)
 *  joined by `+` — the only shape `findInterpolations` can read `${…}`
 *  values out of. A bare identifier, a helper-function call, or a ternary
 *  fails this even though it may carry its own unescaped `${…}` out of
 *  sight of this file (a variable or a `private renderX(): string` helper
 *  composing the body elsewhere). */
function isTemplateLiteralChain(expr: string): boolean {
  let i = 0;
  const n = expr.length;
  const skipWs = () => {
    while (i < n && /\s/.test(expr[i])) i++;
  };
  const consumeTemplateLiteral = (): boolean => {
    if (expr[i] !== '`') return false;
    i++;
    while (i < n) {
      const c = expr[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        return true;
      }
      if (c === '$' && expr[i + 1] === '{') {
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          if (expr[i] === '{') depth++;
          else if (expr[i] === '}') depth--;
          i++;
        }
        continue;
      }
      i++;
    }
    return false; // unterminated template literal
  };
  skipWs();
  if (!consumeTemplateLiteral()) return false;
  skipWs();
  while (i < n && expr[i] === '+') {
    i++;
    skipWs();
    if (!consumeTemplateLiteral()) return false;
    skipWs();
  }
  return i === n;
}

/** Every `${ … }` interpolation's raw expression text inside `block`,
 *  balanced on nested braces so `${escapeHtml(x)}` extracts the whole call
 *  (there are none nested in practice, but the scan doesn't assume that). */
function findInterpolations(block: string): string[] {
  const exprs: string[] = [];
  const re = /\$\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const start = m.index + 2;
    let depth = 1;
    let i = start;
    for (; i < block.length; i++) {
      if (block[i] === '{') depth++;
      else if (block[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    exprs.push(block.slice(start, i));
  }
  return exprs;
}

/** An interpolation is safe when it is wrapped in `escapeHtml(...)` or
 *  carries the exemption marker for a genuinely constant expression. */
function isSafeInterpolation(expr: string): boolean {
  const trimmed = expr.trim();
  if (EXEMPT_MARKER_RE.test(trimmed)) return true;
  return /^escapeHtml\(/.test(trimmed) && trimmed.endsWith(')');
}

/** Every unsafe interpolation across every HTML mail body in `source`,
 *  formatted for a failure message. Also fails loudly — rather than
 *  silently finding zero interpolations to check — when a `Data:` value
 *  isn't composed inline as a template literal (or a `+` chain of them),
 *  since that shape is the only one this file can read `${…}` values out of. */
function unsafeInterpolations(source: string): string[] {
  const failures: string[] = [];
  for (const block of findHtmlBlocks(source)) {
    const dataExpr = extractDataExpression(block);
    if (!isTemplateLiteralChain(dataExpr)) {
      failures.push(
        `Html.Data is not composed inline as a template literal (found: ${dataExpr}) — ` +
          'compose the HTML mail body inline as a template literal, or a `+` chain of ' +
          'template literals, so this guard can see its interpolations',
      );
      continue;
    }
    for (const expr of findInterpolations(block)) {
      if (!isSafeInterpolation(expr)) failures.push(expr.trim());
    }
  }
  return failures;
}

describe('HTML mail-body escaping regression guard', () => {
  it('the discovery rule finds sender files and at least one HTML body to check (guard against a silent no-op)', () => {
    const files = findMailSenderFiles();
    expect(files.length).toBeGreaterThan(0);
    const totalBlocks = files.reduce(
      (n, f) => n + findHtmlBlocks(readFileSync(f, 'utf8')).length,
      0,
    );
    expect(totalBlocks).toBeGreaterThan(0);
  });

  it('every interpolated value in every HTML mail body across the API is escaped', () => {
    const failures: string[] = [];
    for (const file of findMailSenderFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const expr of unsafeInterpolations(source)) {
        failures.push(`${file}: unescaped interpolation \${${expr}} in an HTML mail body`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('nothing in the repository uses the exemption marker today', () => {
    // Asserted separately from the main check above so a future exemption
    // is visible in a diff here, not silently absorbed by "no failures".
    for (const file of findMailSenderFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const block of findHtmlBlocks(source)) {
        for (const expr of findInterpolations(block)) {
          expect(EXEMPT_MARKER_RE.test(expr.trim())).toBe(false);
        }
      }
    }
  });

  // --- pin the checker's own behavior against synthetic sources, not just
  // today's clean tree (a tree that is clean forever tells you nothing about
  // whether the checker actually checks anything) ---

  it('catches a raw, unescaped interpolation', () => {
    const synthetic = `
      await this.ses.send(new SendEmailCommand({
        Message: {
          Body: {
            Html: {
              Data: \`<strong>\${rawValue}</strong>\`,
            },
          },
        },
      }));
    `;
    expect(unsafeInterpolations(synthetic)).toEqual(['rawValue']);
  });

  it('accepts an interpolation routed through escapeHtml(...)', () => {
    const synthetic = `
      Html: {
        Data: \`<strong>\${escapeHtml(rawValue)}</strong>\`,
      },
    `;
    expect(unsafeInterpolations(synthetic)).toEqual([]);
  });

  it('accepts an interpolation carrying the annotated exemption marker', () => {
    const synthetic = `
      Html: {
        Data: \`<p>\${/* html-escape-exempt: literal, not derived from any input */ 'static'}</p>\`,
      },
    `;
    expect(unsafeInterpolations(synthetic)).toEqual([]);
  });

  it('checks every Html.Data block in a file with multiple mail-sending methods', () => {
    const synthetic = `
      function sendA() {
        Html: { Data: \`<p>\${escapeHtml(a)}</p>\` },
      }
      function sendB() {
        Html: { Data: \`<p>\${b}</p>\` },
      }
    `;
    expect(unsafeInterpolations(synthetic)).toEqual(['b']);
  });

  it('a Text.Data or Subject.Data interpolation outside any Html: { … } block is not flagged', () => {
    // Escaping Text/Subject would be a regression —
    // this guard must never reach into either.
    const synthetic = `
      Message: {
        Subject: { Data: \`Approve new account: \${applicantLabel}\` },
        Body: {
          Text: { Data: \`Hi \${firstName},\` },
          Html: { Data: \`<p>\${escapeHtml(firstName)}</p>\` },
        },
      },
    `;
    expect(unsafeInterpolations(synthetic)).toEqual([]);
  });

  it('fails when the HTML body is composed into a variable instead of inline (its interpolations are invisible to this guard)', () => {
    const synthetic = `
      const html = \`<p>Hi \${firstName}</p>\`;
      await this.ses.send(new SendEmailCommand({
        Message: {
          Body: {
            Html: { Data: html },
          },
        },
      }));
    `;
    expect(unsafeInterpolations(synthetic)).toEqual([
      'Html.Data is not composed inline as a template literal (found: html) — ' +
        'compose the HTML mail body inline as a template literal, or a `+` chain of ' +
        'template literals, so this guard can see its interpolations',
    ]);
  });

  it('fails when the HTML body is composed by a helper-function call instead of inline', () => {
    const synthetic = `
      Html: { Data: renderNotice(newEmail) },
    `;
    const failures = unsafeInterpolations(synthetic);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('renderNotice(newEmail)');
    expect(failures[0]).toContain('compose the HTML mail body inline as a template literal');
  });

  it('accepts a Data value composed of multiple template literals joined by `+`, matching the shape used by every current sender', () => {
    const synthetic = `
      Html: {
        Data:
          \`<p>Someone tried to sign in as \` +
          \`<strong>\${escapeHtml(label)}</strong>.</p>\`,
      },
    `;
    expect(unsafeInterpolations(synthetic)).toEqual([]);
  });
});
