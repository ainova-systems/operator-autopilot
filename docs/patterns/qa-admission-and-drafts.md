# QA admission and drafts

**Decides:** which pull requests hold the persistent QA environments when there are fewer
environments than pull requests in flight, and in what order they get one.

## Rule

| State | Gets | Does not get |
|---|---|---|
| draft | image builds, the isolated test suites, code review, fixes | a persistent QA environment, behavioural verification |
| ready | all of the above plus a QA environment and verification | — |

- Intake always opens a draft: an empty reservation never takes QA capacity.
- The verify phase promotes the **oldest** draft in Verification (by creation date) to ready, and
  only while fewer than `readyLimit` pull requests are ready. Only the oldest asks; the others wait
  behind it, and the ready count is part of the request key so a freed slot asks again.
- Checks turning green is never a reason to promote; nothing else promotes a draft.
- Returning a PR to draft destroys its QA environment: verification is repeated after QA comes back,
  even on an unchanged head.

## The project supplies

- how a QA environment is created on ready and destroyed on draft;
- how to read which head a QA environment serves (a status row, a deployment check);
- the limit, from real capacity.

## Failure modes it prevents

| Seen | How the pattern avoids it |
|---|---|
| QA capacity taken by changes that had not started | intake opens drafts; only verify promotes |
| Every green PR grabbing an environment, the oldest starving | oldest-first, one asker at a time |
| Verification reported on an environment still serving the previous head | verify waits until the environment names the head |
| A verification reused after the environment was recreated | a recreated environment invalidates environment-dependent evidence |

## Knobs

`readyLimit`, the QA-status reader, the deciding deployment check.
