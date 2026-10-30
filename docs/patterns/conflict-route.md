# Conflict route

**Decides:** what happens to a pull request that conflicts with its base branch after it left
implementation.

## Rule

Whenever the code host reports the pull request as conflicting, in any phase after the queue,
discovery asks for `implement` keyed `conflict:<head>`. The implement run moves the pull request back
to Development in its claim edit (removing an obsolete completion label), brings the base branch in
through the project's conflict-resolution skill, and pushes. The merged head then passes review and
verification again on its way back. A conflict only the owner can settle becomes a question; a new
head that still conflicts asks again under its own key.

The route comes before every other phase rule except the owner's hold and close signals: verifying
or accepting a conflicting head judges a head that must change.

## Why

A conflicting head cannot be merged, and on some code hosts pull-request CI does not run for it at
all, so it shows neither green nor red. Without the route it sits in human review "waiting for the
owner" indefinitely.

## The project supplies

The conflict-resolution skill (with the project's rules for migrations, lock files, translations and
other generated files) and the update strategy (merge or rebase).

## Failure modes it prevents

| Seen | How the pattern avoids it |
|---|---|
| An accepted PR that cannot merge, silently waiting | the route runs before merge and routes it back |
| CI never reporting on a conflicting head | the conflict is read from the code host, not inferred from CI |
| Merging the base branch in on every move "to stay current", restarting CI and review for nothing | the base comes in only when the round pushes anyway or the PR conflicts |

## Knobs

None beyond the conflict skill; the key `conflict:<head>` is fixed by the pattern.
