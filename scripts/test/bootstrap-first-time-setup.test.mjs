// Contract for bootstrap-stack.sh's first-time setup
// (infrastructure/scripts/lib/first-time-setup.sh): on a fresh account it
// creates the hardened state bucket, a per-stack passphrase in SSM and the
// Pulumi stack; a re-run creates nothing and never replaces the stored
// passphrase; and deploy-stack.sh's setup_pulumi_backend never creates any of
// them.
//
// Runs the real shell functions under bash with stub `aws` and `pulumi`
// executables first on PATH. The stubs keep their state in files under a temp
// dir (buckets, SSM parameters, the stack's state object) so a second run sees
// what the first created, and log every call with its arguments to
// calls.log. INFRA_DIR is a temp dir with its own Pulumi.<stack>.yaml and
// .deploy.env: setup_pulumi_backend appends to .deploy.env, so pointing at the
// real infrastructure/ would change the developer's file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(__dirname, '../../infrastructure/scripts/lib');
const BUCKET = 'retivo-pulumi-state-111122223333';
const STATE_KEY = '.pulumi/stacks/retivo/dev.json';
const PP_NAME = '/retivo-pulumi/dev/passphrase';

const AWS_STUB = `#!/usr/bin/env bash
ST="$STUB_DIR"
echo "aws $*" >> "$ST/calls.log"
flag() { local want="$1"; shift; while [[ $# -gt 0 ]]; do if [[ "$1" == "$want" ]]; then echo "$2"; return; fi; shift; done; }
fname() { echo "$1" | tr '/' '_'; }
svc="$1"; op="$2"; shift 2
case "$svc $op" in
  "sts get-caller-identity") echo 111122223333 ;;
  "s3api head-bucket")
    if [[ -e "$ST/forbidden" ]]; then echo "An error occurred (403) when calling the HeadBucket operation: Forbidden" >&2; exit 254; fi
    [[ -e "$ST/buckets/$(flag --bucket "$@")" ]] && exit 0
    echo "An error occurred (404) when calling the HeadBucket operation: Not Found" >&2; exit 254 ;;
  "s3api create-bucket")
    if [[ "$(flag --region "$@")" != "us-east-1" && "$*" != *"LocationConstraint=$(flag --region "$@")"* ]]; then
      echo "An error occurred (IllegalLocationConstraintException)" >&2; exit 254
    fi
    touch "$ST/buckets/$(flag --bucket "$@")" ;;
  "s3api head-object")
    [[ -e "$ST/objects/$(fname "$(flag --key "$@")")" ]] && exit 0
    echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2; exit 254 ;;
  "s3api put-"*) ;;
  "ssm get-parameter")
    f="$ST/ssm/$(fname "$(flag --name "$@")")"
    if [[ -e "$f" ]]; then cat "$f"; echo; exit 0; fi
    echo "An error occurred (ParameterNotFound) when calling the GetParameter operation" >&2; exit 254 ;;
  "ssm put-parameter")
    f="$ST/ssm/$(fname "$(flag --name "$@")")"
    if [[ "$*" == *"--overwrite"* || -e "$f" ]]; then echo "An error occurred (ParameterAlreadyExists)" >&2; exit 254; fi
    printf '%s' "$(flag --value "$@")" > "$f" ;;
  *) echo "aws stub: unhandled $svc $op" >&2; exit 99 ;;
esac
`;

const PULUMI_STUB = `#!/usr/bin/env bash
ST="$STUB_DIR"
echo "pulumi $*" >> "$ST/calls.log"
obj="$ST/objects/.pulumi_stacks_retivo_dev.json"
case "$1 $2" in
  "login "*) ;;
  "stack init")
    [[ -e "$obj" ]] && { echo "error: stack already exists" >&2; exit 1; }
    printf '%s' "$PULUMI_CONFIG_PASSPHRASE" > "$obj"
    printf '%s' "$PULUMI_CONFIG_PASSPHRASE" > "$ST/init-passphrase"
    echo "encryptionsalt: v1:stub" >> "$INFRA_DIR/Pulumi.dev.yaml" ;;
  "stack export")
    [[ "$(cat "$obj")" == "$PULUMI_CONFIG_PASSPHRASE" ]] || { echo "error: incorrect passphrase" >&2; exit 1; } ;;
  *) echo "pulumi stub: unhandled $*" >&2; exit 99 ;;
esac
`;

/** A fresh stub account + infra dir. `yaml` is the stack file's content. */
function makeWorld({ yaml = 'config:\n  aws:region: us-west-2\n' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'first-time-setup-'));
  const world = { dir, st: join(dir, 'st'), infra: join(dir, 'infra'), bin: join(dir, 'bin') };
  for (const d of [world.st, world.infra, world.bin]) mkdirSync(d);
  for (const d of ['buckets', 'objects', 'ssm']) mkdirSync(join(world.st, d));
  writeFileSync(join(world.infra, 'Pulumi.yaml'), 'name: retivo\nruntime: nodejs\n');
  if (yaml !== null) writeFileSync(join(world.infra, 'Pulumi.dev.yaml'), yaml);
  for (const [name, body] of [['aws', AWS_STUB], ['pulumi', PULUMI_STUB]]) {
    writeFileSync(join(world.bin, name), body);
    chmodSync(join(world.bin, name), 0o755);
  }
  return world;
}

