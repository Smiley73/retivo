// Placeholder for the signup-approval cascade Lambda. Real handler is
// bundled from apps/api/src/signup-cascade-lambda.ts via
// `pnpm --filter @retirement/api build:lambda`. This shell only exists so
// `pulumi preview` succeeds on a fresh checkout that hasn't built yet —
// the handler does nothing.

export const handler = async () => ({
  batchItemFailures: [],
});
