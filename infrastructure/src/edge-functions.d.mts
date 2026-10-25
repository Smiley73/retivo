// Types for edge-functions.mjs, which stays plain ESM so `node --test` can execute the generated handlers.

export interface EdgeGateRule {
  readonly base: number;
  readonly mask: number;
}

export declare const CLOUDFRONT_FUNCTION_MAX_BYTES: number;

export declare function assertFunctionSize(code: string, label: string): string;

export declare function spaRouterCode(): string;

export declare function gatedSpaRouterCode(
  rules: ReadonlyArray<EdgeGateRule>,
): string;

export declare function gateOnlyCode(rules: ReadonlyArray<EdgeGateRule>): string;

export declare function securityHeadersCode(
  assistantBridgePort?: number,
): string;
