import type { WorkItem } from "@operator/core";

/**
 * Resolve `${item.field}` and `${scopeKey}` references against the
 * selected work item and stage input. Unknown references are left
 * verbatim — agents may intentionally include literal `${...}` tokens
 * in their prompts.
 *
 * Only a narrow set of fields is exposed (`id`, `title`, `body`,
 * `status`, `priority`, `branch`, `kind`) so var substitution cannot
 * leak arbitrary KV row shape into a prompt. Scope-only references
 * (`${scopeKey}`) apply when no item is selected (bootstrap /
 * singleton / discovery stages).
 */
export function substituteVars(
  template: Record<string, string>,
  ctx: { item?: WorkItem; scopeKey?: string },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(template)) {
    out[key] = applySubstitution(raw, ctx);
  }
  return out;
}

function applySubstitution(
  raw: string,
  ctx: { item?: WorkItem; scopeKey?: string },
): string {
  return raw.replace(/\$\{([^}]+)\}/g, (match, path: string) => {
    const resolved = resolvePath(path.trim(), ctx);
    return resolved ?? match;
  });
}

const ITEM_FIELDS = new Set([
  "id", "title", "body", "status", "priority", "branch", "kind",
]);

function resolvePath(
  path: string,
  ctx: { item?: WorkItem; scopeKey?: string },
): string | null {
  if (path === "scopeKey") {
    return ctx.scopeKey ?? null;
  }
  if (path.startsWith("item.")) {
    const field = path.slice("item.".length);
    if (!ITEM_FIELDS.has(field)) return null;
    const value = ctx.item?.[field as keyof WorkItem];
    if (value === undefined || value === null) return null;
    return typeof value === "string" ? value : String(value);
  }
  return null;
}
