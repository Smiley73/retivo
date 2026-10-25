// Pure parse/validate helpers for the stack config keys, free of @pulumi imports so `node --test` runs them.
// config.ts passes pulumi.Config's raw getter; see docs/deploy.md.

/**
 * CloudWatch Logs retention values the AWS API accepts; it silently coerces any other, so config load rejects it.
 * @type {ReadonlyArray<number>}
 */
export const CLOUDWATCH_LOG_RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827,
  2192, 2557, 2922, 3288, 3653,
];

/**
 * Parse a required boolean key; throws when absent, and accepts only "true" or "false".
 * @param {(key: string) => string | undefined} get raw string getter
 * @param {string} key bare config key (without the `retivo:` namespace)
 * @returns {boolean}
 */
export function parseRequiredBoolean(get, key) {
  const raw = get(key);
  if (raw === undefined || raw === "") {
    throw new Error(
      `retivo:${key} is required (no default). Set it to "true" or "false" in the stack config — see docs/deploy.md (Optional extras).`,
    );
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(
    `retivo:${key} must be "true" or "false" (got "${raw}").`,
  );
}

/**
 * The switches that make a stack send alerts: the four alarm groups and `enableBackups`.
 * @type {ReadonlyArray<string>}
 */
const ALERT_SWITCHES = [
  "enableSecurityAlarms",
  "enableApiHealthAlarms",
  "enableBackgroundJobAlarms",
  "enableCapacityAlarms",
  "enableBackups",
];

/**
 * The alert switches that are on, by key name; a missing key counts as off.
 * @param {Readonly<Record<string, boolean>>} switches parsed switch values
 * @returns {string[]}
 */
function enabledAlertSwitches(switches) {
  return ALERT_SWITCHES.filter((key) => switches[key] === true);
}

/**
 * Whether anything on this stack sends alerts. The alarm SNS topic (monitoring.ts) and the
 * `alarmNotificationEmail` requirement both follow it, so they cannot drift. Not stack-aware:
 * `enableCapacityAlarms` counts on a non-prod stack even though it deploys no alarms there.
 * @param {Readonly<Record<string, boolean>>} switches parsed switch values
 * @returns {boolean}
 */
export function anythingSendsAlerts(switches) {
  return enabledAlertSwitches(switches).length > 0;
}

/**
 * Parse `alarmNotificationEmail`, required whenever `anythingSendsAlerts(switches)`; otherwise
 * `undefined`. The format is not validated: a bad address fails as an SNS subscription error.
 * @param {(key: string) => string | undefined} get raw string getter
 * @param {Readonly<Record<string, boolean>>} switches parsed switch values
 * @returns {string | undefined}
 */
export function parseAlarmNotificationEmail(get, switches) {
  const needing = enabledAlertSwitches(switches);
  if (needing.length === 0) return undefined;
  const key = "alarmNotificationEmail";
  const raw = get(key);
  if (raw === undefined || raw === "") {
    throw new Error(
      `retivo:${key} is required because ${needing.map((n) => `retivo:${n}`).join(", ")} ${needing.length === 1 ? "is" : "are"} "true" — alerts need an inbox to go to. Run: pulumi config set retivo:${key} you@example.com`,
    );
  }
  return raw;
}

/**
 * Parse the required logRetentionDays key against the CloudWatch Logs enum.
 * @param {(key: string) => string | undefined} get raw string getter
 * @returns {number}
 */
export function parseLogRetentionDays(get) {
  const key = "logRetentionDays";
  const raw = get(key);
  if (raw === undefined || raw === "") {
    throw new Error(
      `retivo:${key} is required (no default). Set it to one of the AWS CloudWatch Logs retention values, e.g. 7 (dev) or 90 (prod) — see docs/deploy.md (Longer log retention).`,
    );
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || !CLOUDWATCH_LOG_RETENTION_DAYS.includes(value)) {
    throw new Error(
      `retivo:${key} must be one of the AWS CloudWatch Logs retention values [${CLOUDWATCH_LOG_RETENTION_DAYS.join(", ")}] (got "${raw}").`,
    );
  }
  return value;
}

/**
 * Default lambdaConcurrencyQuota: the shared Lambda concurrency quota (dev and prod share one account).
 * @type {number}
 */
export const DEFAULT_LAMBDA_CONCURRENCY_QUOTA = 10;

/**
 * Parse the optional lambdaConcurrencyQuota key. It sets the prod ConcurrentExecutions alarm threshold
 * (`quota - 2`), so a non-integer or a value under 3 (no usable headroom) throws.
 * @param {(key: string) => string | undefined} get raw string getter
 * @returns {number}
 */
export function parseLambdaConcurrencyQuota(get) {
  const key = "lambdaConcurrencyQuota";
  const raw = get(key);
  if (raw === undefined || raw === "") {
    return DEFAULT_LAMBDA_CONCURRENCY_QUOTA;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 3) {
    throw new Error(
      `retivo:${key} must be an integer >= 3 (got "${raw}") — it feeds the ConcurrentExecutions alarm threshold (quota - 2) directly, and a smaller value would leave that alarm no usable headroom. Run: pulumi config set retivo:${key} 10`,
    );
  }
  return value;
}

/**
 * Default `$default` route steady-state requests per second.
 * @type {number}
 */
export const DEFAULT_API_THROTTLE_RATE_PER_SEC = 20;

/**
 * Default `$default` route burst.
 * @type {number}
 */
export const DEFAULT_API_THROTTLE_BURST = 50;

/**
 * Parse one optional positive-integer throttle key.
 * @param {(key: string) => string | undefined} get raw string getter
 * @param {string} key bare config key
 * @param {number} fallback value when the key is absent or blank
 * @returns {number}
 */
function parsePositiveInteger(get, key, fallback) {
  const raw = get(key);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `retivo:${key} must be a positive integer (got "${raw}"). Run: pulumi config set retivo:${key} ${fallback}`,
    );
  }
  return value;
}

