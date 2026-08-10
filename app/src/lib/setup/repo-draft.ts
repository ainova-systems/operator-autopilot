import { repoFeaturesSchema, repoSchema, type RepoEntry } from "@operator/core";

/**
 * Turn the wizard's four answers — where the repository lives, which branch
 * to work from, and which environment variable holds the token — into a row
 * the shared `/api/kv/repos/{id}` write path accepts.
 *
 * Validation is delegated to `repoSchema` rather than restated here, so the
 * wizard can never produce a row the engine would reject at boot.
 */
export const DEFAULT_TOKEN_ENV_VAR = "MANAGED_REPO_GH_TOKEN";
export const DEFAULT_BASE_BRANCH = "main";
/** Conservative concurrency cap for a first run — one PR at a time per kind is too slow, ten is a flood. */
const DEFAULT_MAX_ACTIVE = 2;

/**
 * Feature keys read off the schema itself, so a stage added or removed in
 * `repoFeaturesSchema` shows up in the wizard without a second edit here.
 */
export const REPO_FEATURE_KEYS: readonly string[] = Object.keys(repoFeaturesSchema.shape);

/** Repo id accepted by the KV write path — same shape the config editor enforces. */
const REPO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface ParsedSlug {
  readonly owner: string;
  readonly name: string;
  readonly slug: string;
}

/**
 * Accept the forms a person actually has on their clipboard: a bare
 * `owner/repo`, a browser URL, or an SSH remote.
 */
export function parseRepoSlug(raw: string): ParsedSlug | null {
  let text = raw.trim();
  if (!text) return null;

  text = text.replace(/^git@[^:]+:/, "");
  text = text.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+\//, "");
  text = text.replace(/\.git$/, "");
  text = text.replace(/^\/+/, "").replace(/\/+$/, "");

  const parts = text.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name)) return null;

  return { owner, name, slug: `${owner}/${name}` };
}

/**
 * Propose a KV key for a repository. The id is the operator's own handle for
 * the repo — it appears in branch names and log lines — so it is derived
 * from the repository name, lowercased and stripped to the accepted charset.
 */
export function suggestRepoId(slug: string): string {
  const parsed = parseRepoSlug(slug);
  const source = parsed ? parsed.name : slug;
  const cleaned = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return cleaned;
}

export function isValidRepoId(id: string): boolean {
  return REPO_ID_PATTERN.test(id);
}

export interface RepoDraftInput {
  readonly repoId: string;
  readonly slug: string;
  readonly branch: string;
  readonly tokenEnvVar: string;
  /** Feature keys to enable. Every other known key is written as `false`. */
  readonly enabledFeatures: readonly string[];
  readonly maxActiveTasks?: number;
  readonly maxActiveFindings?: number;
  readonly debug?: boolean;
}

export type RepoDraftResult =
  | { readonly ok: true; readonly repoId: string; readonly value: RepoEntry }
  | { readonly ok: false; readonly errors: readonly string[] };

export function buildRepoEntry(input: RepoDraftInput): RepoDraftResult {
  const errors: string[] = [];

  const repoId = input.repoId.trim();
  if (!isValidRepoId(repoId)) {
    errors.push("Repo id must start with a letter or digit and contain only letters, digits, dash, or underscore.");
  }

  const parsed = parseRepoSlug(input.slug);
  if (!parsed) {
    errors.push("Repository must be owner/name (a GitHub URL or SSH remote is also accepted).");
  }

  const branch = input.branch.trim();
  if (!branch) errors.push("Base branch is required.");

  const tokenEnvVar = input.tokenEnvVar.trim();
  if (!tokenEnvVar) errors.push("Token environment variable is required.");

  if (errors.length > 0 || !parsed) return { ok: false, errors };

  const candidate = {
    id: repoId,
    debug: input.debug ?? false,
    vcs: {
      platform: "github" as const,
      repo: parsed.slug,
      branch,
      tokenEnvVar,
    },
    features: buildFeatures(input.enabledFeatures),
    limits: {
      maxActiveTasks: input.maxActiveTasks ?? DEFAULT_MAX_ACTIVE,
      maxActiveFindings: input.maxActiveFindings ?? DEFAULT_MAX_ACTIVE,
    },
  };

  const validated = repoSchema.safeParse(candidate);
  if (!validated.success) {
    return {
      ok: false,
      errors: validated.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`),
    };
  }
  return { ok: true, repoId, value: validated.data };
}

function buildFeatures(enabled: readonly string[]): Record<string, boolean> {
  const on = new Set(enabled);
  const features: Record<string, boolean> = {};
  for (const key of REPO_FEATURE_KEYS) {
    features[key] = on.has(key);
  }
  return features;
}
