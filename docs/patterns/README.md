# SDLC patterns

Sample workflows the [setup prompt](../setup.md) draws its recommendations from. Each pattern
states what it decides, why, what the project must supply, the failures it exists to prevent, and
its configuration knobs. None of them is shared code: a project adopts a pattern by writing its own
workflow, usually through the setup.

| Pattern | Decides |
|---|---|
| [Pull request pipeline with independent judges](pr-pipeline-independent-judges.md) | the phases a change passes, and that no actor judges its own work |
| [QA admission and drafts](qa-admission-and-drafts.md) | which pull requests hold the limited QA environments, and in what order |
| [Clarification phase](clarification-phase.md) | how a queue item waiting on an owner decision becomes ready without the owner hunting for it |
| [Conflict route](conflict-route.md) | what happens to a pull request that conflicts with its base in a late phase |
| [Owner signals](owner-signals.md) | how the owner steers a pull request, and how the pipeline tells the owner's words from its own |
| [Merge gates](merge-gates.md) | what must hold on the exact head before anything merges |

[reference-pr-pipeline.md](reference-pr-pipeline.md) ties them together as one complete, anonymized
workflow from a web application with per-pull-request preview environments.

## Principles every pattern keeps

- **Discovery finds, a phase decides.** A deterministic discovery script asks for operations; the
  phase skill re-reads the live state and may end `noop`. A request is a pointer, never the state.
- **A request key names what the operation would see.** The same state asks the same key, so a
  discovery that runs every few minutes asks for each piece of work once; a changed input asks again.
- **A factor is a claim about one head.** A push invalidates every factor; a gate checks freshness,
  never the label alone.
- **The owner decides, the pipeline asks.** A question has context, options and a recommendation;
  an answer is recorded where the next run reads it; an answer is never a general permission.
- **A change never reaches a task in flight.** A branch runs the workflow it was created with.
