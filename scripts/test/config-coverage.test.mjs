// Required-stack-config coverage guard. Two concerns, both creds-free and
// dependency-free (node --test, run under `pnpm test:scripts`):
//
//   1. Example-YAML coverage — both Pulumi.<stack>.yaml.example files carry all
//      ten required stack config keys with their selected values, so
//      the "fail-loud when missing" contract is never accidentally regressed
//      by an example that drops a key.
//   2. Parser/validator behavior — the pure helpers in
//      infrastructure/src/config-helpers.mjs reject a missing required key
//      and an off-enum logRetentionDays such as 45, and accept
//      the example values 7 and 90. These run without a Pulumi runtime or AWS
//      credentials because the helpers consume a plain string getter.
//
// Pattern: scripts/test/csp-contract.test.mjs (reads an infra file as text) +
// scripts/test/affected-core.test.mjs (imports a pure .mjs helper).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLOUDWATCH_LOG_RETENTION_DAYS,
  DEFAULT_API_THROTTLE_BURST,
  DEFAULT_API_THROTTLE_RATE_PER_SEC,
  DEFAULT_LAMBDA_CONCURRENCY_QUOTA,
  anythingSendsAlerts,
  assertEdgeAllowedIpsForStack,
  ipv4CidrToRule,
  parseAlarmNotificationEmail,
  parseApiThrottle,
  parseEdgeAllowedIps,
  parseLambdaConcurrencyQuota,
  parseLogRetentionDays,
  parseRequiredBoolean,
} from '../../infrastructure/src/config-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INFRA = resolve(__dirname, '../../infrastructure');

// --- 1. Example-YAML coverage ----------------------------------------------

const REQUIRED_VALUES = {
  // The dev example ships every paid-service switch off: a fresh copy
  // deploys the cheapest stack and each switch is an explicit opt-in.
  dev: {
    'retivo:enableWaf': 'false',
    'retivo:manageCloudTrail': 'false',
    'retivo:enablePitr': 'false',
    // Immutable AWS Backup vault — prod-only, so dev ships false.
    'retivo:enableBackups': 'false',
    // Four alarm groups, each deploying exactly its own alarms.
    'retivo:enableSecurityAlarms': 'false',
    'retivo:enableApiHealthAlarms': 'false',
    'retivo:enableBackgroundJobAlarms': 'false',
    'retivo:enableCapacityAlarms': 'false',
    'retivo:logRetentionDays': '7',
    // Blank: with nothing alerting the key is not required, and a non-empty
    // placeholder would let a later dev alarm group deploy mailing a dead
    // address instead of failing loud.
    'retivo:alarmNotificationEmail': '',
  },
  prod: {
    'retivo:enableWaf': 'true',
    'retivo:manageCloudTrail': 'true',
    'retivo:enablePitr': 'true',
    // Immutable AWS Backup vault — enabled on prod.
    'retivo:enableBackups': 'true',
    // Prod ships the full alarm inventory: all four groups on.
    'retivo:enableSecurityAlarms': 'true',
    'retivo:enableApiHealthAlarms': 'true',
    'retivo:enableBackgroundJobAlarms': 'true',
    'retivo:enableCapacityAlarms': 'true',
    'retivo:logRetentionDays': '90',
    // Prod ships the alarm-email key present-but-blank (mirrors sesFromAddress):
    // the operator fills a real monitored inbox before `pulumi up --stack prod`.
    // The key must still be declared so config load can fail loud if dropped.
    'retivo:alarmNotificationEmail': '',
  },
};

for (const [stack, keys] of Object.entries(REQUIRED_VALUES)) {
  const source = readFileSync(
    resolve(INFRA, `Pulumi.${stack}.yaml.example`),
    'utf8',
  );
  test(`${stack} example sets every required stack config key`, () => {
    const missing = Object.entries(keys)
      .filter(
        ([key, value]) =>
          !new RegExp(`^\\s*${key}:\\s*"${value}"\\s*$`, 'm').test(source),
      )
      .map(([key, value]) => `${key}: "${value}"`);
    assert.deepEqual(
      missing,
      [],
      `Pulumi.${stack}.yaml.example must declare these required stack config keys`,
    );
  });
}

