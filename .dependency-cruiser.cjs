/**
 * Module-boundary + cycle enforcement.
 * Run via `pnpm depcruise`; gated in `pnpm gate` + CI.
 *
 * Config schema: node_modules/dependency-cruiser/types/*.d.mts (the
 * installed package's own type defs) + the rules-reference doc at
 * https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md
 *
 * KNOWN-GAP NOTE: when these rules were first turned on they surfaced far
 * more pre-existing violations than the one intended cycle exception.
 * Rather than silently baseline them away or refactor ~60 unrelated files
 * at once, every pre-existing violation is grandfathered here as an
 * explicit, itemized, commented `pathNot` entry (never a blanket directory
 * carve-out) so the rule still catches every *new* violation going
 * forward. Each entry below says what the violation is; retiring them
 * means relocating the shared types or values into lib, file by file.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-cycles',
      severity: 'error',
      comment:
        'Architecture rule: no import cycles in apps/web/src, apps/api/src, ' +
        'apps/mcp-bridge/src or packages/assistant-protocol/src. ' +
        'Cycles make module boundaries and load order impossible to reason ' +
        'about. Known-gap exceptions below (KNOWN-GAP NOTE, top of file) are ' +
        'pre-existing and grandfathered, not endorsed — do not add new ones; ' +
        'a new cycle should be broken, not appended to this list.',
      from: {},
      to: {
        circular: true,
        pathNot: [
          // --- Authorized exception: the documented inert cycle between the
          // Monte-Carlo engine and its sharding module. ---
          'apps/web/src/lib/monte-carlo\\.ts',
          'apps/web/src/lib/monte-carlo-shard\\.ts',

          // --- Authorized exception: the documented inert cycle
          // between the Monte-Carlo engine and its post-loop
          // summary-reducer module. `monte-carlo-summary.ts`
          // imports `runOnePath` / `buildRunContext` / `seedForPathIndex` /
          // `RunContext` / `PathLoopAccumulation` from `monte-carlo.ts`;
          // `monte-carlo.ts` imports `assembleMonteCarloSummary` back
          // (see the `import { assembleMonteCarloSummary } from
          // './monte-carlo-summary.js'` line in monte-carlo.ts, just above
          // its `export type { McTaxContext }` block) so `runMonteCarlo` can
          // still call it. Same shape as the monte-carlo-shard.ts exception
          // above: all cross-module references are call-site bindings, so
          // the cycle is inert at runtime. ---
          'apps/web/src/lib/monte-carlo-summary\\.ts',

          // --- Authorized exception: the documented inert cycle
          // between the Monte-Carlo engine and its per-path step-input
          // assembly module. `monte-carlo-step-inputs.ts` imports `RunContext`
          // (type-only, erased at compile time) from `monte-carlo.ts`;
          // `monte-carlo.ts` imports `buildStepInputs` / `computeYearSums` /
          // `cpiShiftMonthlyFor` back (see the `import { buildStepInputs, ... }
          // from './monte-carlo-step-inputs.js'` line in monte-carlo.ts, just
          // below the `assembleMonteCarloSummary` import) so `buildRunContext`
          // and `runOnePath` can still call them. Same shape as the
          // monte-carlo-shard.ts / monte-carlo-summary.ts exceptions above: all
          // cross-module references are call-site bindings, so the cycle is
          // inert at runtime. ---
          'apps/web/src/lib/monte-carlo-step-inputs\\.ts',

          // --- KNOWN GAP: pre-existing, all type-only-closed (the cycle
          // exists only in `type` positions that are erased at compile
          // time). Grouped by pattern below. ---

          // Lazy-loaded chart wrapper <-> its `Inner` implementation: the
          // wrapper `lazy()`-imports Inner (a real runtime edge) and Inner
          // imports the wrapper's exported Props type back (type-only,
          // erased at compile time — the cycle doesn't exist at runtime).
          // The CashflowProjectionChart/Inner/tooltip trio broke this
          // pattern by relocating the shared types to
          // lib/cashflow-chart-types.ts — no longer grandfathered here.
          'apps/web/src/components/AccountHistoryCharts\\.tsx',
          'apps/web/src/components/AccountHistoryChartsInner\\.tsx',
          'apps/web/src/components/IncomeBreakdownChart\\.tsx',
          'apps/web/src/components/IncomeBreakdownChartInner\\.tsx',
          'apps/web/src/components/PlanStressTestSection\\.tsx',
          'apps/web/src/components/PlanStressTestCards\\.tsx',
          'apps/web/src/components/PlanStressTestChart\\.tsx',
          'apps/web/src/components/PortfolioFlowsChart\\.tsx',
          'apps/web/src/components/PortfolioFlowsChartInner\\.tsx',
          'apps/web/src/components/ProjectionChart\\.tsx',
          'apps/web/src/components/ProjectionChartInner\\.tsx',
          'apps/web/src/components/QcdChart\\.tsx',
          'apps/web/src/components/QcdChartInner\\.tsx',
          'apps/web/src/components/QcdRmdSplitChart\\.tsx',
          'apps/web/src/components/QcdRmdSplitChartInner\\.tsx',
          'apps/web/src/components/RmdChart\\.tsx',
          'apps/web/src/components/RmdChartInner\\.tsx',
          'apps/web/src/components/RothConversionsChart\\.tsx',
          'apps/web/src/components/RothConversionsChartInner\\.tsx',
          'apps/web/src/components/TaxBurdenChart\\.tsx',
          'apps/web/src/components/TaxBurdenChartInner\\.tsx',

          // auth <-> step-up-modal family (same shape: a hook imports a
          // component's exported type back).
          'apps/web/src/auth/AuthContext\\.tsx',
          'apps/web/src/auth/useMfaManagement\\.ts',
          'apps/web/src/components/useStepUp\\.ts',

          // lib/lib helper-pairs split into "primary" + "types/helpers"
          // files that import each other back (a second, previously-
          // undocumented Monte-Carlo cycle among them: monte-carlo.ts <->
          // monte-carlo-per-account.ts, distinct from the authorized
          // monte-carlo-shard.ts one above).
          'apps/web/src/lib/drawdown-engine-per-account-strategy-helpers\\.ts',
          'apps/web/src/lib/drawdown-engine-types\\.ts',
          'apps/web/src/lib/federal-tax-extrapolation\\.ts',
          'apps/web/src/lib/tax-integration-helpers\\.ts',
          'apps/web/src/lib/monte-carlo-per-account\\.ts',
          'apps/web/src/lib/optimizer-mc-runner-empty-state\\.ts',
          'apps/web/src/lib/optimizer-mc-runner-helpers\\.ts',
          'apps/web/src/lib/rmd\\.ts',
          'apps/web/src/lib/rmd-validation\\.ts',

          // pages/* clusters: Balance Projection page slices, the SS
          // optimizer row/cell family, and the AccountBalancesPage table
          // pair all cross-import within their own cluster.
          'apps/web/src/pages/AccountBalancesPage\\.tsx',
          'apps/web/src/pages/BalanceTable\\.tsx',
          'apps/web/src/pages/TwrSummary\\.tsx',
          'apps/web/src/pages/balance-projection-page-cashflow\\.ts',
          'apps/web/src/pages/balance-projection-page-constants\\.ts',
          'apps/web/src/pages/balance-projection-page-data\\.ts',
          'apps/web/src/pages/balance-projection-page-drawdown\\.ts',
          'apps/web/src/pages/balance-projection-page-pipeline\\.ts',
          'apps/web/src/pages/balance-projection-page-yearly\\.tsx',
          'apps/web/src/pages/balance-projection-page-yearly-breakdown\\.tsx',
          'apps/web/src/pages/balance-projection-page-yearly-cashflow\\.tsx',
          'apps/web/src/pages/balance-projection-page-yearly-income-breakdown\\.tsx',
          'apps/web/src/pages/balance-projection-page-yearly-portfolio-flows\\.tsx',
          'apps/web/src/pages/balance-projection-page-yearly-table\\.tsx',
          'apps/web/src/pages/ss-optimizer-age-cell\\.tsx',
          'apps/web/src/pages/ss-optimizer-det-group\\.tsx',
          'apps/web/src/pages/ss-optimizer-method-child-row\\.tsx',
          'apps/web/src/pages/ss-optimizer-page-chrome\\.tsx',
          'apps/web/src/pages/ss-optimizer-row-variants\\.tsx',
          'apps/web/src/pages/ss-optimizer-row-view\\.ts',
        ],
      },
    },
    {
      name: 'lib-independent-of-ui',
      severity: 'error',
      comment:
        'Architecture rule: apps/web/src/lib is UI-framework-independent — ' +
        'it must not import from components/ or pages/. UI code depends on ' +
        'lib, never the other way; a lib file that needs a component/page ' +
        'shape means that shape belongs in lib instead. (Importing the ' +
        "'react' package itself — e.g. for hooks — is unaffected; only " +
        'component/page module imports are banned.) Known-gap exceptions ' +
        'below (KNOWN-GAP NOTE, top of file) are the specific pre-existing ' +
        'lib source files grandfathered for this violation — the exemption ' +
        'is scoped to those files, not to the component/page targets they ' +
        'import, so any other lib file (new or existing) importing any of ' +
        'these same targets still fails the rule. Do not add new entries.',
      from: {
        path: '^apps/web/src/lib',
        pathNot: [
          // KNOWN GAP: lib/pdf-export adapters (build-pdf.ts, pdf-labels.ts,
          // pdf-tables.ts, plus their .test.ts files) pre-date this rule and
          // import ~10 chart/page row types purely for `type` positions
          // (erased at compile time) plus one value import
          // (aggregationTypeLabel). cashflow-series.ts and
          // expense-preview-projection.ts each have one further type-only
          // import of the same shape. balance-projection-runner-qcd-display-
          // basis.test.ts has one value import
          // (buildQcdRows). The fix is to relocate these shapes into lib,
          // the same pattern as cashflow-chart-types.ts.
          'apps/web/src/lib/balance-projection-runner-qcd-display-basis\\.test\\.ts',
          'apps/web/src/lib/cashflow-series\\.ts',
          'apps/web/src/lib/expense-preview-projection\\.ts',
          'apps/web/src/lib/pdf-export/build-pdf\\.ts',
          'apps/web/src/lib/pdf-export/build-pdf\\.test\\.ts',
          'apps/web/src/lib/pdf-export/pdf-labels\\.ts',
          'apps/web/src/lib/pdf-export/pdf-tables\\.ts',
          'apps/web/src/lib/pdf-export/pdf-tables\\.test\\.ts',
        ],
      },
      to: {
        path: '^apps/web/src/(components|pages)',
      },
    },
    {
      name: 'assistant-independent-of-ui',
      severity: 'error',
      comment:
        'Architecture rule: apps/web/src/assistant is the AI assistant ' +
        'connector\'s logic layer (session state machine, provider and hook, ' +
        'dispatcher, audit log, diagnosis) and must not import from ' +
        'components/ or pages/. Every UI piece, the settings card included, ' +
        'lives in pages/ or components/ and imports from assistant/. No ' +
        'grandfathered exceptions.',
      from: { path: '^apps/web/src/assistant' },
      to: { path: '^apps/web/src/(components|pages)' },
    },
    {
      name: 'assistant-protocol-is-a-leaf',
      severity: 'error',
      comment:
        'Architecture rule: packages/assistant-protocol is a leaf shared by ' +
        'the bridge and the tab. Its runtime code may import only zod and ' +
        'Node built-ins: never an app, infrastructure, packages/contracts ' +
        'or any other npm package. Tests may import their test tooling.',
      from: {
        path: '^packages/assistant-protocol/src',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        path: '^(apps|infrastructure)/|^packages/contracts/|(^|/)node_modules/(?!.*/zod/|zod/)',
      },
    },
    {
      name: 'mcp-bridge-is-a-leaf',
      severity: 'error',
      comment:
        'Architecture rule: apps/mcp-bridge is a standalone bin that talks to ' +
        'the app only over the WebSocket protocol. It imports nothing from ' +
        'apps/web, apps/api, packages/contracts or infrastructure, and from ' +
        'npm only the MCP SDK, ws and the shared protocol package. Tests may ' +
        'import their test tooling.',
      from: {
        path: '^apps/mcp-bridge/src',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        path: '^apps/(web|api)/|^packages/contracts/|^infrastructure/|(^|/)node_modules/',
        pathNot:
          '(^|/)node_modules/(@modelcontextprotocol/(server|core)|ws|@types/ws|@retirement/assistant-protocol)/',
      },
    },
    {
      name: 'web-does-not-import-mcp-bridge',
      severity: 'error',
      comment:
        'Architecture rule: the bridge is a separate process the person runs ' +
        'beside their agent; the web app shares code with it only through ' +
        'packages/assistant-protocol, never by importing the bridge.',
      from: { path: '^apps/web/src' },
      to: { path: '^apps/mcp-bridge/' },
    },
    {
      name: 'db-layering',
      severity: 'error',
      comment:
        'Architecture rule: apps/web/src/db is the IndexedDB data-access ' +
        'layer — it must not import from components/, pages/, or sync/. ' +
        'pages -> db/store is the intended data-access pattern and stays ' +
        'allowed; db must never reach back up into UI or sync.',
      from: { path: '^apps/web/src/db' },
      to: { path: '^apps/web/src/(components|pages|sync)' },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    // Don't cruise into vendor code — cycles inside third-party packages
    // aren't this repo's architecture to fix, and following them balloons
    // both runtime and noise.
    doNotFollow: {
      path: 'node_modules',
    },
  },
};
