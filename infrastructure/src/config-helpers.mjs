// Pure, dependency-free parse/validate helpers for the stack config keys —
// both the required ones (enableWaf, manageCloudTrail, enablePitr,
// enableBackups, the four alarm-group switches, logRetentionDays, and the
// conditionally required alarmNotificationEmail) and the optional ones (lambdaConcurrencyQuota,
// edgeAllowedIps, apiThrottleRatePerSec, apiThrottleBurst). Kept out of
// config.ts — and free of any @pulumi
// import — so they can be unit-tested under `node --test` without AWS
// credentials or a Pulumi runtime (scripts/test/config-coverage.test.mjs).
// config.ts adapts pulumi.Config to the plain `(key) => string | undefined`
// getter these helpers consume. See docs/deploy.md.

/**
 * AWS CloudWatch Logs only accepts a fixed enum of retention periods.
 * Any other value is silently coerced by the AWS API, so we reject it at
 * config-load time instead. Source: AWS::Logs::LogGroup RetentionInDays.
 * @type {ReadonlyArray<number>}
 */
export const CLOUDWATCH_LOG_RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827,
  2192, 2557, 2922, 3288, 3653,
];

/**
 * Parse a REQUIRED boolean stack-config key. Fail loud when absent — these
 * cost knobs have no default so the operator must make an explicit choice.
 * Accepts only the canonical Pulumi boolean strings "true"/"false".
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
 * The switches that make a stack send alerts: the four alarm groups and
 * `enableBackups` (whose no-job alarm and failed-job rule alert on their own).
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
 * The alert switches that are on, by key name. Missing keys count as off.
 * @param {Readonly<Record<string, boolean>>} switches parsed switch values
 * @returns {string[]}
 */
function enabledAlertSwitches(switches) {
  return ALERT_SWITCHES.filter((key) => switches[key] === true);
}

/**
 * The single definition of "something on this stack sends alerts": any of the
 * four alarm groups or `enableBackups`. Both the alarm SNS topic
 * (monitoring.ts) and the `alarmNotificationEmail` requirement
 * (parseAlarmNotificationEmail) follow it, so they cannot drift apart. It is
 * deliberately not stack-aware: `enableCapacityAlarms` counts on a non-prod
 * stack even though that group deploys no alarms there.
 * @param {Readonly<Record<string, boolean>>} switches parsed switch values
 * @returns {boolean}
 */
export function anythingSendsAlerts(switches) {
  return enabledAlertSwitches(switches).length > 0;
}

/**
 * Parse the CONDITIONALLY required `alarmNotificationEmail` key. Required (and
 * non-empty) whenever `anythingSendsAlerts(switches)` is true; fail loud then,
 * naming the key, the switch(es) that need it and the fix, so a missing
 * address does not surface as an opaque SNS error at `pulumi up`. When nothing
 * sends alerts the key is neither required nor read, and `undefined` comes
 * back. Format validation is intentionally NOT done here: a bad address
 * surfaces as a failed SNS subscription with a clear AWS error, which is
 * acceptable for a single-operator ops key.
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
 * Parse + validate the REQUIRED logRetentionDays key against the AWS
 * CloudWatch Logs enum. Fail loud when absent or not an allowed value.
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
 * Default lambdaConcurrencyQuota when the key is absent: the account's
 * current shared Lambda concurrency quota (dev + prod share one account).
 * @type {number}
 */
export const DEFAULT_LAMBDA_CONCURRENCY_QUOTA = 10;

/**
 * Parse + validate the OPTIONAL lambdaConcurrencyQuota key. Absent ⇒
 * DEFAULT_LAMBDA_CONCURRENCY_QUOTA — raising the real quota is a config
 * change (`pulumi config set retivo:lambdaConcurrencyQuota <n>`), not a code
 * change. The value is fed straight into the prod-only ConcurrentExecutions
 * alarm's threshold (`quota - 2`), so a nonsense value must fail here rather
 * than deploy an alarm that can never leave ALARM: reject a non-integer or a
 * value too small (< 3) to leave the alarm any usable headroom.
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
 * Default API Gateway stage throttle when `apiThrottleRatePerSec` is absent:
 * steady-state requests per second across the whole `$default` route.
 * @type {number}
 */
export const DEFAULT_API_THROTTLE_RATE_PER_SEC = 20;

/**
 * Default API Gateway stage throttle burst when `apiThrottleBurst` is absent.
 * @type {number}
 */
export const DEFAULT_API_THROTTLE_BURST = 50;

/**
 * Parse one OPTIONAL positive-integer throttle key.
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
 * Parse + validate the OPTIONAL API Gateway stage-throttle pair:
 * `apiThrottleRatePerSec` (default 20) and `apiThrottleBurst` (default 50).
 * Both feed the `$default` stage's route settings verbatim. AWS treats them
 * as independent, best-effort targets (a burst below the rate is legal and
 * documented), so no cross-field rule is enforced here.
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

// Octets and the prefix must be plain decimal with no leading zero:
// `010.0.0.1` is octal 8 to inet_aton/curl but decimal 10 to a naive parse,
// so an operator would test one host and allow another. Reject it instead.
const IPV4_CIDR_RE =
  /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})(?:\/(0|[1-9]\d?))?$/;

/**
 * Parse the OPTIONAL `edgeAllowedIps` key: a comma-separated list of IPv4
 * addresses or IPv4/prefix CIDR blocks. Absent/blank ⇒ `[]` (the edge IP
 * gate is off). Every entry is normalised to `a.b.c.d/nn` (a bare address
 * becomes `/32`). Rejected, naming the key: an empty element, IPv6, a
 * partial or non-numeric address, a leading-zero octet or prefix (`010`,
 * `/01` — octal to inet_aton, decimal here), an octet above 255, or a prefix
 * outside 1–32 — `/0` stays rejected because it would allow every viewer
 * (and a 32-bit shift by 32 is undefined in JS). This is a guard against
 * the obvious mistake, not a proof of coverage: `0.0.0.0/1,128.0.0.0/1`
 * also allows everyone, and the operator gating their own dev stack is the
 * only party that could be hurt by it.
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
 * Turn a normalised IPv4 CIDR (`a.b.c.d/nn`, as produced by
 * parseEdgeAllowedIps) into the unsigned 32-bit `{ base, mask }` pair the
 * CloudFront Function compares against: `((ip & mask) >>> 0) === base`.
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
 * Stack guard for the edge IP gate: prod is a public product, so a
 * non-empty allowlist there is a misconfiguration and fails config load
 * before any resource is composed. A blank/absent key is fine on every
 * stack. Pure so the guard is testable without a Pulumi runtime.
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
