// Type declarations for the dependency-free edge-functions.mjs runtime module
// (CloudFront Function source generators). The implementation is plain ESM JS
// so `node --test` can execute the generated handlers
// (scripts/test/edge-functions.test.mjs); this .d.mts gives cloudfront.ts the
// compile-time types tsc needs.

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
