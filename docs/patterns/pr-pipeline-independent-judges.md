# Pull request pipeline with independent judges

**Decides:** the phases a change passes from a queue item to a merged pull request, which operation
owns each phase, and that the actor who wrote the code never awards itself a success factor.

## Phases

| Phase (milestone) | Operation | Done when | Hands to |
|---|---|---|---|
| In Queue | plan | acceptance criteria and a plan are on the PR; its verification steps are declared | Development |
| Development | implement → review → review-verdict, repeated | plan complete, a review with no critical finding at the head, CI green | Verification |
| Verification | verify | the declared steps executed against the running change and passed | Human Review |
| Human Review | (the owner) | the owner accepts the head, or sends input back | Merge Queue / back |
| Merge Queue | merge | every gate holds on the accepted head | merged |

Intake opens the pull request (draft, one reservation commit) in a free slot and sets In Queue. A
phase hands on in one edit: next milestone + the claim removed. "No claim, milestone X" means
waiting for X.

## Independence

| Factor | Written by | Never by |
|---|---|---|
| reviewed | the review verdict, from a review run by another engine or a fresh session | the session that wrote the code |
| verified | the verify phase, from the declared steps executed against the running change | the implementer |

The review runs read-only in the PR's slot at the head implement pushed; its report is posted
unchanged and the factor follows its verdict. A factor names its head in the report envelope
(`## <Stage> - <VERDICT>`, `head: <sha>`); a later push makes it stale whether or not anyone removed
the label.

## The project supplies

- the implementation skill and the planning skill;
- the judge runner (engine and procedure) for review and verification;
- the CI workflows that decide, and how a QA environment reports the head it serves;
- the slot checkouts and their naming (the branch names its slot).

## Failure modes it prevents

| Seen | How the pattern avoids it |
|---|---|
| A green-looking PR whose factors were earned on an older head | factors carry the head; gates compare it with the live head |
| The author's session reviewing its own change | the review runs in another engine or a fresh session; the author only posts the report |
| Verification waiting for every suite to finish before it starts | verify starts once the QA environment serves the head; the slow suites gate merge, not the start |
| A judge engine out of quota stalling every PR, retries burning slots | retries with a delay, and an owner-approved swap of the engine in the manifest for every run until it returns |
| A phase run twice for one state | discovery and the handing-off phase request the same key; the runtime dedupes |

## Knobs

`slots`, per-operation `engine`/`kind`/`timeout`/`retries`/`retryDelay`, the judge runner, the
factor set a PR must carry, the deciding CI workflows.
