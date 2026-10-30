# Setting up a managed project

One prompt makes a repository a managed project from scratch. Paste it into an agent session
(Claude Code) opened at the root of the target repository. It follows the six steps of
[project-boundaries.md](project-boundaries.md#the-setup-prompt) and asks the owner one question at a
time; nothing is decided silently.

The `operator` pack and the platform packs (`forge-github` first) are being published to the
development packs repository; until they are, step 2 reports them as missing and stops.

````text
Make this repository a project managed by the Operator runtime (@ainova-systems/operator). Work in
six steps and stop at each point that needs me. Ask me one question at a time: say what you found,
give two to four options and recommend one, using the pattern docs in the Operator repository
(docs/patterns/) as the reference for what each option decides.

Rules for the whole run:
- Secrets never enter the repository: API keys and tokens go into an env file outside it
  (chmod 600) that the service reads. Never print a secret.
- If this repository is public, its work queue is private: use the runtime's private queue in
  Ainoflow state, never issues or committed task files for findings or owner questions.
- A change to the workflow never reaches a task in flight: a pipeline branch runs the skills and
  rules it was created with; only an unavailable engine is swapped in the manifest, for every run.
- Never force-push, never bypass branch protection, never write an owner decision for me.

1. Install the runtime.
   - Check Node 24+, git, the code host's CLI, the agent CLIs (claude, codex if used), herdr if
     runs should be visible in tabs, and a systemd user manager with linger. Report what is
     missing with its install command; install only after I confirm.
   - `npm install --global @ainova-systems/operator`; report `operator --version`.
   - Ask me for the AINOFLOW_API_KEY of a namespace for this project and store it in the env file.

2. Add the packs.
   - Add the `operator` pack and the platform pack for this code host (forge-github,
     forge-gitlab, forge-bitbucket, and a tracker pack such as tracker-asana if the owner works
     outside the code host) to intelligence.yaml, then run `intelligence sync` and report its status.
   - A pack that is not published yet: report it and stop here.

3. Research the repository and report a short table, without changing anything:
   - branching: default and integration branches, protected branches, merge method, branch prefixes;
   - CI: which workflows run on a pull request, which checks are required, how long they take;
   - test suites and how to run them locally; build and typecheck commands;
   - preview or QA environments per pull request, and how a deployment reports which head it serves;
   - where work is queued today (issues, task files, a tracker) and how an item says it is ready;
   - the code host and the tracker the owner uses for decisions;
   - existing agent rules, skills and a project profile, if any.

4. Interview me, one question at a time, until the workflow is fully specified. Cover at least:
   - the phases and their milestones (or the tracker's equivalent), from the reference PR pipeline;
   - slots: how many parallel checkouts, and whether a separate clarification slot is wanted;
   - the judges: which engine reviews and which verifies, and what happens when one is unavailable;
   - QA admission: whether ready pull requests are limited by QA capacity, and the limit;
   - the owner signals (accept, hold, revalidate, reject, cancel) and their label names;
   - merge gates beyond required checks: open questions, manual deployment steps, anything else;
   - queue source, eligibility, ordering and per-source quotas;
   - notification channel and the idle nudge.

5. Write the workflow; it belongs to this repository from now on.
   - `operator.yaml`: workflows, triggers (discovery every few minutes), operations with engine,
     kind, placement, pool, timeout and retries, pools (slots as separate checkouts, engine limits).
   - The workflow configuration (phase and label names, slots, quotas, ready limit, deciding CI
     workflows) and the project profile keys the pack skills read, `forge_cli` among them.
   - The discovery script, composed from the `operator` pack's helpers and this project's own
     readers (QA status, QA feedback), with tests.
   - Create the labels and milestones the owner chose on the code host.
   - Create the slot checkouts and, for herdr, one workspace per slot; open the agent once in each
     so no trust prompt stops an unattended run.

6. Validate, and show me the results before enabling anything.
   - `operator validate --manifest operator.yaml --describe` resolves every operation and script.
   - The forge contract test of the `operator` pack passes against the chosen platform pack.
   - `operator run --dry-run`: discovery makes the requests I expect for the current pull requests
     and queue; list them with the reason for each.
   - On my go: `operator service install <project> --manifest operator.yaml --env-file <env file>`,
     then report `operator service status <project>`.

Commit the workflow files through the repository's normal change process, with nothing secret in them.
````

After setup the workflow is the project's own code: it changes through the project's normal review
like anything else. A newer pack version is an ordinary dependency update; branches already in
flight keep the version they started with.
