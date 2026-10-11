// CloudWatch monitoring contract guard. Reads infrastructure/src/monitoring.ts
// and infrastructure/src/lambda.ts as TEXT and asserts the evidence-tuned
// dev/prod monitoring configuration — alarm identities +
// thresholds/statistics/periods, per-stack metric namespaces, and the absence
// of the removed dashboard and log metric filters. Pulumi resources can't be
// unit-tested directly (no live AWS runtime), so this static IaC contract is
// what actually pins the configuration values.
//
// Creds-free, no Pulumi runtime, no new dependency — mirrors
// scripts/test/csp-contract.test.mjs (reads an infra source file as text) and
// scripts/test/config-coverage.test.mjs. Runs under `pnpm test:scripts`. Lives
// in scripts/test/ so node's `test-*.mjs` discovery glob does not match it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INFRA = resolve(__dirname, '../../infrastructure/src');
const MONITORING = readFileSync(resolve(INFRA, 'monitoring.ts'), 'utf8');
const LAMBDA = readFileSync(resolve(INFRA, 'lambda.ts'), 'utf8');
const BACKUP = readFileSync(resolve(INFRA, 'backup.ts'), 'utf8');
const INDEX = readFileSync(resolve(INFRA, '../index.ts'), 'utf8');

/**
 * The source substring of a single `new aws.cloudwatch.MetricAlarm(...)` block,
 * located by its `name: `${namePrefix}-<suffix>`` line and sliced to the next
 * `});`. Lets each assertion scope threshold/statistic/period to one alarm.
 */
function alarmBlock(suffix) {
  const marker = '`${namePrefix}-' + suffix + '`';
  const at = MONITORING.indexOf(`name: ${marker}`);
  assert.notEqual(at, -1, `alarm name ${suffix} must exist in monitoring.ts`);
  const end = MONITORING.indexOf('});', at);
  return MONITORING.slice(at, end);
}

// --- 1. alarm groups: each switch gates exactly its own alarms --------------

/**
 * The source of the brace-delimited block whose opening `{` is the first `{`
 * at or after `from` in `src`. Returns the offsets too, so callers can ask
 * whether an alarm falls inside it. Braces are matched by depth, not by a
 * character window, so an alarm just past a closing brace is NOT inside.
 */
function braceBlock(src, from) {
  const open = src.indexOf('{', from);
  assert.notEqual(open, -1, 'a block must open after the guard');
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return { start: open, end: i + 1, text: src.slice(open, i + 1) };
      }
    }
  }
  assert.fail('unbalanced braces in guard block');
}

/** The names (`${namePrefix}-<name>`) of every alarm declared in `text`. */
function alarmNames(text) {
  return [...text.matchAll(/name: `\$\{namePrefix\}-([\w-]+)`/g)].map((m) => m[1]);
}

/** The group block `if (<switch>) {` — must exist exactly once. */
function groupBlock(switchName) {
  const guard = `if (${switchName}) {`;
  const at = MONITORING.indexOf(guard);
  assert.notEqual(at, -1, `monitoring.ts must guard a group with ${guard}`);
  assert.equal(
    MONITORING.indexOf(guard, at + 1),
    -1,
    `${guard} must appear exactly once`,
  );
  return braceBlock(MONITORING, at);
}

/**
 * Split a group block into its always-on alarms and the alarms that sit in a
 * nested `if (isProd) {` block (prod-only).
 */
function splitMembership(block) {
  const prodOnly = [];
  let rest = block.text;
  let at = rest.indexOf('if (isProd) {');
  while (at !== -1) {
    const nested = braceBlock(rest, at);
    prodOnly.push(...alarmNames(nested.text));
    rest = rest.slice(0, at) + rest.slice(nested.end);
    at = rest.indexOf('if (isProd) {');
  }
  return { alwaysOn: alarmNames(rest), prodOnly };
}

const GROUPS = {
  enableSecurityAlarms: {
    alwaysOn: ['token-reuse', 'mfa-verify-failed', 'login-failed'],
    prodOnly: [],
  },
  enableApiHealthAlarms: {
    alwaysOn: ['api-errors'],
    prodOnly: ['api-latency-p95'],
  },
  enableBackgroundJobAlarms: {
    alwaysOn: [
      'compactor-failure',
      'compactor-coverage',
      'compactor-snapshot-read-error',
      'compactor-budget-limited',
      'compactor-heartbeat',
    ],
    prodOnly: ['janitor-heartbeat'],
  },
  enableCapacityAlarms: {
    alwaysOn: [],
    prodOnly: ['lambda-throttles', 'lambda-concurrency-headroom'],
  },
};

