# Setting up a managed project

The prompts themselves are in the README's [Fast start](../README.md#fast-start); this page says
what each one decides and why. They follow the setup steps of
[project-boundaries.md](project-boundaries.md#the-setup-prompt).

| Prompt | Run | Ends with |
|---|---|---|
| 1. Install Operator on a host | once per host | the runtime installed, the state key in an env file, a checklist |
| 2a. The project's own workflow | at the repository root | a workflow written for this repository alone |
| 2b. The recommended workflow | at the repository root | the development packs installed and adapted to this repository |

## Why the prompts work this way

- **One question at a time, with a recommendation.** Every choice a workflow makes - phases, judges,
  QA admission, merge gates - is the owner's. The prompts research first, then ask; nothing is
  decided silently, and the pattern docs supply the options and the reasoning behind each.
- **The host and the repository are separate.** Installing the runtime, its state key and the
  service user is host work and happens once; the workflow is repository work and is committed.
  A secret never crosses into the repository: the state key lives in an env file with mode 600 that
  the service reads.
- **Nothing is enabled before the owner sees it work.** `operator validate --describe` resolves
  every operation and script, and `operator run --dry-run` shows the requests discovery would make
  for the repository's current pull requests and queue. The service is installed only on the
  owner's go.
- **A change never reaches a task in flight.** A pipeline branch runs the skills and rules it was
  created with. A newer workflow, or a newer pack version, applies to branches started after it.
  The one exception is an engine that is unavailable, which the manifest swaps for every run.

## 2a or 2b

2a suits a repository whose process the reference pipeline does not fit: the setup writes the
discovery script and one skill per phase for this repository, and the project owns them from then
on. 2b suits a repository that wants the reference pull-request pipeline: the phase skills come from
the `operator` pack through intelligence, and the setup writes only what is the repository's own -
the profile keys, the workflow configuration, the discovery script built on the pack's helpers, and
rules for whatever the packs do not cover. Under 2b the installed packs are never edited in place;
a repository that needs different behaviour overrides it with its own rule or configuration, or
moves to 2a for that part.

After either setup the workflow is the project's own code and changes through its normal review.
