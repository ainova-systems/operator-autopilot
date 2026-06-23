import type { Comment } from "@operator/core";

/**
 * Structured attribution embedded in every bot reply on a PR.
 *
 * The PR thread itself is the source of truth for "what state did the
 * bot leave this PR in?" — pr-feedback selector + pr-lifecycle read the
 * latest bot comment's footer to reconstruct that state, instead of
 * keeping a parallel ledger in KV that can drift across restarts.
 *
 * Three orthogonal signal kinds, each independently tracked:
 *
 *   - `responded`  — set of comment / review-comment ids the bot has
 *                    answered. New comments not in this set drive a
 *                    fresh pr-review run.
 *   - `ciHead`     — head SHA the bot saw when it last ran. New SHA
 *                    means the agent (or a human) pushed code; CI retry
 *                    budget resets.
 *   - `ciAttempt`  — `current/max` retries spent on `ciHead`. Once
 *                    `current >= max` and CI still failing on the same
 *                    SHA, pr-lifecycle escalates to `ai:failed`.
 *
 * Footer format (HTML comment, hidden on GitHub UI but greppable):
 *
 *   <!-- bot:operator/attribution
 *   responded: 12345,67890
 *   ci-head: abc12345
 *   ci-attempt: 2/3
 *   -->
 *
 * The fenced block is single-shot per comment; older parallel marker
 * `<!-- bot:operator -->` (used as conventions.commentMarker) coexists
 * for now — `parseLatestBotFooter` matches either.
 */
export interface BotAttribution {
  readonly responded: ReadonlySet<string>;
  readonly ciHead?: string;
  readonly ciAttempt?: { readonly current: number; readonly max: number };
}

/** Fenced footer block surrounding the structured attribution. */
const FOOTER_OPEN = "<!-- bot:operator/attribution";
const FOOTER_CLOSE = "-->";
const FOOTER_RE = /<!-- bot:operator\/attribution\s*([\s\S]*?)\s*-->/;

/** Format a footer block. Returns empty string if `a` carries nothing. */
export function formatFooter(a: BotAttribution): string {
  const lines: string[] = [];
  if (a.responded.size > 0) {
    lines.push(`responded: ${[...a.responded].sort().join(",")}`);
  }
  if (a.ciHead) lines.push(`ci-head: ${a.ciHead}`);
  if (a.ciAttempt) {
    lines.push(`ci-attempt: ${a.ciAttempt.current}/${a.ciAttempt.max}`);
  }
  if (lines.length === 0) return "";
  return `${FOOTER_OPEN}\n${lines.join("\n")}\n${FOOTER_CLOSE}`;
}

/** Empty attribution — used when no bot reply exists yet. */
export function emptyAttribution(): BotAttribution {
  return { responded: new Set() };
}

/**
 * Parse the latest bot comment's footer into structured attribution.
 * "Latest" is the most recent (by `createdAt`) bot-marker-bearing
 * comment in the thread. Bot replies without a fenced footer (legacy
 * comments shipped before this primitive) parse as
 * {@link emptyAttribution} — they trigger a fresh pr-review on the
 * next cycle, which writes a proper footer; from there the loop is
 * coherent.
 *
 * `marker` is the same string as `ConventionsConfig.commentMarker`
 * (e.g. `<!-- bot:operator -->`) — the legacy free-text marker.
 */
export function parseLatestBotFooter(
  comments: ReadonlyArray<Comment>,
  marker: string,
): BotAttribution {
  let latest: Comment | undefined;
  for (const c of comments) {
    if (!c.body.includes(marker)) continue;
    if (!latest || c.createdAt > latest.createdAt) latest = c;
  }
  if (!latest) return emptyAttribution();
  return parseFooter(latest.body);
}

/** Parse a single comment body. Exported for direct tests. */
export function parseFooter(body: string): BotAttribution {
  const match = body.match(FOOTER_RE);
  if (!match) return emptyAttribution();
  const block = match[1];
  const responded = new Set<string>();
  let ciHead: string | undefined;
  let ciAttempt: { current: number; max: number } | undefined;
  for (const raw of block.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key === "responded") {
      for (const id of value.split(",")) {
        const trimmed = id.trim();
        if (trimmed) responded.add(trimmed);
      }
    } else if (key === "ci-head") {
      ciHead = value || undefined;
    } else if (key === "ci-attempt") {
      const slash = value.indexOf("/");
      if (slash > 0) {
        const cur = Number(value.slice(0, slash).trim());
        const max = Number(value.slice(slash + 1).trim());
        if (Number.isFinite(cur) && Number.isFinite(max) && max > 0) {
          ciAttempt = { current: cur, max };
        }
      }
    }
  }
  return { responded, ciHead, ciAttempt };
}