/** Run `body` under bash with the setup libs sourced and the stubs on PATH. */
function run(world, body, extraEnv = {}) {
  const res = spawnSync(
    'bash',
    ['-c', `set -euo pipefail; source "${LIB}/deploy-common.sh"; source "${LIB}/first-time-setup.sh"; ${body}`],
    {
      encoding: 'utf8',
      env: {
        PATH: `${world.bin}:${process.env.PATH}`,
        HOME: world.dir,
        STUB_DIR: world.st,
        INFRA_DIR: world.infra,
        ...extraEnv,
      },
    },
  );
  const calls = existsSync(join(world.st, 'calls.log'))
    ? readFileSync(join(world.st, 'calls.log'), 'utf8').split('\n').filter(Boolean)
    : [];
  writeFileSync(join(world.st, 'calls.log'), ''); // a re-run starts a fresh log
  return { ...res, calls };
}

const setup = (world, extraEnv) => run(world, 'first_time_setup dev; print_passphrase_notice', extraEnv);
const has = (calls, text) => calls.filter((c) => c.includes(text));
const stored = (world) => readFileSync(join(world.st, 'ssm', '_retivo-pulumi_dev_passphrase'), 'utf8');
const initPassphrase = (world) => readFileSync(join(world.st, 'init-passphrase'), 'utf8');
/** Calls that create or change anything. */
const mutations = (calls) =>
  calls.filter((c) => /create-bucket|put-bucket|put-public|put-parameter|stack init/.test(c));

test('fresh bring-up creates the hardened bucket, one passphrase and the stack', () => {
  const w = makeWorld();
  const r = setup(w);
  assert.equal(r.status, 0, r.stderr);

  const create = has(r.calls, 'create-bucket');
  assert.equal(create.length, 1);
  assert.match(create[0], new RegExp(`--bucket ${BUCKET} --region us-west-2 --create-bucket-configuration LocationConstraint=us-west-2`));
  for (const call of ['put-bucket-versioning', 'put-bucket-encryption', 'put-public-access-block', 'put-bucket-lifecycle-configuration', 'put-bucket-policy']) {
    assert.equal(has(r.calls, `s3api ${call} --bucket ${BUCKET}`).length, 1, call);
  }
  assert.match(has(r.calls, 'put-bucket-lifecycle-configuration')[0], /"NoncurrentDays":90/);
  assert.match(has(r.calls, 'put-bucket-policy')[0], /aws:SecureTransport/);
  assert.match(readFileSync(join(w.infra, '.deploy.env'), 'utf8'), new RegExp(`s3://${BUCKET}\\?region=us-west-2`));

  const put = has(r.calls, 'put-parameter');
  assert.equal(put.length, 1);
  assert.match(put[0], new RegExp(`--name ${PP_NAME} --type SecureString `));
  assert.match(put[0], /--region us-west-2/);
  assert.doesNotMatch(put[0], /--overwrite/);

  const secret = stored(w);
  assert.ok(secret.length >= 32);
  assert.equal(initPassphrase(w), secret, 'the stack is inited with the stored value');
  assert.ok(r.calls.indexOf(put[0]) < r.calls.findIndex((c) => c.includes('stack init')), 'stored before init');
  assert.equal(has(r.calls, 'stack init dev --secrets-provider passphrase').length, 1);
  assert.equal(has(r.calls, 'stack export --stack dev --show-secrets').length, 1);
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), 'the passphrase is never printed');
  assert.match(r.stdout, /AWS account 111122223333, region us-west-2/);
});

test('re-running over a finished bring-up creates nothing and keeps the stored passphrase', () => {
  const w = makeWorld();
  assert.equal(setup(w).status, 0);
  const before = stored(w);

  const r = setup(w);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(has(r.calls, 'create-bucket'), []);
  assert.deepEqual(has(r.calls, 'put-parameter'), []);
  assert.deepEqual(has(r.calls, 'stack init'), []);
  assert.equal(has(r.calls, 'put-bucket-versioning').length, 1, 'hardening is re-applied');
  assert.equal(stored(w), before);
  assert.equal(initPassphrase(w), before);
});

test('an exported passphrase on a fresh account is used as given and stores nothing', () => {
  const w = makeWorld();
  const exported = 'exported-pass-phrase-value';
  const r = setup(w, { PULUMI_CONFIG_PASSPHRASE: exported });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(has(r.calls, 'put-parameter'), []);
  assert.equal(existsSync(join(w.st, 'ssm', '_retivo-pulumi_dev_passphrase')), false);
  assert.equal(initPassphrase(w), exported);
  assert.equal(has(r.calls, 'stack init').length, 1);
  assert.match(r.stdout, /Keep exporting the same value for every later bootstrap and deploy/);
  assert.ok(!r.stdout.includes(exported) && !r.stderr.includes(exported));
});