/**
 * Parse the optional API Gateway throttle pair. AWS treats them as independent targets, so a burst
 * below the rate is legal and no cross-field rule applies.
 * @param {(key: string) => string | undefined} get raw string getter
 * @returns {{ ratePerSec: number, burst: number }}
 */
export function parseApiThrottle(get) {
  return {
    ratePerSec: parsePositiveInteger(
      get,
      "apiThrottleRatePerSec",
      DEFAULT_API_THROTTLE_RATE_PER_SEC,
    ),
    burst: parsePositiveInteger(
      get,
      "apiThrottleBurst",
      DEFAULT_API_THROTTLE_BURST,
    ),
  };
}

/**
 * Port range the assistant connector's loopback `connect-src` entry may name. Shared with the CSP
 * generator (edge-functions.mjs) and the build-time check in infrastructure/scripts/lib/deploy-common.sh.
 * @type {{ min: number, max: number }}
 */
export const ASSISTANT_BRIDGE_PORT_RANGE = { min: 1024, max: 65_535 };

/**
 * Parse the optional `assistantBridgePort` key. Absent or blank means the connector is off; otherwise
 * a plain decimal integer in {@link ASSISTANT_BRIDGE_PORT_RANGE}.
 * @param {(key: string) => string | undefined} get raw string getter
 * @returns {number | undefined}
 */
export function parseAssistantBridgePort(get) {
  const key = "assistantBridgePort";
  const raw = get(key);
  if (raw === undefined || raw.trim() === "") return undefined;
  const text = raw.trim();
  const { min, max } = ASSISTANT_BRIDGE_PORT_RANGE;
  const value = /^[0-9]+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `retivo:${key} must be an integer from ${min} to ${max} (got "${raw}") — it sets the SPA's bridge port and the one loopback entry in the CSP connect-src. Run: pulumi config set retivo:${key} 24580, or remove it: pulumi config rm retivo:${key}`,
    );
  }
  return value;
}

