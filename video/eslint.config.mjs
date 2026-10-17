import { config } from "@remotion/eslint-config-flat";

export default [
  ...config,
  // The helper scripts run in Node, not in the browser the Remotion rules assume.
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
];
