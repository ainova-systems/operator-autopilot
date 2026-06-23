import Database from "better-sqlite3";
import type { OperationContext } from "@operator/core";
import type { WorkItem, WorkItemKind, WorkItemStatus } from "@operator/core";
import type { StateManager, ExecutionRecord, OutcomeRecord } from "@operator/core";
import type { DateRange } from "@operator/core";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schedule_state (
  repo_id TEXT NOT NULL, action TEXT NOT NULL, last_run TEXT NOT NULL,
  PRIMARY KEY (repo_id, action)
);
CREATE TABLE IF NOT EXISTS execution_log (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, trace_id TEXT NOT NULL,
  pipeline TEXT NOT NULL, agent TEXT, started_at TEXT NOT NULL, finished_at TEXT,
  duration_ms INTEGER, cost_usd REAL, status TEXT NOT NULL, input_ref TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_repo ON execution_log (repo_id, pipeline, started_at);
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, priority INTEGER NOT NULL, source TEXT, branch TEXT,
  pr_number INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wi_queue ON work_items (repo_id, kind, status, priority);
CREATE TABLE IF NOT EXISTS outcomes (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL, observed_at TEXT, status TEXT, signals TEXT,
  recommendation TEXT, risk_score REAL
);
CREATE INDEX IF NOT EXISTS idx_outcome_repo ON outcomes (repo_id, delivered_at);
CREATE TABLE IF NOT EXISTS known_items (
  repo_id TEXT NOT NULL, source_key TEXT NOT NULL, first_seen TEXT NOT NULL,
  PRIMARY KEY (repo_id, source_key)
);
CREATE TABLE IF NOT EXISTS notification_log (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, channel TEXT NOT NULL,
  event TEXT NOT NULL, sent_at TEXT NOT NULL, status TEXT NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS recovery_queue (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, pipeline TEXT NOT NULL,
  stage TEXT NOT NULL, context TEXT NOT NULL, interrupted_at TEXT NOT NULL
);
`;

/**
 * SQLite-backed StateManager.
 *
 * State is a CACHE, not source of truth — same principle as V1 state.sh.
 * GitHub API / file frontmatter is the source of truth; DB can be rebuilt.
 */
export class SQLiteStateManager implements StateManager {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  // ── Work items ──────────────────────────────────────────────────────

  async upsertWorkItem(ctx: OperationContext, item: WorkItem): Promise<void> {
    // ON CONFLICT must update `kind` too — work-item files are source of
    // truth, so if a file's frontmatter kind changes (e.g. legacy
    // `type: analyzer` rewritten to `kind: finding`) the DB row MUST
    // follow. Pre-fix bug (2026-05-20): kind was omitted from the SET
    // clause, so 87 historical rows from the v3 `analyzer` era stayed
    // pinned at kind=analyzer forever and the finding-plan selector
    // (filtering by kind=finding) couldn't see them — engine reported
    // "no finding items in state" despite 97 `kind: finding` .md files
    // on develop. Repo_id is intentionally NOT in the SET — once a row
    // is bound to a repo, that binding is immutable.
    this.db.prepare(`
      INSERT INTO work_items (id, repo_id, kind, title, body, status, priority, source, branch, pr_number, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind, status=excluded.status, priority=excluded.priority,
        source=excluded.source, branch=excluded.branch, pr_number=excluded.pr_number,
        title=excluded.title, body=excluded.body, updated_at=excluded.updated_at
    `).run(
      item.id, ctx.repoId, item.kind, item.title, item.body,
      item.status, item.priority, item.source ?? null,
      item.branch ?? null, item.codeReviewId ?? null,
      item.createdAt, item.updatedAt,
    );
  }

  async getWorkItem(ctx: OperationContext, id: string): Promise<WorkItem | null> {
    const row = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToWorkItem(row) : null;
  }

  async deleteWorkItem(ctx: OperationContext, id: string): Promise<void> {
    this.db.prepare("DELETE FROM work_items WHERE id = ? AND repo_id = ?").run(id, ctx.repoId);
  }

  async listWorkItems(ctx: OperationContext, filters?: {
    kind?: WorkItemKind;
    status?: WorkItemStatus[];
    limit?: number;
  }): Promise<WorkItem[]> {
    let sql = "SELECT * FROM work_items WHERE repo_id = ?";
    const params: unknown[] = [ctx.repoId];

    if (filters?.kind) {
      sql += " AND kind = ?";
      params.push(filters.kind);
    }
    if (filters?.status && filters.status.length > 0) {
      sql += ` AND status IN (${filters.status.map(() => "?").join(",")})`;
      params.push(...filters.status);
    }
    sql += " ORDER BY priority ASC, created_at ASC";
    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToWorkItem);
  }

  async updateWorkItemStatus(ctx: OperationContext, id: string, status: WorkItemStatus): Promise<void> {
    this.db.prepare(
      "UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?",
    ).run(status, new Date().toISOString(), id);
  }

  // ── Execution log ───────────────────────────────────────────────────

  async appendExecution(ctx: OperationContext, record: ExecutionRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO execution_log (id, repo_id, trace_id, pipeline, agent, started_at, finished_at, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, ctx.repoId, record.traceId, record.pipeline,
      record.agent ?? null, record.startedAt, record.finishedAt ?? null,
      record.status, record.error ?? null,
    );
  }

  async listExecutions(ctx: OperationContext, range?: DateRange): Promise<ExecutionRecord[]> {
    let sql = "SELECT * FROM execution_log WHERE repo_id = ?";
    const params: unknown[] = [ctx.repoId];

    if (range) {
      sql += " AND started_at >= ? AND started_at <= ?";
      params.push(range.from, range.to);
    }
    sql += " ORDER BY started_at DESC";

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToExecution);
  }

  // ── Outcomes ────────────────────────────────────────────────────────

  async saveOutcome(ctx: OperationContext, outcome: OutcomeRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO outcomes (id, repo_id, work_item_id, delivered_at, observed_at, status, signals, recommendation, risk_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        observed_at=excluded.observed_at, status=excluded.status, signals=excluded.signals,
        recommendation=excluded.recommendation, risk_score=excluded.risk_score
    `).run(
      outcome.id, ctx.repoId, outcome.workItemId, outcome.deliveredAt,
      outcome.observedAt ?? null, outcome.status,
      JSON.stringify(outcome.signals), outcome.recommendation ?? null,
      outcome.riskScore ?? null,
    );
  }

  async listOutcomes(ctx: OperationContext, range?: DateRange): Promise<OutcomeRecord[]> {
    let sql = "SELECT * FROM outcomes WHERE repo_id = ?";
    const params: unknown[] = [ctx.repoId];

    if (range) {
      sql += " AND delivered_at >= ? AND delivered_at <= ?";
      params.push(range.from, range.to);
    }
    sql += " ORDER BY delivered_at DESC";

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToOutcome);
  }

  // ── Schedule tracking (ports V1 schedule_due_minutes / schedule_mark_run) ──

  async isScheduleDue(ctx: OperationContext, repoId: string, action: string, intervalMinutes: number): Promise<boolean> {
    const row = this.db.prepare(
      "SELECT last_run FROM schedule_state WHERE repo_id = ? AND action = ?",
    ).get(repoId, action) as { last_run: string } | undefined;

    if (!row) return true; // Never run → due

    const lastEpoch = new Date(row.last_run).getTime();
    const nowEpoch = Date.now();
    const diffMinutes = (nowEpoch - lastEpoch) / 60_000;
    return diffMinutes >= intervalMinutes;
  }

  async markScheduleRun(ctx: OperationContext, repoId: string, action: string): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO schedule_state (repo_id, action, last_run) VALUES (?, ?, ?)
      ON CONFLICT(repo_id, action) DO UPDATE SET last_run = excluded.last_run
    `).run(repoId, action, now);
  }

  // ── Deduplication ───────────────────────────────────────────────────

  async isKnownItem(ctx: OperationContext, repoId: string, sourceKey: string): Promise<boolean> {
    const row = this.db.prepare(
      "SELECT 1 FROM known_items WHERE repo_id = ? AND source_key = ?",
    ).get(repoId, sourceKey);
    return row !== undefined;
  }

  async markKnownItem(ctx: OperationContext, repoId: string, sourceKey: string): Promise<void> {
    this.db.prepare(`
      INSERT OR IGNORE INTO known_items (repo_id, source_key, first_seen) VALUES (?, ?, ?)
    `).run(repoId, sourceKey, new Date().toISOString());
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}

// ── Row mappers ─────────────────────────────────────────────────────────

function rowToWorkItem(row: Record<string, unknown>): WorkItem {
  return {
    id: row["id"] as string,
    kind: row["kind"] as WorkItem["kind"],
    title: row["title"] as string,
    body: row["body"] as string,
    status: row["status"] as WorkItem["status"],
    priority: row["priority"] as WorkItem["priority"],
    source: (row["source"] as string) || undefined,
    branch: (row["branch"] as string) || undefined,
    codeReviewId: (row["pr_number"] as number) || undefined,
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
  };
}

function rowToExecution(row: Record<string, unknown>): ExecutionRecord {
  return {
    id: row["id"] as string,
    traceId: row["trace_id"] as string,
    pipeline: row["pipeline"] as string,
    agent: (row["agent"] as string) || undefined,
    status: row["status"] as ExecutionRecord["status"],
    startedAt: row["started_at"] as string,
    finishedAt: (row["finished_at"] as string) || undefined,
    error: (row["error"] as string) || undefined,
  };
}

function rowToOutcome(row: Record<string, unknown>): OutcomeRecord {
  return {
    id: row["id"] as string,
    workItemId: row["work_item_id"] as string,
    deliveredAt: row["delivered_at"] as string,
    observedAt: (row["observed_at"] as string) || undefined,
    status: row["status"] as OutcomeRecord["status"],
    signals: JSON.parse((row["signals"] as string) || "[]") as string[],
    recommendation: (row["recommendation"] as OutcomeRecord["recommendation"]) || undefined,
    riskScore: (row["risk_score"] as number) || undefined,
  };
}