test('existing state with no passphrase anywhere is refused before anything changes', () => {
  const w = makeWorld();
  writeFileSync(join(w.st, 'buckets', BUCKET), '');
  writeFileSync(join(w.st, 'objects', STATE_KEY.replace(/\//g, '_')), 'old');
  const r = setup(w);
  assert.notEqual(r.status, 0);
  assert.deepEqual(mutations(r.calls), []);
  assert.match(r.stderr, /s3:\/\/retivo-pulumi-state-111122223333\/\.pulumi\/stacks\/retivo\/dev\.json already exists/);
  assert.match(r.stderr, /passphrase is missing/);
  assert.match(r.stderr, /\/retivo-pulumi\/dev\/passphrase/);
});

test('a trailing slash on the backend URL still finds existing state at the bucket root', () => {
  const w = makeWorld();
  writeFileSync(join(w.st, 'buckets', BUCKET), '');
  writeFileSync(join(w.st, 'objects', STATE_KEY.replace(/\//g, '_')), 'old');
  writeFileSync(join(w.infra, '.deploy.env'), `PULUMI_BACKEND_URL=s3://${BUCKET}/?region=us-west-2\n`);
  const r = setup(w);
  assert.notEqual(r.status, 0);
  assert.deepEqual(mutations(r.calls), []);
  assert.match(r.stderr, /s3:\/\/retivo-pulumi-state-111122223333\/\.pulumi\/stacks\/retivo\/dev\.json already exists/);
});

test('a prefixed backend URL with a trailing slash looks up the prefixed state key', () => {
  const w = makeWorld();
  writeFileSync(join(w.st, 'buckets', BUCKET), '');
  writeFileSync(join(w.st, 'objects', `team_${STATE_KEY.replace(/\//g, '_')}`), 'old');
  writeFileSync(join(w.infra, '.deploy.env'), `PULUMI_BACKEND_URL=s3://${BUCKET}/team/?region=us-west-2\n`);
  const r = setup(w);
  assert.notEqual(r.status, 0);
  assert.deepEqual(mutations(r.calls), []);
  assert.match(r.stderr, /s3:\/\/retivo-pulumi-state-111122223333\/team\/\.pulumi\/stacks\/retivo\/dev\.json already exists/);
});

test('an existing bucket other than the derived one is not re-hardened', () => {
  const w = makeWorld();
  writeFileSync(join(w.st, 'buckets', 'shared-bucket'), '');
  writeFileSync(join(w.infra, '.deploy.env'), 'PULUMI_BACKEND_URL=s3://shared-bucket/some/prefix?region=us-west-2\n');
  const r = setup(w);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(has(r.calls, 'put-bucket'), []);
  assert.deepEqual(has(r.calls, 'put-public'), []);
  assert.deepEqual(has(r.calls, 'create-bucket'), []);
  assert.equal(has(r.calls, 'stack init').length, 1);
});

test('a leftover encryptionsalt on a fresh stack is refused before init', () => {
  const w = makeWorld({ yaml: 'config:\n  aws:region: us-west-2\nencryptionsalt: v1:old\n' });
  const r = setup(w);
  assert.notEqual(r.status, 0);
  assert.deepEqual(mutations(r.calls), []);
  assert.match(r.stderr, /Pulumi\.dev\.yaml/);
  assert.match(r.stderr, /encryptionsalt/);
});

test('a missing Pulumi.<stack>.yaml is refused before anything is created', () => {
  const w = makeWorld({ yaml: null });
  const r = setup(w);
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.calls, []);
  assert.match(r.stderr, /Pulumi\.dev\.yaml\.example/);
});

test('a bucket this account cannot see is refused, not created', () => {
  const w = makeWorld();
  writeFileSync(join(w.st, 'forbidden'), '');
  writeFileSync(join(w.infra, '.deploy.env'), `PULUMI_BACKEND_URL=s3://retivo-pulumi-state-999999999999?region=us-west-2\n`);
  const r = setup(w);
  assert.notEqual(r.status, 0);
  assert.deepEqual(mutations(r.calls), []);
  assert.match(r.stderr, /retivo-pulumi-state-999999999999/);
  assert.match(r.stderr, /\.deploy\.env/);
});

test('setup_pulumi_backend (the deploy path) with no passphrase names bootstrap and creates nothing', () => {
  const w = makeWorld();
  const r = run(w, 'setup_pulumi_backend dev');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /bootstrap-stack\.sh dev/);
  assert.deepEqual(mutations(r.calls), []);
  assert.deepEqual(
    r.calls.filter((c) => !/^aws (sts get-caller-identity|ssm get-parameter)|^pulumi login/.test(c)),
    [],
    'only reads and the login',
  );
});

test('setup_pulumi_backend reads the stored passphrase from the new path', () => {
  const w = makeWorld();
  writeFileSync(join(w.st, 'ssm', '_retivo-pulumi_dev_passphrase'), 'stored-value');
  const r = run(w, 'setup_pulumi_backend dev; test "$PULUMI_CONFIG_PASSPHRASE" = stored-value');
  assert.equal(r.status, 0, r.stderr);
  assert.match(has(r.calls, 'get-parameter')[0], new RegExp(`--name ${PP_NAME} `));
});
