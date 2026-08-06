<!-- See CONTRIBUTING.md for setup and the full code standards. -->

**What changed**

**Why**

**What this deletes** <!-- list it, or write "nothing" -->

## Checks

All three are CI-blocking and must be green locally before review:

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run lint`

## Non-negotiables

- [ ] **No dead code.** Every export is reachable from `engine/entry.ts` or a colocated test (`ts-prune` + `knip`).
- [ ] **No force-push.** Every commit-push sequence is fast-forward-safe, including `--force-with-lease`.
- [ ] **One logical change per PR**, revertible in a single commit.
- [ ] Every bug fix ships with a regression test that fails without the fix.
- [ ] Docs and rules updated in this same PR if the change moved a convention.
