import { z } from "zod";
import {
  missingEnvVars,
  type AgentRequirementsResult,
} from "./agent-requirements.js";
import type { TokenCheckInput, TokenCheckResult } from "./github-check.js";
import type { PreflightCheck, PreflightReport } from "./preflight-types.js";
import { readEnvVar, type EnvRecord } from "./which.js";

/**
 * The setup preflight: everything that has to be true on this host before
 * the engine's first cycle can do anything useful.
 *
 * Scope caveat, stated in the hints rather than hidden: these checks look at
 * the *app* process. When the app and the engine share a host or a container
 * (the supported layouts) that is the same environment. When they do not,
 * a missing credential here says "the app cannot verify it", not "the engine
 * lacks it" — which is why unset variables warn and only a genuinely absent
 * CLI or a rejected token fails.
 */
export interface PreflightInput {
  /** Engine SQLite state file. Omitted before the connection step runs. */
  readonly dbPath?: string;
  /** `owner/repo` the wizard is about to register. */
  readonly repoSlug?: string;
  /** Environment variable the repo row will name as its credential source. */
  readonly tokenEnvVar?: string;
  /** Pasted token, used for this one probe and never stored. */
  readonly token?: string;
}

/**
 * Request body accepted by `POST /api/setup/preflight`. Every field is
 * optional because the wizard re-runs the preflight as it learns more —
 * the first run knows nothing but the host.
 */
export const preflightRequestSchema = z.object({
  dbPath: z.string().min(1).optional(),
  repoSlug: z.string().min(1).optional(),
  tokenEnvVar: z.string().min(1).optional(),
  token: z.string().optional(),
}) satisfies z.ZodType<PreflightInput>;

export interface PreflightDeps {
  readonly env: EnvRecord;
  readonly locate: (command: string) => string | null;
  readonly requirements: AgentRequirementsResult;
  readonly probeDb: (dbPath: string) => Promise<{ ok: boolean; message: string }>;
  readonly checkToken: (input: TokenCheckInput) => Promise<TokenCheckResult>;
}

const ENV_SCOPE_HINT =
  "Checked in the app process. If the engine runs elsewhere, set it there instead.";

export async function runPreflight(
  input: PreflightInput,
  deps: PreflightDeps,
): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [
    gitCheck(deps),
    ...agentChecks(deps),
    ...unknownProviderCheck(deps),
  ];

  const db = await databaseCheck(input, deps);
  if (db) checks.push(db);

  checks.push(await tokenCheck(input, deps));

  return { checks, ok: checks.every((c) => c.status !== "fail") };
}

function gitCheck(deps: PreflightDeps): PreflightCheck {
  const found = deps.locate("git");
  return found
    ? { id: "git", label: "git", status: "pass", detail: found }
    : {
        id: "git",
        label: "git",
        status: "fail",
        detail: "Not found on PATH.",
        hint: "The engine clones and pushes with the system git binary — install git 2.40 or newer.",
      };
}

function agentChecks(deps: PreflightDeps): PreflightCheck[] {
  const { requirements } = deps.requirements;
  if (requirements.length === 0) {
    return [
      {
        id: "agent-cli",
        label: "Agent CLI",
        status: "warn",
        detail: "No agent roles are configured yet.",
        hint: "The engine seeds its default roles on first start; re-run this check afterwards.",
      },
    ];
  }

  const checks: PreflightCheck[] = [];
  for (const requirement of requirements) {
    const usedBy = requirement.usedBy.join(", ");
    const found = deps.locate(requirement.command);
    checks.push(
      found
        ? {
            id: `agent-cli:${requirement.providerId}`,
            label: `${requirement.command} (${usedBy})`,
            status: "pass",
            detail: found,
          }
        : {
            id: `agent-cli:${requirement.providerId}`,
            label: `${requirement.command} (${usedBy})`,
            status: "fail",
            detail: `Not found on PATH — roles ${usedBy} cannot run.`,
            hint: `Install ${requirement.command}, or point those roles at a provider whose CLI is installed.`,
          },
    );

    const missing = missingEnvVars(requirement, deps.env);
    checks.push(
      missing.length === 0
        ? {
            id: `agent-env:${requirement.providerId}`,
            label: `${requirement.providerId} credentials`,
            status: "pass",
            detail: "Credential environment variables are set.",
          }
        : {
            id: `agent-env:${requirement.providerId}`,
            label: `${requirement.providerId} credentials`,
            status: "warn",
            detail: `Unset: ${missing.join(", ")}.`,
            hint: ENV_SCOPE_HINT,
          },
    );
  }
  return checks;
}

function unknownProviderCheck(deps: PreflightDeps): PreflightCheck[] {
  const unknown = deps.requirements.unknownProviders;
  if (unknown.length === 0) return [];
  return [
    {
      id: "agent-provider-config",
      label: "Agent provider configuration",
      status: "warn",
      detail: `Roles reference undefined providers: ${unknown.join(", ")}.`,
      hint: "Add the provider under Config → agent-providers, or repoint those roles.",
    },
  ];
}

async function databaseCheck(
  input: PreflightInput,
  deps: PreflightDeps,
): Promise<PreflightCheck | null> {
  if (!input.dbPath) return null;
  const probe = await deps.probeDb(input.dbPath);
  return probe.ok
    ? {
        id: "engine-db",
        label: "Engine state database",
        status: "pass",
        detail: `${input.dbPath} — ${probe.message}`,
      }
    : {
        id: "engine-db",
        label: "Engine state database",
        status: "fail",
        detail: `${input.dbPath} — ${probe.message}`,
        hint: "Pick a path the app can create and write, on the same volume the engine uses.",
      };
}

async function tokenCheck(
  input: PreflightInput,
  deps: PreflightDeps,
): Promise<PreflightCheck> {
  const label = "Git host token";
  const envVar = input.tokenEnvVar;
  const pasted = input.token?.trim();
  const fromEnv = envVar ? readEnvVar(deps.env, envVar)?.trim() : undefined;
  const token = pasted && pasted.length > 0 ? pasted : fromEnv;

  if (!token) {
    return {
      id: "vcs-token",
      label,
      status: "warn",
      detail: envVar
        ? `${envVar} is not set in this process, and no token was supplied to test with.`
        : "No token to test with yet.",
      hint: envVar
        ? `${ENV_SCOPE_HINT} Paste a token above to verify it against GitHub without storing it.`
        : "Name the environment variable the engine reads, or paste a token to verify it.",
    };
  }

  const source = pasted && pasted.length > 0 ? "pasted token (not stored)" : `${envVar}`;
  const result = await deps.checkToken({
    token,
    ...(input.repoSlug ? { repoSlug: input.repoSlug } : {}),
  });
  return {
    id: "vcs-token",
    label,
    status: result.status,
    detail: `${result.detail} (source: ${source})`,
    ...(result.hint ? { hint: result.hint } : {}),
  };
}