// Signup-approval inbox (`retivo:approverEmail` → api APPROVER_EMAIL).
// Conditionally required by infrastructure/src/config.ts (whenever
// sesFromAddress is a real address), so both examples must declare the key
// present-but-blank next to sesFromAddress for the operator to fill in.
for (const stack of ['dev', 'prod']) {
  test(`${stack} example declares retivo:approverEmail`, () => {
    const source = readFileSync(
      resolve(INFRA, `Pulumi.${stack}.yaml.example`),
      'utf8',
    );
    assert.match(
      source,
      /^\s*retivo:approverEmail:\s*""\s*$/m,
      `Pulumi.${stack}.yaml.example must declare retivo:approverEmail: "" (signup-approval inbox, required once sesFromAddress is real)`,
    );
  });
}

// Optional (non-required) key: `retivo:lambdaConcurrencyQuota`. Both examples
// ship the current real quota ("10") — the `retivo:approverEmail` block above
// is the right precedent, not REQUIRED_VALUES, since this key has a code
// default and must never be counted among the required keys.
for (const stack of ['dev', 'prod']) {
  test(`${stack} example declares retivo:lambdaConcurrencyQuota: "10"`, () => {
    const source = readFileSync(
      resolve(INFRA, `Pulumi.${stack}.yaml.example`),
      'utf8',
    );
    assert.match(
      source,
      /^\s*retivo:lambdaConcurrencyQuota:\s*"10"\s*$/m,
      `Pulumi.${stack}.yaml.example must declare retivo:lambdaConcurrencyQuota: "10" (optional key, current real quota — not one of the required keys)`,
    );
  });
}

// `retivo:enableObservability` was replaced by the four alarm switches and
// has no upgrade path: neither example may carry it any more.
for (const stack of ['dev', 'prod']) {
  test(`${stack} example does not declare the removed retivo:enableObservability`, () => {
    const source = readFileSync(
      resolve(INFRA, `Pulumi.${stack}.yaml.example`),
      'utf8',
    );
    assert.doesNotMatch(source, /enableObservability/);
  });
}

// Optional keys for the dev edge IP gate + the API Gateway stage throttle.
// The dev example ships the gate key present-but-blank (off) next to a
// deliberately LOW throttle; prod ships the code-default throttle and no gate
// key at all (config load refuses a non-empty one there).
test('dev example declares retivo:edgeAllowedIps: "" (gate off until the operator fills it)', () => {
  const source = readFileSync(resolve(INFRA, 'Pulumi.dev.yaml.example'), 'utf8');
  assert.match(source, /^\s*retivo:edgeAllowedIps:\s*""\s*$/m);
});

test('prod example does not declare retivo:edgeAllowedIps (dev-only key)', () => {
  const source = readFileSync(resolve(INFRA, 'Pulumi.prod.yaml.example'), 'utf8');
  assert.doesNotMatch(source, /^\s*retivo:edgeAllowedIps:/m);
});

for (const [stack, rate, burst] of [
  ['dev', '5', '10'],
  ['prod', '20', '50'],
]) {
  test(`${stack} example declares the API throttle keys (${rate} req/s, burst ${burst})`, () => {
    const source = readFileSync(resolve(INFRA, `Pulumi.${stack}.yaml.example`), 'utf8');
    assert.match(source, new RegExp(`^\\s*retivo:apiThrottleRatePerSec:\\s*"${rate}"\\s*$`, 'm'));
    assert.match(source, new RegExp(`^\\s*retivo:apiThrottleBurst:\\s*"${burst}"\\s*$`, 'm'));
  });
}

// --- 2. parseRequiredBoolean -----------------------------------------------

// Map-backed getter mirroring pulumi.Config.get: returns the string or
// undefined for an absent key.
const getterFor = (entries) => (key) => entries[key];

test('parseRequiredBoolean — missing required key throws', () => {
  const get = getterFor({});
  assert.throws(
    () => parseRequiredBoolean(get, 'enableWaf'),
    /retivo:enableWaf is required/,
  );
});

test('parseRequiredBoolean — empty string is treated as missing', () => {
  const get = getterFor({ enableWaf: '' });
  assert.throws(
    () => parseRequiredBoolean(get, 'enableWaf'),
    /retivo:enableWaf is required/,
  );
});

