# Merge gates

**Decides:** what must hold on the exact accepted head before the merge operation merges, and what
an acceptance does not cover.

## Gates, checked by the merge operation on the live state

| Gate | Holds when |
|---|---|
| Acceptance | the owner's accept signal stands, no hold, rejection, cancellation or revalidation |
| Head | local head, upstream and the live PR head agree with the head the evidence names |
| Required checks | every required check is green on this head; pending, cancelled, missing or unreadable is not green |
| Factors | every declared factor is fresh at this head (verification also at the current steps digest) |
| Threads and reviews | no unresolved review thread, no standing change request |
| Owner input | nothing newer than the last report awaits triage, including QA tickets; an unreadable ticket list refuses |
| Open questions | no undecided behaviour left in the change's documents |
| Manual steps | no deployment or instance step outside the PR unless the owner accepted that exact list |

A refusal is one marked comment naming what is stale and which stage must refresh it, then `noop`;
an identical standing refusal is reused. The merge takes no claim and never uses an admin bypass.

## Why

An acceptance is given to a head at a moment. Pushes, edited verification steps, late feedback and
red suites can all arrive after it; merging on the label alone ships what nobody judged.

## The project supplies

The required-check list (branch protection), the factor set, the documents to scan for open
questions, and which paths imply manual deployment steps.

## Failure modes it prevents

| Seen | How the pattern avoids it |
|---|---|
| A PR merged while one required suite never ran | "did not run" is not green; required checks always report |
| An unattended merge dropping a manual deployment step nobody performed | a manual step blocks auto-merge until the owner accepts the list |
| Verification steps edited after the passing run | the steps digest is part of the verification factor |
| A merge on a stale acceptance after a new push | the head the evidence names must be the live head |

## Knobs

The factor set, required checks, the open-question and manual-step scans.
