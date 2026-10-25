// With no custom domain (the shipped default), index.ts, `maybe_lock_execute_api_endpoint` and the `retivo:webOrigin` handling must each take the no-domain branch.
// Text contract: assertions anchor on the condition and its branch, not on whitespace or line numbers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INFRA = resolve(__dirname, '../../infrastructure');
const read = (rel) => readFileSync(resolve(INFRA, rel), 'utf8');

// Drop whole-line comments so a guard that only survives in a comment does not
// satisfy an assertion.
const stripShellComments = (text) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
const stripTsComments = (text) =>
  text
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

// --- 1. both examples ship empty domains ------------------------------------

for (const stack of ['dev', 'prod']) {
  for (const key of ['domainName', 'apiDomainName']) {
    test(`${stack} example ships retivo:${key} empty`, () => {
      const source = read(`Pulumi.${stack}.yaml.example`);
      assert.match(
        source,
        new RegExp(`^\\s*retivo:${key}:\\s*""\\s*$`, 'm'),
        `Pulumi.${stack}.yaml.example must declare retivo:${key}: "" — deploying without a custom domain is the default`,
      );
    });
  }
}

// --- 2. index.ts: execute-api endpoint is only ever disabled with an API domain

test('index.ts passes disableExecuteApiEndpoint to the API Gateway only when apiDomainName is set, false otherwise', () => {
  const source = stripTsComments(read('index.ts'));
  const start = source.indexOf('createApiGateway({');
  assert.notEqual(start, -1, 'index.ts must call createApiGateway({ ... })');
  const end = source.indexOf('});', start);
  assert.notEqual(end, -1, 'the createApiGateway call must be closed');
  const call = source.slice(start, end);
  assert.match(
    call,
    /disableExecuteApiEndpoint\s*:\s*cfg\.apiDomainName\s*\?\s*cfg\.disableExecuteApiEndpoint\s*:\s*false\b/,
    'disableExecuteApiEndpoint must be `cfg.apiDomainName ? cfg.disableExecuteApiEndpoint : false`',
  );
});

// --- bash helpers ------------------------------------------------------------

const BOOTSTRAP = stripShellComments(read('scripts/bootstrap-stack.sh'));

// Body of a top-level bash function: from its `name() {` line to the first
// line that is just `}`.
function functionBody(source, name) {
  const lines = source.split('\n');
  const startIdx = lines.findIndex((l) => new RegExp(`^${name}\\(\\)\\s*\\{`).test(l));
  assert.notEqual(startIdx, -1, `bootstrap-stack.sh must define ${name}()`);
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex((l) => /^\}\s*$/.test(l));
  assert.notEqual(endIdx, -1, `${name}() must be closed`);
  return rest.slice(0, endIdx).join('\n');
}

// Split the `if <condition>; then ... else ... fi` that starts at the first
// line matching `conditionRe` into its then and else branches. Nested
// if/fi pairs are tracked so only the outer `else` splits.
function ifElseBranches(source, conditionRe) {
  const lines = source.split('\n');
  const startIdx = lines.findIndex((l) => conditionRe.test(l));
  assert.notEqual(startIdx, -1, `no line matches ${conditionRe}`);
  let depth = 0;
  let elseIdx = -1;
  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (/^if\b/.test(line)) depth += 1;
    else if (/^fi\b/.test(line)) {
      depth -= 1;
      if (depth === 0) {
        assert.notEqual(elseIdx, -1, 'the condition must have an else branch');
        return {
          thenBranch: lines.slice(startIdx + 1, elseIdx).join('\n'),
          elseBranch: lines.slice(elseIdx + 1, i).join('\n'),
        };
      }
    } else if (depth === 1 && /^else\b/.test(line)) elseIdx = i;
  }
  assert.fail(`the if starting at ${conditionRe} is never closed`);
  return undefined;
}

// --- 3. bootstrap: no API domain -> no lockdown ------------------------------

test('maybe_lock_execute_api_endpoint returns before disabling execute-api when retivo:apiDomainName is empty', () => {
  const body = functionBody(BOOTSTRAP, 'maybe_lock_execute_api_endpoint');

  assert.match(
    body,
    /api_domain="\$\(\s*pulumi config get retivo:apiDomainName\b/,
    'api_domain must be read from retivo:apiDomainName',
  );

  const guardMatch = body.match(/if \[\[ -z "\$api_domain" \]\]; then([\s\S]*?)\n\s*fi\b/);
  assert.ok(guardMatch, 'the function must test `-z "$api_domain"` for the no-API-domain case');
  assert.match(
    guardMatch[1],
    /^\s*return\b/m,
    'the empty-api_domain branch must return (skip the lockdown)',
  );

  const setMatch = body.match(/pulumi config set retivo:disableExecuteApiEndpoint true\b/);
  assert.ok(setMatch, 'the function is where retivo:disableExecuteApiEndpoint gets set to true');
  assert.ok(
    guardMatch.index + guardMatch[0].length < setMatch.index,
    'the empty-api_domain early return must come before `pulumi config set retivo:disableExecuteApiEndpoint true`',
  );
});

test('nothing outside maybe_lock_execute_api_endpoint sets retivo:disableExecuteApiEndpoint true', () => {
  const body = functionBody(BOOTSTRAP, 'maybe_lock_execute_api_endpoint');
  const outside = BOOTSTRAP.replace(body, '');
  assert.doesNotMatch(
    outside,
    /pulumi config set retivo:disableExecuteApiEndpoint true\b/,
    'only the guarded lockdown function may disable the execute-api endpoint',
  );
});

// --- 4. bootstrap: no custom web domain -> CloudFront address ----------------

test('bootstrap sets retivo:webOrigin to https:// + the cloudfrontDomain output when retivo:domainName is empty', () => {
  assert.match(
    BOOTSTRAP,
    /CF_DOMAIN="\$\(\s*pulumi stack output cloudfrontDomain\b/,
    'CF_DOMAIN must come from the cloudfrontDomain stack output',
  );
  assert.match(
    BOOTSTRAP,
    /CUSTOM_DOMAIN="\$\(\s*pulumi config get retivo:domainName\b/,
    'CUSTOM_DOMAIN must be read from retivo:domainName',
  );

  const { thenBranch, elseBranch } = ifElseBranches(
    BOOTSTRAP,
    /^\s*if \[\[ -n "\$CUSTOM_DOMAIN" \]\]; then\s*$/,
  );

  assert.match(thenBranch, /NEW_ORIGIN="https:\/\/\$\{?CUSTOM_DOMAIN\}?"/);

  const originMatch = elseBranch.match(/NEW_ORIGIN="https:\/\/\$\{?CF_DOMAIN\}?"/);
  assert.ok(originMatch, 'the no-domain branch must set NEW_ORIGIN="https://$CF_DOMAIN"');
  const setMatch = elseBranch.match(/pulumi config set retivo:webOrigin "\$NEW_ORIGIN"/);
  assert.ok(setMatch, 'the no-domain branch must write retivo:webOrigin from NEW_ORIGIN');
  assert.ok(
    originMatch.index < setMatch.index,
    'NEW_ORIGIN must be set to the CloudFront address before it is written to retivo:webOrigin',
  );
  assert.doesNotMatch(
    elseBranch,
    /NEW_ORIGIN="https:\/\/\$\{?CUSTOM_DOMAIN\}?"/,
    'the no-domain branch must not derive the origin from the (empty) custom domain',
  );
});
