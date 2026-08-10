"use client";

import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorAlert } from "@/components/shared/error-alert";
import { FormRow, FormStack } from "@/components/shared/form-stack";
import { InlineActions } from "@/components/shared/inline-actions";
import type { PreflightCheck, PreflightReport } from "@/lib/setup/preflight-types";

/**
 * Step 2 — is this host able to run a cycle at all?
 *
 * The token field is deliberately transient: it is posted once so the
 * server can ask GitHub whether the credential works, and is never stored.
 * The engine reads the real credential from the environment variable named
 * on the repository row.
 */
export function PreflightStep({
  dbPath,
  repoSlug,
  tokenEnvVar,
  onResult,
}: {
  readonly dbPath: string;
  readonly repoSlug: string;
  readonly tokenEnvVar: string;
  readonly onResult: (report: PreflightReport) => void;
}): React.ReactElement {
  const [token, setToken] = useState("");
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(dbPath.trim() ? { dbPath: dbPath.trim() } : {}),
          ...(repoSlug.trim() ? { repoSlug: repoSlug.trim() } : {}),
          ...(tokenEnvVar.trim() ? { tokenEnvVar: tokenEnvVar.trim() } : {}),
          ...(token.trim() ? { token: token.trim() } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Preflight failed (${res.status})`);
      const next = body as PreflightReport;
      setReport(next);
      onResult(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormStack>
      <FormRow>
        <Label htmlFor="setup-token">Git host token (optional, not stored)</Label>
        <Input
          id="setup-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ghp_… — used once to verify access, then discarded"
          disabled={busy}
          autoComplete="off"
        />
        <p className="m-0 text-xs text-muted-foreground">
          Paste a token to have it verified against GitHub right now. The engine reads its own
          credential from the environment variable named on the repository below — this field
          never writes anything.
        </p>
      </FormRow>

      {error ? <ErrorAlert message={error} /> : null}

      {report ? (
        <div className="space-y-1">
          {report.checks.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </div>
      ) : null}

      <InlineActions>
        <Button type="button" onClick={() => void run()} disabled={busy}>
          {busy ? "Checking…" : report ? "Run checks again" : "Run checks"}
        </Button>
        {report ? (
          <span className="text-sm text-muted-foreground">
            {report.ok
              ? "No blocking problems found."
              : "Fix the failures above, then run the checks again."}
          </span>
        ) : null}
      </InlineActions>
    </FormStack>
  );
}

function CheckRow({ check }: { readonly check: PreflightCheck }): React.ReactElement {
  const Icon = check.status === "pass" ? CheckCircle2 : check.status === "warn" ? AlertTriangle : XCircle;
  const tone =
    check.status === "pass"
      ? "text-functional-success"
      : check.status === "warn"
        ? "text-functional-warning"
        : "text-destructive";
  return (
    <div className="flex items-start gap-3 rounded-md border px-3 py-2">
      <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${tone}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{check.label}</div>
        <div className="break-words font-mono text-xs text-muted-foreground">{check.detail}</div>
        {check.hint ? (
          <div className="mt-1 text-xs text-muted-foreground">{check.hint}</div>
        ) : null}
      </div>
    </div>
  );
}
