import { z } from "zod";

/**
 * Per-repo workspace-init bookkeeping.
 *
 * `prepareWorkspace` runs the project's `scripts.init` (typically
 * `npm ci` / `bundle install` / equivalent) once per repo, and again
 * whenever the inputs that determine its outcome change. Caching the
 * inputs' hash keeps every cycle fast (no `npm ci` on a no-op tick)
 * while still re-running on real dependency changes.
 *
 * Hash inputs: the literal `scripts.init` string + the byte content of
 * any well-known lock files present in the workspace root
 * (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`,
 * `Gemfile.lock`, `poetry.lock`, `go.sum`, `*.csproj.lock.json` for
 * .NET solutions). Lock-file presence drives the language stack
 * detection without us hard-coding it.
 */
export const workspaceInitSchema = z.object({
  /** Repo id from `repos.yaml` (also the KV row key). */
  repoId: z.string().min(1),
  /** sha256 of `scripts.init` + concatenated lock-file contents. */
  hash: z.string().min(1),
  /** ISO timestamp of the most recent successful run. */
  runAt: z.string().min(1),
  /** Wall-clock duration of that run, milliseconds. */
  durationMs: z.number().int().nonnegative(),
});

export type WorkspaceInitEntry = z.infer<typeof workspaceInitSchema>;