// Plain decimal only: `010.0.0.1` is octal to inet_aton/curl but decimal to a naive parse.
const IPV4_CIDR_RE =
  /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})(?:\/(0|[1-9]\d?))?$/;

/**
 * Parse the optional `edgeAllowedIps` key: comma-separated IPv4 addresses or IPv4/prefix blocks,
 * normalised to `a.b.c.d/nn`. Blank means the gate is off. A `/0` is rejected because it allows
 * every viewer (and a 32-bit shift by 32 is undefined in JS).
 * @param {(key: string) => string | undefined} get raw string getter
 * @returns {string[]} normalised CIDR strings
 */
export function parseEdgeAllowedIps(get) {
  const key = "edgeAllowedIps";
  const raw = get(key);
  if (raw === undefined || raw.trim() === "") return [];
  const fix = `Run: pulumi config set retivo:${key} "203.0.113.7/32,198.51.100.0/24"`;
  return raw.split(",").map((element) => {
    const entry = element.trim();
    if (entry === "") {
      throw new Error(
        `retivo:${key} contains an empty element (got "${raw}") — use a comma-separated list of IPv4 addresses or IPv4/prefix blocks. ${fix}`,
      );
    }
    const match = IPV4_CIDR_RE.exec(entry);
    if (!match) {
      throw new Error(
        `retivo:${key} entry "${entry}" is not a plain-decimal IPv4 address or IPv4/prefix block (no leading zeros; IPv6 is not supported by the edge gate). ${fix}`,
      );
    }
    const octets = match.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) {
      throw new Error(
        `retivo:${key} entry "${entry}" has an octet above 255. ${fix}`,
      );
    }
    const prefix = match[5] === undefined ? 32 : Number(match[5]);
    if (prefix < 1 || prefix > 32) {
      throw new Error(
        `retivo:${key} entry "${entry}" has a prefix outside 1–32 (a /0 would allow everyone). ${fix}`,
      );
    }
    return `${octets.join(".")}/${prefix}`;
  });
}

/**
 * Turn a normalised CIDR into the unsigned `{ base, mask }` pair the CloudFront Function compares:
 * `((ip & mask) >>> 0) === base`.
 * @param {string} cidr normalised IPv4 CIDR
 * @returns {{ base: number, mask: number }}
 */
export function ipv4CidrToRule(cidr) {
  const match = IPV4_CIDR_RE.exec(cidr);
  if (!match || match[5] === undefined) {
    throw new Error(`ipv4CidrToRule expects a normalised a.b.c.d/nn (got "${cidr}")`);
  }
  const prefix = Number(match[5]);
  if (prefix < 1 || prefix > 32) {
    throw new Error(`ipv4CidrToRule prefix must be 1–32 (got "${cidr}")`);
  }
  const addr = match
    .slice(1, 5)
    .map(Number)
    .reduce((acc, octet) => ((acc << 8) | octet) >>> 0, 0);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (addr & mask) >>> 0, mask };
}

/**
 * Fails config load when the public prod stack has a non-empty edge allowlist; the gate is dev-only.
 * @param {string} stack Pulumi stack name
 * @param {ReadonlyArray<string>} edgeAllowedIps parsed allowlist
 */
export function assertEdgeAllowedIpsForStack(stack, edgeAllowedIps) {
  if (stack === "prod" && edgeAllowedIps.length > 0) {
    const count = `${edgeAllowedIps.length} ${edgeAllowedIps.length === 1 ? "entry" : "entries"}`;
    throw new Error(
      `retivo:edgeAllowedIps must be empty on the prod stack (got ${count}) — prod is a public product; the edge IP gate is dev-only. Remove the key from the prod stack config: pulumi config rm retivo:edgeAllowedIps --stack prod`,
    );
  }
}