test('parseRequiredBoolean — "true"/"false" parse to booleans', () => {
  assert.equal(parseRequiredBoolean(getterFor({ k: 'true' }), 'k'), true);
  assert.equal(parseRequiredBoolean(getterFor({ k: 'false' }), 'k'), false);
});

test('parseRequiredBoolean — non-boolean string throws', () => {
  assert.throws(
    () => parseRequiredBoolean(getterFor({ k: 'yes' }), 'k'),
    /must be "true" or "false"/,
  );
});

// --- 3. alarm switches + alarmNotificationEmail ----------------------------

const ALARM_SWITCHES = [
  'enableSecurityAlarms',
  'enableApiHealthAlarms',
  'enableBackgroundJobAlarms',
  'enableCapacityAlarms',
  'enableBackups',
];
const allOff = () => Object.fromEntries(ALARM_SWITCHES.map((k) => [k, false]));

for (const key of ALARM_SWITCHES.slice(0, 4)) {
  test(`${key} is required — a missing key throws through parseRequiredBoolean`, () => {
    assert.throws(
      () => parseRequiredBoolean(getterFor({}), key),
      new RegExp(`retivo:${key} is required`),
    );
  });
}

test('anythingSendsAlerts — all five switches off is false', () => {
  assert.equal(anythingSendsAlerts(allOff()), false);
});

for (const key of ALARM_SWITCHES) {
  test(`anythingSendsAlerts — ${key} alone makes it true`, () => {
    assert.equal(anythingSendsAlerts({ ...allOff(), [key]: true }), true);
  });
}

for (const key of ALARM_SWITCHES) {
  test(`parseAlarmNotificationEmail — ${key} on with the email missing throws naming the key and the switch`, () => {
    const switches = { ...allOff(), [key]: true };
    assert.throws(
      () => parseAlarmNotificationEmail(getterFor({}), switches),
      (err) =>
        err.message.includes('retivo:alarmNotificationEmail is required') &&
        err.message.includes(`retivo:${key}`) &&
        err.message.includes('pulumi config set retivo:alarmNotificationEmail'),
    );
  });
}

test('parseAlarmNotificationEmail — an empty email is treated as missing when something is on', () => {
  assert.throws(
    () =>
      parseAlarmNotificationEmail(getterFor({ alarmNotificationEmail: '' }), {
        ...allOff(),
        enableBackups: true,
      }),
    /retivo:alarmNotificationEmail is required/,
  );
});

test('parseAlarmNotificationEmail — several switches on are all named in the message', () => {
  assert.throws(
    () =>
      parseAlarmNotificationEmail(getterFor({}), {
        ...allOff(),
        enableSecurityAlarms: true,
        enableCapacityAlarms: true,
      }),
    (err) =>
      err.message.includes('retivo:enableSecurityAlarms') &&
      err.message.includes('retivo:enableCapacityAlarms'),
  );
});

test('parseAlarmNotificationEmail — a present value is returned verbatim (no format validation)', () => {
  assert.equal(
    parseAlarmNotificationEmail(
      getterFor({ alarmNotificationEmail: 'not an email' }),
      { ...allOff(), enableApiHealthAlarms: true },
    ),
    'not an email',
  );
});

test('parseAlarmNotificationEmail — everything off and the email missing does not throw', () => {
  assert.equal(parseAlarmNotificationEmail(getterFor({}), allOff()), undefined);
});

test('parseAlarmNotificationEmail — everything off never reads the email key', () => {
  const get = () => {
    throw new Error('alarmNotificationEmail must not be read when nothing alerts');
  };
  assert.equal(parseAlarmNotificationEmail(get, allOff()), undefined);
});

// --- 4. parseLogRetentionDays ----------------------------------------------

test('parseLogRetentionDays — missing required key throws', () => {
  assert.throws(
    () => parseLogRetentionDays(getterFor({})),
    /retivo:logRetentionDays is required/,
  );
});

test('parseLogRetentionDays — off-enum value 45 is rejected', () => {
  assert.throws(
    () => parseLogRetentionDays(getterFor({ logRetentionDays: '45' })),
    /must be one of the AWS CloudWatch Logs retention values/,
  );
});

