// ESLint flat config for the Operator v5 monorepo.
//
// Enforces the architectural invariants from docs/architecture-v5.md §2 and
// docs/workflow.md §15. Violations block CI:
//   - package boundary (core / adapters / engine / app)
//   - no imports from engine/pipeline/stages/* (directory does not exist in v5)
//   - no `any` / no `@ts-ignore` / no unused exports
//
// After Step 17 every rule below is `error`. The v4-style accumulation
// pattern (warn that piles up for weeks) is structurally impossible: each
// flagged violation blocks the merge. A grace window for test files is kept
// (explicit-any off, unused-vars relaxed) because test doubles legitimately
// use `any` in places where a narrow type would obscure intent.
//
// Run: npm run lint

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.next/**",
      "**/.tmp/**",
      "workspace/**",          // cloned managed-repo workspaces are not ours to lint
      "state/**",              // gitignored runtime state
      "app/next-env.d.ts",     // Next.js auto-generated, uses triple-slash refs by design
      "scripts/**",            // dev-only node scripts, linted via their own tsconfig if needed
      "dev/**",                // one-off migration / data-fix scripts, plain Node ESM
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Engine workspace (the root package.json is @operator/engine).
  //
  // Post-Step-17 every rule is `error`. Test files get a narrow relaxation
  // further down the config chain.
  {
    files: ["engine/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/pipeline/stages/*", "**/pipeline/stages"],
              message:
                "engine/pipeline/stages/ does not exist in v5. Stages are config in agents/workflow/stages.yaml — compose primitives via runStage instead. See docs/architecture-v5.md §3.",
            },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-function-type": "error",
      "@typescript-eslint/no-unused-expressions": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "prefer-const": "error",
    },
  },

  // Stage-logic boundary (D-503). Stage code may NOT reach into the VCS
  // platform for CI / pipeline data — the only sanctioned path is through
  // the `checks` slot of `statusSources` (filled by the reconciler) or
  // through primitives that wrap the call (`observeChecks`,
  // `writeChecksContextFile`). This keeps platform-specific code in
  // `platforms/**` and `primitives/**`, and prevents future contributors
  // from quietly bypassing the architecture.
  {
    files: ["engine/pipeline/stage-logic/**/*.ts", "engine/pipeline/run-stage.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='vcs'][property.name='getCheckRuns']",
          message:
            "Stage-logic must not call vcs.getCheckRuns directly. Use the `checks` slot on the work-item observation, or import `observeChecks` / `writeChecksContextFile` from primitives.",
        },
        {
          selector: "MemberExpression[object.name='deps'][property.name='vcs'] > Identifier[name='getCheckRuns']",
          message:
            "Stage-logic must not access vcs.getCheckRuns through deps. Route through primitives.",
        },
      ],
    },
  },

  // @operator/core — shared contracts; runtime: no I/O, no cross-workspace imports; zod only
  {
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@operator/adapters", "@operator/adapters/*"],
              message:
                "@operator/core cannot import from @operator/adapters. Core contains types and interfaces only; adapters depend on core, not the other way around.",
            },
            {
              group: ["@operator/engine", "@operator/engine/*", "@operator/app", "@operator/app/*"],
              message:
                "@operator/core cannot import from engine or app. Core is the lowest layer; its only runtime dependency is zod.",
            },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },

  // @operator/adapters — concrete implementations of core interfaces
  {
    files: ["packages/adapters/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@operator/engine", "@operator/engine/*", "@operator/app", "@operator/app/*"],
              message:
                "@operator/adapters cannot import from engine or app. Adapters implement @operator/core interfaces and are consumed by engine/app.",
            },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },

  // @operator/app — Next.js observability UI, read-only KV consumer
  {
    files: ["app/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@operator/engine", "@operator/engine/*"],
              message:
                "@operator/app cannot import @operator/engine runtime. Use @operator/core for types and @operator/adapters for read-only storage access.",
            },
            {
              group: ["@operator/adapters", "@operator/adapters/*"],
              message:
                "Only app/src/lib/app-kv.ts and app/src/lib/kv-factory.ts may import @operator/adapters. All other files go through getAppKV() or createKVStoreForConnection().",
            },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Exception: the factory files themselves must import the adapter, and
  // app-lib tests exercise the same KV backend directly to verify behavior
  // end-to-end against a real SQLite file (the whole point of
  // `architecture-v5.md §15a.1` is to test the real adapter, not a fake).
  {
    files: [
      "app/src/lib/app-kv.ts",
      "app/src/lib/kv-factory.ts",
      "app/src/lib/**/*.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@operator/engine", "@operator/engine/*"],
              message:
                "@operator/app cannot import @operator/engine runtime. Use @operator/core for types and @operator/adapters for read-only storage access.",
            },
          ],
        },
      ],
    },
  },

  // Test files: relax a couple of rules that make test ergonomics easier
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/test-helpers/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },
];