test('encodes an explicit dev/prod matrix keyed off the stack', () => {
  assert.match(MONITORING, /const isProd = stack === "prod";/);
});

for (const [switchName, expected] of Object.entries(GROUPS)) {
  test(`${switchName} gates exactly its group: dev ${JSON.stringify(expected.alwaysOn)}, prod adds ${JSON.stringify(expected.prodOnly)}`, () => {
    const { alwaysOn, prodOnly } = splitMembership(groupBlock(switchName));
    assert.deepEqual([...alwaysOn].sort(), [...expected.alwaysOn].sort());
    assert.deepEqual([...prodOnly].sort(), [...expected.prodOnly].sort());
  });
}

test('every MetricAlarm sits inside exactly one group block, and no group block opens inside another', () => {
  const blocks = Object.keys(GROUPS).map((name) => ({ name, ...groupBlock(name) }));
  for (const a of blocks) {
    for (const b of blocks) {
      if (a === b) continue;
      assert.ok(
        a.end <= b.start || b.end <= a.start,
        `${a.name} and ${b.name} blocks must be siblings, never nested`,
      );
    }
  }
  const alarms = [...MONITORING.matchAll(/new aws\.cloudwatch\.MetricAlarm\(/g)].map((m) => m.index);
  assert.equal(
    alarms.length,
    Object.values(GROUPS).reduce((n, g) => n + g.alwaysOn.length + g.prodOnly.length, 0),
    'the file declares exactly the alarms the groups list',
  );
  for (const at of alarms) {
    const owners = blocks.filter((blk) => at > blk.start && at < blk.end);
    assert.equal(
      owners.length,
      1,
      `the alarm at offset ${at} must sit inside exactly one group block (got ${owners.map((o) => o.name).join(', ') || 'none'}) — an orphaned alarm would attach an empty action list`,
    );
  }
});

test('the SNS topic + subscription follow the shared anythingSendsAlerts predicate over all five switches', () => {
  // A guard that named only some switches would pass "conditional" but
  // silently drop a group's (or backup.ts's) alerting path — assert every
  // switch is handed to the shared predicate, by name, and that the topic is
  // built from that predicate rather than an inline union.
  assert.match(MONITORING, /import \{ anythingSendsAlerts \} from "\.\/config-helpers\.mjs";/);
  const call = MONITORING.match(/const alarmsEnabled = anythingSendsAlerts\(\{([^}]*)\}\);/);
  assert.ok(call, 'alarmsEnabled must come from anythingSendsAlerts({...})');
  const passed = call[1].split(',').map((x) => x.trim()).filter(Boolean).sort();
  assert.deepEqual(passed, [
    'enableApiHealthAlarms',
    'enableBackgroundJobAlarms',
    'enableBackups',
    'enableCapacityAlarms',
    'enableSecurityAlarms',
  ]);
  assert.match(
    MONITORING,
    /const alarmTopic = alarmsEnabled\s*\n\s*\? new aws\.sns\.Topic/,
  );
  assert.match(
    MONITORING,
    /if \(alarmTopic\) \{[\s\S]*?new aws\.sns\.TopicSubscription/,
  );
  assert.doesNotMatch(
    MONITORING,
    /enableSecurityAlarms\s*\|\||\|\|\s*enableBackups/,
    'no inline union of switches may decide the topic',
  );
});

test('no alarm is declared before the first group block (an alarm outside every guard would carry an empty action list)', () => {
  const first = Math.min(
    ...Object.keys(GROUPS).map((name) => MONITORING.indexOf(`if (${name}) {`)),
  );
  assert.doesNotMatch(MONITORING.slice(0, first), /new aws\.cloudwatch\.MetricAlarm\(/);
});

test('backup.ts refers to none of the four alarm switches', () => {
  for (const name of Object.keys(GROUPS)) {
    assert.doesNotMatch(BACKUP, new RegExp(name), `backup.ts must not depend on ${name}`);
  }
});

test('the backups branch in index.ts depends on enableBackups alone, not on any alarm switch', () => {
  // The four switches may appear in index.ts only inside the monitoringOpts
  // object that is handed to createMonitoring. Anywhere else — notably the
  // condition guarding createBackup — would couple backup alerting to a group.
  const optsAt = INDEX.indexOf('const monitoringOpts = {');
  assert.notEqual(optsAt, -1, 'monitoringOpts must exist');
  const opts = braceBlock(INDEX, optsAt);
  const outside = INDEX.slice(0, opts.start) + INDEX.slice(opts.end);
  for (const name of Object.keys(GROUPS)) {
    assert.doesNotMatch(outside, new RegExp(name), `${name} must only be passed through monitoringOpts`);
  }
  const guardAt = INDEX.indexOf('if (cfg.enableBackups) {');
  assert.notEqual(guardAt, -1, 'createBackup must be guarded by cfg.enableBackups alone');
  const guarded = braceBlock(INDEX, guardAt);
  assert.match(guarded.text, /createBackup\(\{/);
  assert.match(guarded.text, /createMonitoring\(\{\s*\n\s*\.\.\.monitoringOpts,\s*\n\s*enableBackups: true,/);
  assert.match(INDEX, /createMonitoring\(\{ \.\.\.monitoringOpts, enableBackups: false \}\)/);
});

// --- 2. security alarms: exact threshold/statistic/period/eval/missing-data --

test('LoginFailed burst alarm: Sum > 5 / 5min / 1 period / notBreaching', () => {
  const b = alarmBlock('login-failed');
  assert.match(b, /namespace: securityNs/);
  assert.match(b, /metricName: "LoginFailed"/);
  assert.match(b, /statistic: "Sum"/);
  assert.match(b, /period: 300/);
  assert.match(b, /evaluationPeriods: 1/);
  assert.match(b, /threshold: 5/);
  assert.match(b, /comparisonOperator: "GreaterThanThreshold"/);
  assert.match(b, /treatMissingData: "notBreaching"/);
});

test('MfaVerifyFailed burst alarm: Sum > 10 / 5min / 1 period / notBreaching', () => {
  const b = alarmBlock('mfa-verify-failed');
  assert.match(b, /namespace: securityNs/);
  assert.match(b, /metricName: "MfaVerifyFailed"/);
  assert.match(b, /statistic: "Sum"/);
  assert.match(b, /period: 300/);
  assert.match(b, /evaluationPeriods: 1/);
  assert.match(b, /threshold: 10/);
  assert.match(b, /treatMissingData: "notBreaching"/);
});

test('RefreshTokenReuse alarm: Sum > 0 / 5min / 1 period / notBreaching', () => {
  const b = alarmBlock('token-reuse');
  assert.match(b, /namespace: securityNs/);
  assert.match(b, /metricName: "RefreshTokenReuse"/);
  assert.match(b, /statistic: "Sum"/);
  assert.match(b, /period: 300/);
  assert.match(b, /evaluationPeriods: 1/);
  assert.match(b, /threshold: 0/);
  assert.match(b, /treatMissingData: "notBreaching"/);
});

// --- 3. per-stack metric namespaces ----------------------------------------

test('security + compactor namespaces are per-stack', () => {
  assert.match(MONITORING, /securityNs = `Retivo\/\$\{stack\}\/Security`/);
  assert.match(MONITORING, /compactorNs = `Retivo\/\$\{stack\}\/Compactor`/);
});

test('compactor coverage alarm reads the per-stack compactor namespace', () => {
  const b = alarmBlock('compactor-coverage');
  assert.match(b, /namespace: compactorNs/);
  assert.match(b, /metricName: "CompactorCoverageViolation"/);
});

test('compactor snapshot-read-error alarm: compactorNs / Sum > 0 / 5min / 1 period / notBreaching', () => {
  const b = alarmBlock('compactor-snapshot-read-error');
  assert.match(b, /namespace: compactorNs/);
  assert.match(b, /metricName: "CompactorSnapshotReadError"/);
  assert.match(b, /statistic: "Sum"/);
  assert.match(b, /period: 300/);
  assert.match(b, /evaluationPeriods: 1/);
  assert.match(b, /threshold: 0/);
  assert.match(b, /comparisonOperator: "GreaterThanThreshold"/);
  assert.match(b, /treatMissingData: "notBreaching"/);
});

test('compactor budget-limited alarm: compactorNs / Sum > 0 / 5min / 1 period / notBreaching', () => {
  const b = alarmBlock('compactor-budget-limited');
  assert.match(b, /namespace: compactorNs/);
  assert.match(b, /metricName: "CompactorBudgetLimited"/);
  assert.match(b, /statistic: "Sum"/);
  assert.match(b, /period: 300/);
  assert.match(b, /evaluationPeriods: 1/);
  assert.match(b, /threshold: 0/);
  assert.match(b, /comparisonOperator: "GreaterThanThreshold"/);
  assert.match(b, /treatMissingData: "notBreaching"/);
});

/**
 * Assert the named alarm is declared inside the `enableBackgroundJobAlarms`
 * block and outside every nested `if (isProd) {` block. Keyed on the guard
 * and the alarm's `name:` line, so comments between them play no part. Wrapping
 * the alarm in `if (isProd)` would drop its signal on a dev stack that turns
 * the group on; the group's own switch is a different, deliberate guard.
 */
function assertAlwaysOnInBackgroundGroup(suffix) {
  const block = groupBlock('enableBackgroundJobAlarms');
  assert.ok(
    block.text.includes('name: `${namePrefix}-' + suffix + '`'),
    `${suffix} alarm must be declared inside the enableBackgroundJobAlarms block`,
  );
  const { alwaysOn, prodOnly } = splitMembership(block);
  assert.ok(alwaysOn.includes(suffix), `${suffix} alarm must be always-on in its group`);
  assert.ok(!prodOnly.includes(suffix), `${suffix} alarm must have no if (isProd) gate`);
}

test('compactor snapshot-read-error alarm has no isProd gate (its own gate is enableBackgroundJobAlarms, not the isProd matrix)', () => {
  assertAlwaysOnInBackgroundGroup('compactor-snapshot-read-error');
});

test('compactor budget-limited alarm has no isProd gate (its own gate is enableBackgroundJobAlarms, not the isProd matrix)', () => {
  assertAlwaysOnInBackgroundGroup('compactor-budget-limited');
});

// --- 7. the nightly usage job is gone (no namespace, widget, function, schedule) --

test('monitoring.ts uses only the security and compactor Retivo/* namespaces', () => {
  const literals = [...MONITORING.matchAll(/Retivo\/[^\s`"')]*/g)].map((m) => m[0]);
  assert.ok(literals.length > 0, 'the security and compactor namespaces must be spelled out');
  for (const literal of literals) {
    assert.match(
      literal,
      /^Retivo\/\$\{stack\}\/(Security|Compactor)$/,
      `${literal} is not an allowed Retivo/* namespace`,
    );
  }
  const declared = [...MONITORING.matchAll(/const (\w+Ns) = `Retivo\//g)].map((m) => m[1]);
  assert.deepEqual(
    declared.sort(),
    ['compactorNs', 'securityNs'],
    'monitoring.ts must declare only the two known Retivo/* namespaces',
  );
  const used = new Set([...MONITORING.matchAll(/namespace: (\w+Ns),/g)].map((m) => m[1]));
  assert.deepEqual([...used].sort(), ['compactorNs', 'securityNs']);
});

test('lambda.ts creates exactly the api/compactor/snapshot-purge/janitor/probe functions and no nightly cron', () => {
  const fns = [...LAMBDA.matchAll(/new aws\.lambda\.Function\(`\$\{namePrefix\}-([\w-]+)`/g)].map((m) => m[1]);
  assert.deepEqual(fns.sort(), ['api', 'compactor', 'janitor', 'probe', 'snapshot-purge']);
  const rules = [...LAMBDA.matchAll(/new aws\.cloudwatch\.EventRule\(\s*`\$\{namePrefix\}-([\w-]+)`/g)].map((m) => m[1]);
  assert.deepEqual(rules.sort(), ['compactor-schedule', 'janitor-schedule', 'probe-schedule']);
  assert.doesNotMatch(LAMBDA, /cron\(0 1 /, 'the nightly 01:00 UTC schedule must be gone');
});

// --- 9. account-wide concurrency alarms (prod only) ------------------------

test('lambda-throttles alarm: account-wide AWS/Lambda Throttles, Sum > 0 / 60s / 1 period, no dimensions', () => {
  const b = alarmBlock('lambda-throttles');
  assert.match(b, /namespace: "AWS\/Lambda"/);
  assert.match(b, /metricName: "Throttles"/);
  assert.match(b, /statistic: "Sum"/);
  assert.match(b, /period: 60/);
  assert.match(b, /evaluationPeriods: 1/);
  assert.match(b, /datapointsToAlarm: 1/);
  assert.match(b, /threshold: 0/);
  assert.match(b, /comparisonOperator: "GreaterThanThreshold"/);
  assert.match(b, /treatMissingData: "notBreaching"/);
  assert.doesNotMatch(
    b,
    /dimensions:/,
    'must declare no FunctionName dimension — the account-wide aggregate is the whole design; a dimensioned alarm would still look correct in the console',
  );
});

test('lambda-concurrency-headroom alarm: account-wide AWS/Lambda ConcurrentExecutions, Maximum >= quota - 2 / 60s / 2 of 3, no dimensions', () => {
  const b = alarmBlock('lambda-concurrency-headroom');
  assert.match(b, /namespace: "AWS\/Lambda"/);
  assert.match(b, /metricName: "ConcurrentExecutions"/);
  assert.match(b, /statistic: "Maximum"/);
  assert.match(b, /period: 60/);
  assert.match(b, /evaluationPeriods: 3/);
  assert.match(b, /datapointsToAlarm: 2/);
  assert.match(b, /comparisonOperator: "GreaterThanOrEqualToThreshold"/);
  assert.match(b, /treatMissingData: "notBreaching"/);
  assert.doesNotMatch(
    b,
    /dimensions:/,
    'must declare no FunctionName dimension — the account-wide aggregate is the whole design',
  );
  assert.match(
    b,
    /threshold: lambdaConcurrencyQuota - 2/,
    'the threshold must be an expression over the configured quota option, not a numeric literal, so raising the key moves the alarm with it',
  );
});

test('both account-wide alarms sit inside the isProd gate within the capacity group', () => {
  // Structural proof via brace matching: the capacity group block holds no
  // always-on alarm, and both alarms live in its nested isProd block.
  const { alwaysOn, prodOnly } = splitMembership(groupBlock('enableCapacityAlarms'));
  assert.deepEqual(alwaysOn, []);
  assert.deepEqual(
    [...prodOnly].sort(),
    ['lambda-concurrency-headroom', 'lambda-throttles'],
  );
});

test('compactor heartbeat alarm period + evaluation are unchanged (no widening for the new dev cadence)', () => {
  const b = alarmBlock('compactor-heartbeat');
  assert.match(b, /namespace: "AWS\/Lambda"/);
  assert.match(b, /metricName: "Invocations"/);
  assert.match(b, /statistic: "Sum"/);
  assert.match(b, /period: 86400/);
  assert.match(b, /evaluationPeriods: 1/);
  assert.match(b, /comparisonOperator: "LessThanThreshold"/);
  assert.match(b, /threshold: 1/);
  assert.match(b, /treatMissingData: "breaching"/);
});

// --- 10. schedules: probe disabled, compactor dev/prod split, janitor fixed cron

test('probe EventBridge rule declares a disabled state', () => {
  assert.match(
    LAMBDA,
    /scheduleExpression: "rate\(5 minutes\)",\s*\n\s*state: "DISABLED"/,
    'the probe schedule must be DISABLED — a half-edit that flips only the comment would leave this red',
  );
});

test('compactor schedule expression is the decided dev/prod split, pinned alongside its state ternary', () => {
  assert.match(
    LAMBDA,
    /scheduleExpression:\s*\n\s*stack === "prod" \? "cron\(41 \* \* \* \? \*\)" : "rate\(6 hours\)",\s*\n\s*state: compactorEnabled \? "ENABLED" : "DISABLED"/,
    'prod must be a fixed cron and dev a 6-hour rate, with the enable/disable flag intact',
  );
});

test('janitor schedule expression is the fixed cron, unchanged across stacks', () => {
  assert.match(
    LAMBDA,
    /scheduleExpression: "cron\(17 3 \* \* \? \*\)",\s*\n\s*state: janitorEnabled \? "ENABLED" : "DISABLED"/,
    'the janitor must use a fixed cron (not rate(1 day)) so a redeploy can never drift its invocation time',
  );
});
