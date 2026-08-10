import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvRecord } from "./which.js";

/**
 * Best guess at where this host's engine keeps its state file, used to
 * prefill the setup screen instead of asking a first-time user to know a
 * path they have not created yet.
 *
 * Mirrors the engine's own resolution (`engine/infra/env.ts` +
 * `entry.ts`): `OPERATOR_DIR` decides the root and the database always
 * lives at `<root>/state/operator.db`. `OPERATOR_DB_PATH` — the app's own
 * dev bootstrap variable — wins outright when set, because a deployment
 * that names the file explicitly has already answered the question.
 */
export function suggestEngineDbPath(env: EnvRecord = process.env): string {
  const explicit = env["OPERATOR_DB_PATH"];
  if (explicit) return explicit;

  const operatorDir = env["OPERATOR_DIR"];
  if (operatorDir) return join(resolve(operatorDir), "state", "operator.db");

  return join(monorepoRoot(), "state", "operator.db");
}

/** `app/src/lib/setup/engine-db-path.ts` → the repository root. */
function monorepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..");
}
