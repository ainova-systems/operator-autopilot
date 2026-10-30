# Clarification phase

**Decides:** how queue items that wait on an owner decision get decided, without the owner finding
them and without taking delivery capacity.

## Flow

| Step | What happens |
|---|---|
| Rank | discovery lists items marked waiting on a decision; the owner's "first" flag, then queue order, priority and how many items depend on each; it offers the top few |
| Select | the clarify operation picks one by the project's current business priority and says why |
| Plan first | it settles from the repository everything the code and docs already answer, and writes the proposed resolution into the item and its feature document, in a documentation-only draft PR |
| Ask | one question at a time: context, two to four options, a recommendation; each answer is recorded in the documents |
| Settle | nothing open: the item is marked ready, a `## Clarification - READY` report names the head, and the PR moves to the merge phase |
| Merge | once CI decides, the same operation merges it; the owner's answers were its review |

Owner input after the READY report sends it back to clarify; a hold stops it; rejection records
the reason on the item, cancellation drops the item from the ranking.

## Shape

- Own slots, which only clarify; delivery slots never clarify. A free slot takes the next item.
- The PR changes documents only and carries no review or verification factor.
- Its body has three sections: **Task** (the problem, a fast intro), **Approach** (the resolution as
  a whole), **Open questions** (options and recommendation; `Decided: …` once answered).
- Clarification PRs count against no intake quota.

## The project supplies

How a queue item says it waits on a decision; where the business priority is written; the branch
prefix for documentation PRs; the documentation-only path set the merge checks.

## Failure modes it prevents

| Seen | How the pattern avoids it |
|---|---|
| The most important work waiting longest, because intake never picks undecided items | ranked items are offered to a dedicated slot at once |
| The owner asked open-ended questions with no context | plan first; every question carries options and a recommendation |
| Settled documents waiting days for an owner review nobody has time for | the READY report at the head authorizes the merge |
| A clarification blocking delivery capacity | separate slots and no quota |

## Knobs

`clarifySlots`, number of candidates offered, the priority source, the branch prefix.
