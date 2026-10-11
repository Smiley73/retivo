// Placeholder for the api Lambda. Returns 501 NOT_IMPLEMENTED for every
// request. The real NestJS handler from apps/api is deployed from the api
// build and replaces this shell.

export const handler = async () => ({
  statusCode: 501,
  headers: {
    "content-type": "application/json",
    "x-content-type-options": "nosniff",
  },
  body: JSON.stringify({
    error: {
      code: "NOT_IMPLEMENTED",
      message:
        "Placeholder api Lambda; the real code is deployed from the api build.",
    },
  }),
});