test('parseLogRetentionDays — example values 7 and 90 are accepted', () => {
  assert.equal(parseLogRetentionDays(getterFor({ logRetentionDays: '7' })), 7);
  assert.equal(parseLogRetentionDays(getterFor({ logRetentionDays: '90' })), 90);
});

test('parseLogRetentionDays — non-integer string is rejected', () => {
  assert.throws(
    () => parseLogRetentionDays(getterFor({ logRetentionDays: '7.5' })),
    /must be one of the AWS CloudWatch Logs retention values/,
  );
});

test('CLOUDWATCH_LOG_RETENTION_DAYS includes the canonical 7 and 90', () => {
  assert.ok(CLOUDWATCH_LOG_RETENTION_DAYS.includes(7));
  assert.ok(CLOUDWATCH_LOG_RETENTION_DAYS.includes(90));
  assert.ok(!CLOUDWATCH_LOG_RETENTION_DAYS.includes(45));
});

// --- 5. parseLambdaConcurrencyQuota (optional, default 10) ------------------

test('parseLambdaConcurrencyQuota — missing key defaults to DEFAULT_LAMBDA_CONCURRENCY_QUOTA', () => {
  assert.equal(parseLambdaConcurrencyQuota(getterFor({})), DEFAULT_LAMBDA_CONCURRENCY_QUOTA);
  assert.equal(DEFAULT_LAMBDA_CONCURRENCY_QUOTA, 10);
});

test('parseLambdaConcurrencyQuota — empty string defaults, same as missing', () => {
  assert.equal(
    parseLambdaConcurrencyQuota(getterFor({ lambdaConcurrencyQuota: '' })),
    DEFAULT_LAMBDA_CONCURRENCY_QUOTA,
  );
});

test('parseLambdaConcurrencyQuota — a present valid value is returned as a number', () => {
  assert.equal(
    parseLambdaConcurrencyQuota(getterFor({ lambdaConcurrencyQuota: '25' })),
    25,
  );
});

test('parseLambdaConcurrencyQuota — a non-integer value is rejected', () => {
  assert.throws(
    () => parseLambdaConcurrencyQuota(getterFor({ lambdaConcurrencyQuota: '10.5' })),
    /must be an integer >= 3/,
  );
});

test('parseLambdaConcurrencyQuota — a value too small to leave the alarm usable headroom is rejected', () => {
  assert.throws(
    () => parseLambdaConcurrencyQuota(getterFor({ lambdaConcurrencyQuota: '2' })),
    /must be an integer >= 3/,
  );
});

// --- 6. parseEdgeAllowedIps (optional, dev-only edge IP gate) ---------------

test('parseEdgeAllowedIps — absent or blank key means the gate is off ([])', () => {
  assert.deepEqual(parseEdgeAllowedIps(getterFor({})), []);
  assert.deepEqual(parseEdgeAllowedIps(getterFor({ edgeAllowedIps: '' })), []);
  assert.deepEqual(parseEdgeAllowedIps(getterFor({ edgeAllowedIps: '   ' })), []);
});

test('parseEdgeAllowedIps — a bare address normalises to /32', () => {
  assert.deepEqual(parseEdgeAllowedIps(getterFor({ edgeAllowedIps: '1.2.3.4' })), ['1.2.3.4/32']);
});

test('parseEdgeAllowedIps — trims and normalises a comma-separated list', () => {
  assert.deepEqual(
    parseEdgeAllowedIps(getterFor({ edgeAllowedIps: ' 10.0.0.0/8 , 1.2.3.4' })),
    ['10.0.0.0/8', '1.2.3.4/32'],
  );
});

for (const bad of [
  '1.2.3.4,,5.6.7.8',
  '1.2.3.256',
  '1.2.3',
  '1.2.3.4x',
  '2001:db8::1',
  '1.2.3.4/33',
  '1.2.3.4/0',
  // Leading zeros read as octal by inet_aton/curl but decimal by a naive
  // parse — the operator would test one host and allow another.
  '010.0.0.1',
  '1.2.3.04',
  '1.2.3.4/01',
  'garbage',
]) {
  test(`parseEdgeAllowedIps — rejects "${bad}" naming the key`, () => {
    assert.throws(
      () => parseEdgeAllowedIps(getterFor({ edgeAllowedIps: bad })),
      /retivo:edgeAllowedIps/,
    );
  });
}

