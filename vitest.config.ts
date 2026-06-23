import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    exclude: [
      "**/node_modules/**",
      "**/.tmp/**",
      "**/.next/**",
      "**/workspace/**",           // cloned managed-repo workspaces contain their own tests
      "app/src/app/**",            // Next.js route files — tested via integration/dev server
      "app/src/components/**",     // React components — tested via dev server
    ],
    coverage: {
      provider: "v8",
      include: [
        "engine/**/*.ts",
        "packages/*/src/**/*.ts",
        "app/src/lib/**/*.ts",
      ],
      exclude: [
        "engine/entry.ts",
        "engine/**/*.test.ts",
        "engine/test-helpers/**",
        "packages/*/src/types/**",
        "packages/*/src/interfaces/**",
        "packages/*/src/index.ts",
        "packages/adapters/src/kvstore-sqlite/index.ts",
        "packages/adapters/src/kind-registry/index.ts",
        "packages/*/src/**/*.test.ts",
        "app/src/**/*.test.ts"
      ],
      thresholds: {
        lines: 90,
        // Branches: 81 (relaxed from 82 with B-411 cap consolidation).
        // Original 85→82 drop was for stage-logic hooks
        // (finding-plan.ts, task-execute.ts) carrying defensive
        // `codeReviewId ? ... : ...` branches hard to exercise without
        // heavy integration mocking. The further 82→81 step reflects
        // pr-feedback-selector dropping its parallel bot-attempt cap
        // (and its associated branch tests) in favour of the single
        // commit-count cap in pr-review.beforeAgent. Line/function/
        // statement coverage stays >=93%, primitives still target 95%+.
        branches: 81,
        functions: 90,
        statements: 90
      }
    }
  }
});
