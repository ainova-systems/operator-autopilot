# Contributing

## Setup

- Node.js 24 or newer, npm, git.
- `npm ci`, then the three gates below. They are the same commands CI runs.

```bash
npm run typecheck   # tsc, strict
npm test            # node:test over src/**/*.test.ts
npm run test:pack   # the packed tarball installs and runs in an empty directory
```

Live Ainoflow tests (`src/state/ainoflow.live.test.ts`) run only when `AINOFLOW_API_KEY` is set,
in the environment or in a gitignored `.env.local` that `npm test` reads (copy
`.env.local.example`). Everything they write lives in a throwaway namespace and expires by itself.
CI sets the key from the `AINOFLOW_API_KEY` repository secret; a fork's pull request has no secret
and skips them.

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

## Releases

A release is a GitHub Release on `master`; `.github/workflows/release.yml` does the rest.

1. In a pull request, set `version` in `package.json` (`npm version --no-git-tag-version X.Y.Z`)
   and turn `## [Unreleased]` in `CHANGELOG.md` into `## [X.Y.Z]`.
2. After it merges, publish a GitHub Release tagged `vX.Y.Z` on `master`, or `vX.Y.Z-rc.N` marked
   as a prerelease.
3. The workflow checks that the tag matches `package.json` and sits on `master`, runs the gates,
   publishes the package to npm (`latest`, or `next` for a release candidate) with provenance, and
   pushes the image to GHCR (`X.Y.Z`, plus `latest` for a final release).

Publishing needs the `NPM_TOKEN` repository secret: a granular npm token with publish rights on the
`ainova-systems` organisation.
