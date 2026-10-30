# Owner signals

**Decides:** how the owner steers a pull request, how a question and its answer travel, and how the
pipeline tells the owner's words from its own when both may post from the same account.

## Signals

| Signal (default label) | Means | Taken by |
|---|---|---|
| accepted | merge this head | merge |
| onhold | pause; every operation ends `noop` while it stands | nobody |
| revalidate | verify again, even on an unchanged head | verify |
| rejected | close this attempt; the item stays queued with the reason, which binds the next plan | intake |
| cancelled | close this attempt and drop the item | intake |
| question | the pipeline waits on the owner | set and cleared by the asking skill |

Skills read owner labels before every write and never write them (the question label excepted).
Cancellation outranks rejection. The latest owner-label event is part of every request key, so
pausing and resuming asks again.

## Input and questions

- **Owner input** is any unmarked comment or review from an owner account newer than the last stage
  report. Pipeline comments carry markers (a stage-report envelope, `<!-- operator:note -->`, CI
  markers), because a token may post as the owner.
- **Feedback from a QA environment** (tickets filed on the preview) counts like a comment: a
  ticket created or changed after the last report sends the PR back to verify; a ticket the pipeline
  routes to a fix moves to in progress, and one verified fixed is closed with a one-line note in the
  submitter's language. A ticket reporting no defect is a question, never closed by the pipeline.
- **A question** is one comment with context, options and a recommendation, ending with
  `<!-- operator:question <run>:<n> -->`. The run ends `needs-input` with a wait; discovery finds the
  reply and the runtime resumes the operation, which records the answer before acting on it.

## The project supplies

Label names, the owner account associations that count as the owner, the pipeline markers its CI
uses, and, when QA environments take tickets, a reader and a status writer for them.

## Failure modes it prevents

| Seen | How the pattern avoids it |
|---|---|
| The pipeline's own comments read as new owner input, restarting phases forever | every pipeline comment is marked |
| A "yes" to one question taken as permission to merge | an answer is recorded against its question id and authorizes that decision only |
| A ticket fixed in code but left open, so the owner re-checks it | verify closes what it verified fixed |
| Rejected tickets closing nothing, because rejected still counts as open | the pipeline never uses rejected to close a ticket |
| A paused PR picked up by the next discovery pass | hold makes every operation `noop`; the owner-label event re-keys requests |

## Knobs

`labels`, `allowedAuthors`, `questionMarker`, `pipelineMarkers`, the QA feedback reader and writer.
