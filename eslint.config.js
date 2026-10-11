import parser from '@typescript-eslint/parser';
import plugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default [
  {
    files: ['apps/api/src/**/*.ts'],
    languageOptions: {
      parser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: { '@typescript-eslint': plugin },
    rules: {
      ...plugin.configs.recommended.rules,
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: {
      parser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    plugins: { '@typescript-eslint': plugin },
    rules: {
      ...plugin.configs.recommended.rules,
      // Storage-mechanism lock (clear-local-data nuke). Keeps the
      // `clearAllLocalData()` nuke complete as new storage MECHANISMS are
      // added. The blanket localStorage/sessionStorage clear already
      // covers every key regardless of name, so this guards only the
      // remaining vector: a NEW persistence mechanism slipped in without
      // extending the nuke. The `idb` import ban is the load-bearing rule
      // (the only real IndexedDB opener); the global/property rules are
      // belt-and-suspenders (they catch the common syntax, not aliasing).
      // Carve-outs for the two audited homes (db/store.ts, lib/local-data.ts)
      // are override blocks AFTER this one (flat config is last-match-wins).
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'idb',
              message:
                'Adding a second IndexedDB database? `idb` is allowed only in apps/web/src/db/store.ts (the audited IDB home). A new database must be wiped by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'caches',
          message:
            'Cache Storage is allowed only in apps/web/src/lib/local-data.ts (the nuke). A new caches user must be cleared by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'navigator',
          property: 'serviceWorker',
          message:
            'Registering a service worker? Its caches must be cleared by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'indexedDB',
          property: 'deleteDatabase',
          message:
            '`indexedDB.deleteDatabase` is allowed only in apps/web/src/db/store.ts (the audited IDB home). New IndexedDB lifecycle must route through clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        // Ban raw IndexedDB opener (belt-and-suspenders alongside the `idb` import
        // ban — someone could bypass the import and call the native API directly).
        // The `idb` import ban is load-bearing; these three cover the alias forms.
        {
          object: 'indexedDB',
          property: 'open',
          message:
            'Opening a second IndexedDB database? `indexedDB.open` is allowed only in apps/web/src/db/store.ts (the audited IDB home). A new database must be wiped by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'globalThis',
          property: 'indexedDB',
          message:
            'Raw `globalThis.indexedDB` access is allowed only in apps/web/src/db/store.ts (the audited IDB home). Opening a second database must route through clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'window',
          property: 'indexedDB',
          message:
            'Raw `window.indexedDB` access is allowed only in apps/web/src/db/store.ts (the audited IDB home). Opening a second database must route through clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        // Member-expression forms of Cache Storage (no-restricted-globals catches
        // only bare `caches`; these three cover the globalThis/window/self aliases
        // so no-one can slip in a Cache Storage use outside the audited nuke home).
        {
          object: 'globalThis',
          property: 'caches',
          message:
            'Cache Storage via globalThis.caches is allowed only in apps/web/src/lib/local-data.ts (the nuke). A new caches user must be cleared by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'window',
          property: 'caches',
          message:
            'Cache Storage via window.caches is allowed only in apps/web/src/lib/local-data.ts (the nuke). A new caches user must be cleared by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'self',
          property: 'caches',
          message:
            'Cache Storage via self.caches is allowed only in apps/web/src/lib/local-data.ts (the nuke). A new caches user must be cleared by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
      ],
      // Tailwind-defaults styling (see docs/ui-conventions.md).
      // Two guards that keep the app on the Tailwind-defaults system; a
      // green tree-wide lint is the completeness proof that no
      // un-migrated legacy/off-system styling site remains.
      //
      // Escape hatch for a *genuinely* runtime-dynamic survivor only:
      //   // eslint-disable-next-line no-restricted-syntax -- <reason>
      // Per-line, with a concrete reason. Never a file-level blanket
      // disable.
      'no-restricted-syntax': [
        'error',
        {
          // (a) No static inline styles. Static styling is a Tailwind
          // utility / the typed component library. Only values computed
          // at render (Recharts color props, Modal/ConfirmDialog width,
          // popover/tooltip coordinates, RangeSlider `--range-pct`) may
          // remain inline — each carries the documented escape above.
          selector: "JSXAttribute[name.name='style']",
          message:
            'Inline style is banned (see docs/ui-conventions.md). Use a Tailwind utility or the typed component library. Genuinely runtime-dynamic styles get a per-line `// eslint-disable-next-line no-restricted-syntax -- <reason>`.',
        },
        {
          // (b) No raw arbitrary Tailwind utilities (`prefix-[value]`).
          // The only allowed bracket form is `…-[var(--*)]` (a CSS
          // custom property bridge). Arbitrary *variant* selectors
          // (`data-[…]:`, `aria-[…]:`, `group-[…]`, `peer-[…]`, `[&…]`)
          // are idiomatic Headless-UI/Tailwind and are NOT value
          // utilities — excluded. A genuinely irreducible structural
          // value (portal z-index, modal width %, table column %,
          // chart pixel height, responsive grid template) gets the
          // per-line documented escape above.
          selector:
            "Literal[value=/(?<![\\w:.-])(?!(?:data|aria|group|peer|has|supports|in|nth|not|where|is)-)[a-z][a-zA-Z0-9:/_.-]*-\\[(?!var\\(--)[^\\]]*\\](?=$|[\\s\"'`}])/]",
          message:
            'Raw arbitrary Tailwind utility is banned (see docs/ui-conventions.md) — use a default-scale token, or `…-[var(--*)]`. An irreducible structural value gets a per-line `// eslint-disable-next-line no-restricted-syntax -- <reason>`.',
        },
        {
          selector:
            "TemplateElement[value.cooked=/(?<![\\w:.-])(?!(?:data|aria|group|peer|has|supports|in|nth|not|where|is)-)[a-z][a-zA-Z0-9:/_.-]*-\\[(?!var\\(--)[^\\]]*\\](?=$|[\\s\"'`}])/]",
          message:
            'Raw arbitrary Tailwind utility is banned (see docs/ui-conventions.md) — use a default-scale token, or `…-[var(--*)]`. An irreducible structural value gets a per-line `// eslint-disable-next-line no-restricted-syntax -- <reason>`.',
        },
        {
          // (c) No raw arbitrary *property* utilities
          // (`[grid-template-columns:…]`, `[font-size:clamp(…)]`,
          // `[mask-type:…]`). The leading-bracket `[prop:value]` form
          // is distinct from the `prefix-[value]` form in (b) and was
          // previously unpoliced. Arbitrary *variant* selectors
          // (`[&…]:`, `[@…]:`) start with `&`/`@`, not a CSS property
          // ident, so they don't match and stay allowed; a
          // `[prop:var(--*)]` bridge stays allowed (parity with (b)).
          selector:
            "Literal[value=/(?<![\\w.-])\\[[a-z][a-z-]*:(?!var\\(--)[^\\]]+\\](?=$|[\\s\"'`:}])/]",
          message:
            'Raw arbitrary property utility is banned (see docs/ui-conventions.md) — use a default-scale utility, or `[prop:var(--*)]`. An irreducible structural value gets a per-line `// eslint-disable-next-line no-restricted-syntax -- <reason>`.',
        },
        {
          selector:
            "TemplateElement[value.cooked=/(?<![\\w.-])\\[[a-z][a-z-]*:(?!var\\(--)[^\\]]+\\](?=$|[\\s\"'`:}])/]",
          message:
            'Raw arbitrary property utility is banned (see docs/ui-conventions.md) — use a default-scale utility, or `[prop:var(--*)]`. An irreducible structural value gets a per-line `// eslint-disable-next-line no-restricted-syntax -- <reason>`.',
        },
      ],
    },
  },
  {
    files: ['apps/**/src/**/*.test.{ts,tsx}', 'apps/**/src/**/*.spec.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // Tests legitimately exercise `style`-prop forwarding and use
      // fixture utilities — they are not the styling surface the
      // Tailwind-defaults bans police. (The product `apps/web/src` block keeps
      // the bans on.)
      'no-restricted-syntax': 'off',
      // Ban wall-clock `performance.now()` assertions in tests: they flake
      // when a parallel agent worktree steals the CPU mid-run. A genuine
      // perf assertion belongs in a `*.bench.ts` file or a
      // PERF_ASSERT-gated `describe` (see monte-carlo.test.ts), each of
      // which gets a per-line `// eslint-disable-next-line
      // no-restricted-properties -- <reason>`.
      'no-restricted-properties': [
        'error',
        {
          object: 'performance',
          property: 'now',
          message:
            'Wall-clock assertions flake under parallel agent worktrees — use *.bench.ts or a PERF_ASSERT-gated describe (see monte-carlo.test.ts).',
        },
        // Re-declare the storage-lock guardrail set from the general
        // apps/web/src block. Flat config is last-match-wins per rule: this
        // later-matching test block REPLACES (not merges) the array, so the
        // storage-lock bans must be repeated here verbatim or they silently
        // drop for every apps/web/src test file.
        {
          object: 'navigator',
          property: 'serviceWorker',
          message:
            'Registering a service worker? Its caches must be cleared by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'indexedDB',
          property: 'deleteDatabase',
          message:
            '`indexedDB.deleteDatabase` is allowed only in apps/web/src/db/store.ts (the audited IDB home). New IndexedDB lifecycle must route through clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'indexedDB',
          property: 'open',
          message:
            'Opening a second IndexedDB database? `indexedDB.open` is allowed only in apps/web/src/db/store.ts (the audited IDB home). A new database must be wiped by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'globalThis',
          property: 'indexedDB',
          message:
            'Raw `globalThis.indexedDB` access is allowed only in apps/web/src/db/store.ts (the audited IDB home). Opening a second database must route through clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'window',
          property: 'indexedDB',
          message:
            'Raw `window.indexedDB` access is allowed only in apps/web/src/db/store.ts (the audited IDB home). Opening a second database must route through clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'globalThis',
          property: 'caches',
          message:
            'Cache Storage via globalThis.caches is allowed only in apps/web/src/lib/local-data.ts (the nuke). A new caches user must be cleared by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'window',
          property: 'caches',
          message:
            'Cache Storage via window.caches is allowed only in apps/web/src/lib/local-data.ts (the nuke). A new caches user must be cleared by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'self',
          property: 'caches',
          message:
            'Cache Storage via self.caches is allowed only in apps/web/src/lib/local-data.ts (the nuke). A new caches user must be cleared by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
      ],
    },
  },
  // Storage-mechanism carve-outs. Placed AFTER the general
  // apps/web/src block so they win (flat config is last-match-wins). Each
  // file is the one audited home for its mechanism; the header comment in
  // each names why it is allowed.
  {
    // db/store.ts is the sole IndexedDB home — it owns the `idb` opener
    // and the `deleteDatabase` lifecycle that the nuke delegates to.
    // Re-declare (not blanket-off) to keep Cache Storage + serviceWorker
    // bans active for this file; only the IDB entries are lifted.
    files: ['apps/web/src/db/store.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-properties': [
        'error',
        {
          object: 'navigator',
          property: 'serviceWorker',
          message:
            'Registering a service worker? Its caches must be cleared by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'globalThis',
          property: 'caches',
          message:
            'Cache Storage via globalThis.caches is allowed only in apps/web/src/lib/local-data.ts (the nuke). A new caches user must be cleared by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'window',
          property: 'caches',
          message:
            'Cache Storage via window.caches is allowed only in apps/web/src/lib/local-data.ts (the nuke). A new caches user must be cleared by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'self',
          property: 'caches',
          message:
            'Cache Storage via self.caches is allowed only in apps/web/src/lib/local-data.ts (the nuke). A new caches user must be cleared by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
      ],
    },
  },
  {
    // lib/local-data.ts is the nuke itself — the one legitimate Cache
    // Storage user (it clears every cache via globalThis.caches).
    // Re-declare (not blanket-off) to keep IDB + serviceWorker bans
    // active for this file; only the Cache Storage entries are lifted.
    files: ['apps/web/src/lib/local-data.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': [
        'error',
        {
          object: 'navigator',
          property: 'serviceWorker',
          message:
            'Registering a service worker? Its caches must be cleared by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'indexedDB',
          property: 'deleteDatabase',
          message:
            '`indexedDB.deleteDatabase` is allowed only in apps/web/src/db/store.ts (the audited IDB home). New IndexedDB lifecycle must route through clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'indexedDB',
          property: 'open',
          message:
            'Opening a second IndexedDB database? `indexedDB.open` is allowed only in apps/web/src/db/store.ts (the audited IDB home). A new database must be wiped by clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'globalThis',
          property: 'indexedDB',
          message:
            'Raw `globalThis.indexedDB` access is allowed only in apps/web/src/db/store.ts (the audited IDB home). Opening a second database must route through clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
        {
          object: 'window',
          property: 'indexedDB',
          message:
            'Raw `window.indexedDB` access is allowed only in apps/web/src/db/store.ts (the audited IDB home). Opening a second database must route through clearAllLocalData() — extend the nuke, then add a per-line documented disable.',
        },
      ],
    },
  },
];