// --- 7. ipv4CidrToRule ------------------------------------------------------

test('ipv4CidrToRule — 10.1.2.3/8 masks to the 10/8 base', () => {
  assert.deepEqual(ipv4CidrToRule('10.1.2.3/8'), { base: 167772160, mask: 4278190080 });
});

test('ipv4CidrToRule — 192.168.1.3/24 keeps the high bit unsigned', () => {
  assert.deepEqual(ipv4CidrToRule('192.168.1.3/24'), { base: 3232235776, mask: 4294967040 });
});

test('ipv4CidrToRule — 255.255.255.255/32 is an all-ones base and mask', () => {
  assert.deepEqual(ipv4CidrToRule('255.255.255.255/32'), { base: 4294967295, mask: 4294967295 });
});

test('ipv4CidrToRule — /1 and /31 boundaries', () => {
  assert.deepEqual(ipv4CidrToRule('200.0.0.1/1'), { base: 2147483648, mask: 2147483648 });
  assert.deepEqual(ipv4CidrToRule('10.0.0.3/31'), { base: 167772162, mask: 4294967294 });
});

test('ipv4CidrToRule — refuses an un-normalised input (no prefix, /0)', () => {
  assert.throws(() => ipv4CidrToRule('1.2.3.4'), /normalised/);
  assert.throws(() => ipv4CidrToRule('1.2.3.4/0'), /1–32/);
});

// --- 8. parseApiThrottle (optional, defaults 20 / 50) -----------------------

test('parseApiThrottle — missing keys default to 20 req/s, burst 50', () => {
  assert.deepEqual(parseApiThrottle(getterFor({})), { ratePerSec: 20, burst: 50 });
  assert.equal(DEFAULT_API_THROTTLE_RATE_PER_SEC, 20);
  assert.equal(DEFAULT_API_THROTTLE_BURST, 50);
});

test('parseApiThrottle — present values are returned as numbers', () => {
  assert.deepEqual(
    parseApiThrottle(getterFor({ apiThrottleRatePerSec: '5', apiThrottleBurst: '10' })),
    { ratePerSec: 5, burst: 10 },
  );
});

test('parseApiThrottle — a burst below the rate is accepted (AWS treats them independently)', () => {
  assert.deepEqual(
    parseApiThrottle(getterFor({ apiThrottleRatePerSec: '2000', apiThrottleBurst: '100' })),
    { ratePerSec: 2000, burst: 100 },
  );
});

for (const [key, bad] of [
  ['apiThrottleRatePerSec', '0'],
  ['apiThrottleRatePerSec', '-5'],
  ['apiThrottleRatePerSec', '2.5'],
  ['apiThrottleBurst', '0'],
  ['apiThrottleBurst', '-1'],
  ['apiThrottleBurst', 'ten'],
]) {
  test(`parseApiThrottle — rejects ${key}="${bad}" naming the key`, () => {
    assert.throws(
      () => parseApiThrottle(getterFor({ [key]: bad })),
      new RegExp(`retivo:${key} must be a positive integer`),
    );
  });
}

// --- 9. assertEdgeAllowedIpsForStack (prod refuses the gate) -----------------

test('prod guard — a non-empty allowlist on prod throws before any resource is composed, WAF on or off', () => {
  assert.throws(
    () => assertEdgeAllowedIpsForStack('prod', ['1.2.3.4/32']),
    /retivo:edgeAllowedIps must be empty on the prod stack \(got 1 entry\)/,
  );
  assert.throws(
    () => assertEdgeAllowedIpsForStack('prod', ['1.2.3.4/32', '10.0.0.0/8']),
    /got 2 entries/,
  );
});

test('prod guard — a blank allowlist on prod is fine; dev accepts any list', () => {
  assert.doesNotThrow(() => assertEdgeAllowedIpsForStack('prod', []));
  assert.doesNotThrow(() => assertEdgeAllowedIpsForStack('dev', ['1.2.3.4/32']));
});
