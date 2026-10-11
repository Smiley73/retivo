// Fallback placeholder for the janitor Lambda. Used by Pulumi only on
// a fresh checkout that hasn't run `pnpm --filter @retirement/api
// build:lambda` yet — the real handler is `apps/api/src/janitor-lambda.ts`,
// shipped as part of the same artifact as the api + compactor Lambdas.

export const handler = async (event) => {
  console.log(JSON.stringify({
    msg: "janitor placeholder; no retention sweep performed",
    eventTime: event?.time ?? new Date().toISOString(),
  }));
  return { ok: true, placeholder: true };
};
