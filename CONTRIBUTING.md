# Contributing

## Setup

- Node.js 24 or newer, npm, git.
- `npm ci`, then the three gates below. They are the same commands CI runs.

```bash
npm run typecheck   # tsc, strict
npm test            # node:test over src/**/*.test.ts
npm run test:pack   # the packed tarball installs and runs in an empty directory
```

Live Ainoflow tests (`src/state/ainoflow.live.test.ts`) run only when `AINOFLOW_API_KEY` is set;
everything they write lives in a throwaway namespace and expires by itself.

## Code

- TypeScript with only erasable syntax, so Node runs the sources directly in tests; `npm run build`
  emits `dist/`. Named exports only.
- The runtime stays generic: no project names, labels, milestones or forge vocabulary in `src/`.
  Project logic belongs in a project's scripts and skills.
- Every module has a colocated `*.test.ts`. Tests use the file state driver and real temporary
  directories; a test that needs a crashed process kills a real one.
- Errors are `OperatorError` with a stable `code`; a failure is reported, never swallowed.

## Changes

Branch from `master`, open a pull request, keep one logical change per pull request. Commit
messages are one line, capitalised, past tense. Add a line under `## [Unreleased]` in
`CHANGELOG.md` for anything a user of the runtime would notice.
