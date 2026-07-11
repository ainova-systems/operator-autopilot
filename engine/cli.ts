/**
 * CLI argument parser for the Operator engine.
 *
 * Usage:
 *   npx tsx engine/entry.ts [options]
 *
 * Options:
 *   --once              Run single cycle then exit (default for CI)
 *   --repo <id>         Process only this repo
 *   --force <action>    Force specific action (pr-review, task-select, etc.)
 *   --config <dir>      Config directory (default: ./config)
 *   --status            Print health status and exit
 *   --help              Show help
 */

import { operatorEngineVersion } from "./index.js";

export interface CLIArgs {
  readonly once: boolean;
  readonly dryRun: boolean;
  readonly freshDb: boolean;
  readonly repo?: string;
  readonly force?: string;
  readonly configDir: string;
  readonly workspace?: string;
  readonly status: boolean;
  readonly help: boolean;
  /**
   * Seed-once categories to force-overwrite. `"all"` reseeds every category.
   * Empty set means "no reseeding, just fill missing rows" (default boot).
   */
  readonly reseed: ReadonlySet<string>;
}

/**
 * Parse CLI arguments from process.argv.
 */
export function parseArgs(argv: string[]): CLIArgs {
  const args = argv.slice(2); // skip node and script path

  let once = false;
  let dryRun = false;
  let freshDb = false;
  let repo: string | undefined;
  let force: string | undefined;
  let configDir = "./config";
  let workspace: string | undefined;
  let status = false;
  let help = false;
  const reseed = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--once":
        once = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--fresh-db":
        freshDb = true;
        break;
      case "--repo":
        repo = args[++i];
        break;
      case "--force":
        force = args[++i];
        break;
      case "--config":
        configDir = args[++i];
        break;
      case "--workspace":
        workspace = args[++i];
        break;
      case "--status":
        status = true;
        break;
      case "--reseed": {
        const value = args[++i];
        if (value) reseed.add(value);
        break;
      }
      case "--help":
      case "-h":
        help = true;
        break;
    }
  }

  return { once, dryRun, freshDb, repo, force, configDir, workspace, status, help, reseed };
}

/**
 * Print help text.
 */
export function printHelp(): string {
  return [
    `Operator ${operatorEngineVersion} — AI-powered SDLC engine`,
    "",
    "Usage: npx tsx engine/entry.ts [options]",
    "",
    "Options:",
    "  --once              Run single cycle then exit",
    "  --dry-run           Log actions without executing (no GitHub API writes)",
    "  --fresh-db          Delete and recreate DB from repo files (ephemeral mode)",
    "  --repo <id>         Process only this repo ID",
    "  --force <action>    Force action (pr-review, task-select, task-execute,",
    "                      finding-select, finding-execute, research, improver,",
    "                      branch-cleanup, init)",
    "  --config <dir>      Config directory (default: ./config)",
    "  --workspace <dir>   Override workspace path (for local testing)",
    "  --status            Print health status and exit",
    "  --reseed <category> Force-overwrite KV rows for a seed-once category",
    "                      (prompts, templates, agent-roles, workflow-stages,",
    "                      work-item-kinds, verifier-criteria, analyzers, all).",
    "                      Repeatable: --reseed prompts --reseed templates",
    "  --help, -h          Show this help",
    "",
    "Examples:",
    "  npx tsx engine/entry.ts --once --repo <repo-id>",
    "  npx tsx engine/entry.ts --once --repo <repo-id> --force research",
    "  npx tsx engine/entry.ts                    # daemon mode",
  ].join("\n");
}
