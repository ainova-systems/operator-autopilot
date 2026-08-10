"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorAlert } from "@/components/shared/error-alert";
import { FormRow, FormStack } from "@/components/shared/form-stack";
import { InlineActions } from "@/components/shared/inline-actions";
import { useToast } from "@/components/shared/toaster";
import {
  DEFAULT_BASE_BRANCH,
  REPO_FEATURE_KEYS,
  buildRepoEntry,
  suggestRepoId,
} from "@/lib/setup/repo-draft";

/**
 * Step 3 — register the repository the operator will work on.
 *
 * The row is written through the same validated `/api/kv/repos/{id}` path
 * the config editor uses, so it lands with `source: "ui"` and survives the
 * engine's seed-mirror pass over `config/repos.yaml` untouched. There is no
 * second writer and no bespoke file to hand-edit.
 */
export function RepoStep({
  repoSlug,
  onRepoSlugChange,
  tokenEnvVar,
  onTokenEnvVarChange,
  onCreated,
}: {
  readonly repoSlug: string;
  readonly onRepoSlugChange: (value: string) => void;
  readonly tokenEnvVar: string;
  readonly onTokenEnvVarChange: (value: string) => void;
  readonly onCreated: (repoId: string) => void;
}): React.ReactElement {
  const toast = useToast();
  const [branch, setBranch] = useState(DEFAULT_BASE_BRANCH);
  const [repoId, setRepoId] = useState("");
  const [repoIdTouched, setRepoIdTouched] = useState(false);
  const [enabled, setEnabled] = useState<readonly string[]>(REPO_FEATURE_KEYS);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);

  const effectiveRepoId = repoIdTouched ? repoId : suggestRepoId(repoSlug);

  function toggleFeature(key: string): void {
    setEnabled((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  async function onCreate(): Promise<void> {
    const draft = buildRepoEntry({
      repoId: effectiveRepoId,
      slug: repoSlug,
      branch,
      tokenEnvVar,
      enabledFeatures: enabled,
    });
    if (!draft.ok) {
      setErrors(draft.errors);
      return;
    }
    setErrors([]);
    setBusy(true);
    try {
      const res = await fetch(`/api/kv/repos/${encodeURIComponent(draft.repoId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "If-Match": "0" },
        body: JSON.stringify({ value: draft.value, expectedVersion: 0 }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hint =
          res.status === 409
            ? ` — a repository with id ${draft.repoId} already exists; edit it under Config instead.`
            : "";
        setErrors([`${body.error ?? `HTTP ${res.status}`}${hint}`]);
        return;
      }
      toast(`Registered ${draft.repoId}`, { kind: "success" });
      onCreated(draft.repoId);
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormStack>
      <FormRow>
        <Label htmlFor="setup-repo-slug">Repository</Label>
        <Input
          id="setup-repo-slug"
          value={repoSlug}
          onChange={(e) => onRepoSlugChange(e.target.value)}
          placeholder="owner/repository"
          disabled={busy}
        />
        <p className="m-0 text-xs text-muted-foreground">
          A GitHub URL or SSH remote is accepted too — it is reduced to owner/repository.
        </p>
      </FormRow>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormRow>
          <Label htmlFor="setup-repo-branch">Base branch</Label>
          <Input
            id="setup-repo-branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder={DEFAULT_BASE_BRANCH}
            disabled={busy}
          />
          <p className="m-0 text-xs text-muted-foreground">
            Branch the operator works from and targets its pull requests at. It is never pushed
            to directly.
          </p>
        </FormRow>

        <FormRow>
          <Label htmlFor="setup-repo-id">Operator id for this repository</Label>
          <Input
            id="setup-repo-id"
            value={effectiveRepoId}
            onChange={(e) => {
              setRepoIdTouched(true);
              setRepoId(e.target.value);
            }}
            placeholder="sample"
            disabled={busy}
            className="font-mono text-xs"
          />
          <p className="m-0 text-xs text-muted-foreground">
            Used as the KV key and in log lines. Suggested from the repository name.
          </p>
        </FormRow>
      </div>

      <FormRow>
        <Label htmlFor="setup-token-env">Token environment variable</Label>
        <Input
          id="setup-token-env"
          value={tokenEnvVar}
          onChange={(e) => onTokenEnvVarChange(e.target.value)}
          disabled={busy}
          className="font-mono text-xs"
        />
        <p className="m-0 text-xs text-muted-foreground">
          The engine reads the token from this variable in its own environment. Only the name is
          stored here — never the token.
        </p>
      </FormRow>

      <FormRow>
        <div className="text-sm font-medium">Stages enabled for this repository</div>
        <div className="flex flex-wrap gap-2">
          {REPO_FEATURE_KEYS.map((key) => {
            const on = enabled.includes(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleFeature(key)}
                disabled={busy}
                aria-pressed={on}
                className={
                  on
                    ? "rounded-full border border-transparent bg-primary/15 px-3 py-1 font-mono text-xs text-foreground"
                    : "rounded-full border px-3 py-1 font-mono text-xs text-muted-foreground"
                }
              >
                {key}
              </button>
            );
          })}
        </div>
        <p className="m-0 text-xs text-muted-foreground">
          Every stage ships gated — the operator opens pull requests and never merges them.
          Switch stages off here to narrow the first runs.
        </p>
      </FormRow>

      {errors.length > 0 ? (
        <ErrorAlert
          title="Cannot register this repository yet"
          message={
            <ul className="m-0 list-disc space-y-0.5 pl-4">
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          }
        />
      ) : null}

      <InlineActions>
        <Button type="button" onClick={() => void onCreate()} disabled={busy}>
          {busy ? "Registering…" : "Register repository"}
        </Button>
      </InlineActions>
    </FormStack>
  );
}
