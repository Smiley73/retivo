// Both Pulumi.<stack>.yaml.example files carry every required stack config key, and the helpers in
// infrastructure/src/config-helpers.mjs reject a missing key or an off-enum logRetentionDays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLOUDWATCH_LOG_RETENTION_DAYS,
  DEFAULT_API_THROTTLE_BURST,
  DEFAULT_API_THROTTLE_RATE_PER_SEC,
  ASSISTANT_BRIDGE_PORT_RANGE,
  DEFAULT_LAMBDA_CONCURRENCY_QUOTA,
  anythingSendsAlerts,
  assertEdgeAllowedIpsForStack,
  ipv4CidrToRule,
  parseAlarmNotificationEmail,
  parseApiThrottle,
  parseAssistantBridgePort,
  parseEdgeAllowedIps,
  parseLambdaConcurrencyQuota,
  parseLogRetentionDays,
  parseRequiredBoolean,
} from '../../infrastructure/src/config-helpers.mjs';

// ESM-only package, CommonJS infrastructure: only this test imports the built `dist` to pin the documented default.
const { DEFAULT_BRIDGE_PORT } = await import(
  '../../packages/assistant-protocol/dist/index.js'
).catch((error) => {
  throw new Error(
    'packages/assistant-protocol/dist is missing or stale — run `pnpm install` ' +
      `(its prepare script builds it). Cause: ${error.message}`,
  );
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const INFRA = resolve(__dirname, '../../infrastructure');

// --- 1. Example-YAML coverage ----------------------------------------------

const REQUIRED_VALUES = {
  // Dev ships every paid-service switch off.
  dev: {
    'retivo:enableWaf': 'false',
    'retivo:manageCloudTrail': 'false',
    'retivo:enablePitr': 'false',
    'retivo:enableBackups': 'false',
    'retivo:enableSecurityAlarms': 'false',
    'retivo:enableApiHealthAlarms': 'false',
    'retivo:enableBackgroundJobAlarms': 'false',
    'retivo:enableCapacityAlarms': 'false',
    'retivo:logRetentionDays': '7',
    // Blank: a placeholder would let a later alarm group deploy mailing a dead address instead of failing loud.
    'retivo:alarmNotificationEmail': '',
  },
  prod: {
    'retivo:enableWaf': 'true',
    'retivo:manageCloudTrail': 'true',
    'retivo:enablePitr': 'true',
    'retivo:enableBackups': 'true',
    'retivo:enableSecurityAlarms': 'true',
    'retivo:enableApiHealthAlarms': 'true',
    'retivo:enableBackgroundJobAlarms': 'true',
    'retivo:enableCapacityAlarms': 'true',
    'retivo:logRetentionDays': '90',
    // Present but blank: config load fails loud if the key is dropped.
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

// `retivo:approverEmail` is required once sesFromAddress is real, so both examples declare it blank.
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

// Optional key with a code default, so it stays out of REQUIRED_VALUES.
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

// Replaced by the four alarm switches, with no upgrade path.
for (const stack of ['dev', 'prod']) {
  test(`${stack} example does not declare the removed retivo:enableObservability`, () => {
    const source = readFileSync(
      resolve(INFRA, `Pulumi.${stack}.yaml.example`),
      'utf8',
    );
    assert.doesNotMatch(source, /enableObservability/);
  });
}

// Prod has no gate key: config load refuses a non-empty one there.
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

// The connector is off by default: neither example sets it, and the commented hint must carry DEFAULT_BRIDGE_PORT.
for (const stack of ['dev', 'prod']) {
  test(`${stack} example cannot switch the assistant connector on, and documents DEFAULT_BRIDGE_PORT`, () => {
    const source = readFileSync(resolve(INFRA, `Pulumi.${stack}.yaml.example`), 'utf8');
    assert.doesNotMatch(source, /^\s*retivo:assistantBridgePort:/m);
    const hint = /^\s*#\s*retivo:assistantBridgePort:\s*"(\d+)"\s*$/m.exec(source);
    assert.ok(hint, 'a commented `# retivo:assistantBridgePort: "<port>"` line is expected');
    assert.equal(Number(hint[1]), DEFAULT_BRIDGE_PORT);
  });
}

// --- 2. parseRequiredBoolean -----------------------------------------------

// Mirrors pulumi.Config.get.
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
  // inet_aton/curl read leading zeros as octal, a naive parse as decimal.
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

// --- 10. parseAssistantBridgePort (optional AI assistant connector switch) ----

test('parseAssistantBridgePort — absent or blank key means the connector is off (undefined)', () => {
  assert.equal(parseAssistantBridgePort(getterFor({})), undefined);
  assert.equal(parseAssistantBridgePort(getterFor({ assistantBridgePort: '' })), undefined);
  assert.equal(parseAssistantBridgePort(getterFor({ assistantBridgePort: '   ' })), undefined);
});

test('parseAssistantBridgePort — the default and a non-default in-range port parse to numbers', () => {
  assert.equal(
    parseAssistantBridgePort(getterFor({ assistantBridgePort: String(DEFAULT_BRIDGE_PORT) })),
    DEFAULT_BRIDGE_PORT,
  );
  assert.equal(parseAssistantBridgePort(getterFor({ assistantBridgePort: '24581' })), 24581);
  assert.equal(parseAssistantBridgePort(getterFor({ assistantBridgePort: ' 24581 ' })), 24581);
});

test('parseAssistantBridgePort — the range bounds are inclusive', () => {
  const { min, max } = ASSISTANT_BRIDGE_PORT_RANGE;
  assert.deepEqual([min, max], [1024, 65535]);
  assert.equal(parseAssistantBridgePort(getterFor({ assistantBridgePort: String(min) })), min);
  assert.equal(parseAssistantBridgePort(getterFor({ assistantBridgePort: String(max) })), max);
});

for (const bad of ['0', '80', '1023', '65536', '99999', '-24580', '24580.5', '1e4', '0x6004', 'abc', '24 580', 'ws://127.0.0.1:24580']) {
  test(`parseAssistantBridgePort — rejects "${bad}" naming the key`, () => {
    assert.throws(
      () => parseAssistantBridgePort(getterFor({ assistantBridgePort: bad })),
      /retivo:assistantBridgePort must be an integer from 1024 to 65535/,
    );
  });
}
