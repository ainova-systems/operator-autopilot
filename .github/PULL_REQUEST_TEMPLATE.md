<!-- See CONTRIBUTING.md for setup and the code standards. -->

**What changed**

**Why**

**How to confirm it**

## Checks

All three are CI-blocking and must be green locally before review:

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:pack`

## Non-negotiables

- [ ] The runtime stays generic: no project, label, milestone or forge vocabulary in `src/`.
- [ ] No force-push.
- [ ] One logical change per PR, revertible in a single commit.
- [ ] Every bug fix ships with a regression test that fails without the fix.
- [ ] `CHANGELOG.md` has a line under `## [Unreleased]` when a user of the runtime would notice.
