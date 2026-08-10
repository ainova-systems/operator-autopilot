/**
 * Git-host credential probe used by the setup preflight.
 *
 * Onboarding fails silently today when the token is absent, expired, or
 * scoped to the wrong account: the engine only finds out mid-cycle, deep
 * inside a stage. Two cheap calls answer it up front — `GET /user` proves
 * the token authenticates, `GET /repos/{owner}/{repo}` proves it can reach
 * the repository the operator is about to be pointed at.
 *
 * The token is never persisted. It arrives on a request, is used for these
 * calls, and is dropped — the engine reads the real credential from its own
 * environment variable, which is what `tokenEnvVar` on the repo row names.
 */
import type { CheckStatus } from "./preflight-types.js";

export interface TokenCheckResult {
  readonly status: CheckStatus;
  readonly detail: string;
  readonly hint?: string;
  /** Account the token authenticates as, when the probe got that far. */
  readonly login?: string;
}

export interface TokenCheckInput {
  readonly token: string;
  /** `owner/repo`. Omitted when the wizard has not asked for a repo yet. */
  readonly repoSlug?: string;
}

export interface TokenCheckDeps {
  readonly fetchImpl: typeof fetch;
  /** Overridable so a GitHub Enterprise host can be probed later. */
  readonly apiBaseUrl?: string;
}

const DEFAULT_API_BASE_URL = "https://api.github.com";

interface GitHubUser {
  readonly login?: string;
}

interface GitHubRepo {
  readonly permissions?: { readonly push?: boolean };
}

export async function checkGitHubToken(
  input: TokenCheckInput,
  deps: TokenCheckDeps,
): Promise<TokenCheckResult> {
  const base = deps.apiBaseUrl ?? DEFAULT_API_BASE_URL;

  let user: Response;
  try {
    user = await request(deps.fetchImpl, `${base}/user`, input.token);
  } catch (err) {
    return {
      status: "warn",
      detail: `Could not reach ${base}: ${messageOf(err)}`,
      hint: "The token may still be valid — re-run this check once the host is reachable.",
    };
  }

  if (user.status === 401) {
    return {
      status: "fail",
      detail: "GitHub rejected the token (401).",
      hint: "Generate a new token with repo scope and update it in the engine environment.",
    };
  }
  if (!user.ok) {
    return {
      status: "warn",
      detail: `GitHub returned ${user.status} for GET /user.`,
      hint: "Unexpected response — check the token and any proxy between this host and GitHub.",
    };
  }

  const login = (await readJson<GitHubUser>(user))?.login;
  const identity = login ? `Authenticated as ${login}.` : "Token authenticates.";

  if (!input.repoSlug) {
    return { status: "pass", detail: identity, ...(login ? { login } : {}) };
  }

  let repo: Response;
  try {
    repo = await request(deps.fetchImpl, `${base}/repos/${input.repoSlug}`, input.token);
  } catch (err) {
    return {
      status: "warn",
      detail: `${identity} Repository check failed: ${messageOf(err)}`,
      ...(login ? { login } : {}),
    };
  }

  if (repo.status === 404) {
    return {
      status: "fail",
      detail: `${identity} No access to ${input.repoSlug} (404).`,
      hint: "GitHub returns 404 for a repository the token cannot see — check the slug and the token's repository access.",
      ...(login ? { login } : {}),
    };
  }
  if (!repo.ok) {
    return {
      status: "warn",
      detail: `${identity} GitHub returned ${repo.status} for ${input.repoSlug}.`,
      ...(login ? { login } : {}),
    };
  }

  const canPush = (await readJson<GitHubRepo>(repo))?.permissions?.push === true;
  if (!canPush) {
    return {
      status: "fail",
      detail: `${identity} Read-only access to ${input.repoSlug}.`,
      hint: "The operator pushes feature branches and opens pull requests — the token needs write access.",
      ...(login ? { login } : {}),
    };
  }

  return {
    status: "pass",
    detail: `${identity} Write access to ${input.repoSlug} confirmed.`,
    ...(login ? { login } : {}),
  };
}

async function request(fetchImpl: typeof fetch, url: string, token: string): Promise<Response> {
  return fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
}

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
