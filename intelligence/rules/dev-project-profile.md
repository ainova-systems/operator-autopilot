---
description: Project-specific configuration consumed by the intelligence-dev-packs rules and skills
---

# Project Profile

> Filled from the repository for the intelligence-dev-packs `core` pack. Skills resolve each
> value in order: this profile, then auto-detection, then asking once. Values marked
> `TODO(owner)` could not be detected and are left for the owner to set. Plain `key: value`
> lines only.
>
> Scope note: this profile describes how a developer works on THIS repository. It does NOT
> govern the engine's behavior on managed repos — that product rule (operator never pushes
> `master`/`main`/`develop`, authors `ai/<kind>/<id>` feature branches + PRs only) lives in
> `context.md`, `migration.md`, and `typescript.md` and is unaffected by this pack.

## Branching

- default_branch: master            <!-- detected: origin/HEAD -> origin/master -->
- integration_branch: none          <!-- detected: no origin/develop; trunk-based on master -->
- branch_prefixes: feature/, bugfix/, hotfix/   <!-- pack defaults; existing remote branches use no slash (e.g. fix-agent-lock-ttl) -->
- update_strategy: merge
- protected_branches: master        <!-- CONFLICT: owner's current own-repo practice commits directly to master; git-workflow pack rule treats the default branch as always protected. Owner decides — see report. -->

## Commits

- commit_style: pack-default        <!-- matches context.md exactly: one line, capital first letter, past tense, no prefixes -->
- reference_ids: none               <!-- commits carry no work-item id prefix; migration steps are referenced in prose only -->

## Verification

- typecheck: npm run typecheck      <!-- tsc --noEmit + app workspace typecheck -->
- lint: npm run lint                <!-- eslint + ts-prune + knip dead-code checks -->
- test: npm test                    <!-- vitest run --coverage -->
- coverage_gate: 90%                <!-- >=90% on touched files; >=95% for engine/pipeline/primitives -->

## Pull requests

- platform: github                  <!-- detected: origin is github.com/ainova-systems/operator-autopilot -->
- cli: gh
- pr_target: auto                   <!-- auto = integration branch when set, else default branch (master) -->
- merge_method: squash              <!-- owner-set: one PR = one logical change; operator branches carry noisy per-attempt commits -->
- delete_remote_branch: true        <!-- owner-set: git-merge-pr passes --delete-branch; short-lived branches are not kept after merge -->
- delete_local_branch: true         <!-- pack default, stated explicitly so it reads next to its remote counterpart -->

## Releases

- release_flow: tag-on-default      <!-- master is the single trunk; no develop -->
- changelog: continuous             <!-- every change appends ## [Unreleased]; release promotes it to ## [x.y.z] -->
- release_cut: release-pr           <!-- release/x.y.z branch → PR → CI green → merge → tag the merge commit -->
- release_artifact: github-release  <!-- publish a GitHub Release, not just a tag -->
- release_notes: changelog-section  <!-- body = the [x.y.z] CHANGELOG.md section -->
- tagger: maintainer                <!-- local git tag + push origin vX.Y.Z; CI tagging is a later upgrade -->
- version_source: package.json      <!-- bump here; mirrored in CHANGELOG.md; released as vX.Y.Z tags + GitHub Releases -->
- tag_format: vX.Y.Z

## Documentation

<!-- spec pack NOT installed: this repo uses its own deliberate docs tree
     (docs/workflow.md, docs/vision.md, docs/architecture-v5.md, docs/deployment.md),
     not the ai-first-docs specs/model/glossary layout. The spec-only
     keys (specs_dir, features_dir, rules_dir, decisions_dir) are intentionally omitted. -->
