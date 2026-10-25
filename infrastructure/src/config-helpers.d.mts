// Types for config-helpers.mjs, which stays plain ESM so `node --test` imports it without a TS runner.

export declare const CLOUDWATCH_LOG_RETENTION_DAYS: ReadonlyArray<number>;

export declare function parseRequiredBoolean(
  get: (key: string) => string | undefined,
  key: string,
): boolean;

export declare function anythingSendsAlerts(
  switches: Readonly<Record<string, boolean>>,
): boolean;

export declare function parseAlarmNotificationEmail(
  get: (key: string) => string | undefined,
  switches: Readonly<Record<string, boolean>>,
): string | undefined;

export declare function parseLogRetentionDays(
  get: (key: string) => string | undefined,
): number;

export declare const DEFAULT_LAMBDA_CONCURRENCY_QUOTA: number;

export declare function parseLambdaConcurrencyQuota(
  get: (key: string) => string | undefined,
): number;

export declare const DEFAULT_API_THROTTLE_RATE_PER_SEC: number;
export declare const DEFAULT_API_THROTTLE_BURST: number;

export declare function parseApiThrottle(
  get: (key: string) => string | undefined,
): { ratePerSec: number; burst: number };

export declare function parseEdgeAllowedIps(
  get: (key: string) => string | undefined,
): string[];

export declare function ipv4CidrToRule(cidr: string): {
  base: number;
  mask: number;
};

export declare function assertEdgeAllowedIpsForStack(
  stack: string,
  edgeAllowedIps: ReadonlyArray<string>,
): void;

export declare const ASSISTANT_BRIDGE_PORT_RANGE: {
  readonly min: number;
  readonly max: number;
};

export declare function parseAssistantBridgePort(
  get: (key: string) => string | undefined,
): number | undefined;
