# Reference: a PR pipeline for a web application with preview environments

One complete workflow, anonymized, that combines every pattern. The project is a web application
with a backend, a frontend and per-pull-request preview environments; numbers are illustrative.

## Shape

| Piece | Value |
|---|---|
| Slots | 3 delivery checkouts, 2 clarification checkouts; a PR lives in the slot its branch names |
| Discovery | a script every 5 minutes, exclusive, in the control checkout on the integration branch |
| Engines | interactive Claude sessions for plan, implement, verify, clarify; a read-only review engine limited to 3 at once; agent runs for intake, review verdict, merge |
| Queue | task files in the repository with ready / needs-decision status; quotas per source folder |
| QA | a preview per ready PR; `readyLimit` 6; isolated test suites for every head, drafts included |
| Tracker | the code host: milestones for phases, labels for owner signals and factors, comments for questions |

## Operations

| Operation | Kind | Triggered by discovery when | Ends |
|---|---|---|---|
| intake | agent | a delivery slot is free and an eligible item exists | draft PR in In Queue, or the reason nothing fits |
| plan | interactive | In Queue | Development, or a question |
| implement | interactive | Development with work pending; any later phase with a conflict | review request, Verification, or a question |
| review | agent, read-only | implement pushed a head | review verdict |
| review-verdict | agent | the review finished | report posted, factor written, back to implement |
| verify | interactive | Verification (admission, then verification); new owner input or tickets in Human Review; revalidate | Human Review, back to Development with evidence, or `noop` while QA catches up |
| merge | agent | accepted, in Human Review or Merge Queue | merged, or one refusal comment |
| clarify | interactive | a clarification slot is free; a clarification PR has new input or is settled | READY and merged, or a question |

## Discovery order for one pull request

1. Not in a pipeline milestone, held, or claimed by a running job → skip.
2. Rejected or cancelled → close (intake).
3. Conflicting with the base → implement (`conflict:<head>`).
4. Revalidate → verify.
5. Human Review or Merge Queue with edited steps or a head no verification names → verify.
6. Accepted → feedback first (verify), else merge.
7. Otherwise the phase's own operation, or skip with the reason (waiting for CI, a QA slot, the owner).

Every request key carries what that operation would see: head, CI state and run count, QA state,
owner-input cursor, latest stage report, factors, unresolved threads, ticket mark, steps digest and
the latest owner-label event.

## Runtime settings that made it reliable

- interactive sessions keep their tab after the result for the owner's questions;
- an idle interactive session without a result is nudged twice, then the owner is told;
- a blocked pane is never answered by the runtime, only reported;
- a judge engine that is unavailable fails the run as retryable with a long retry delay.
