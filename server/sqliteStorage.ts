import { mkdirSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { backgroundJobStatusEnum, docsAssessmentSchema, feedbackStatusEnum } from "@shared/schema";
import type {
  AgentRun,
  AgentRunStatus,
  BackgroundJob,
  BackgroundJobKind,
  BackgroundJobStatus,
  Config,
  FeedbackItem,
  LogEntry,
  NewPR,
  PR,
  PRQuestion,
  ReleaseRun,
  ReleaseRunStatus,
  RuntimeState,
  SocialChangelog,
} from "@shared/schema";
import {
  applyBackgroundJobUpdate,
  applyConfigUpdate,
  applyPRQuestionUpdate,
  applyPRUpdate,
  applyReleaseRunUpdate,
  applySocialChangelogUpdate,
  createLogEntry,
  createBackgroundJob,
  createPR,
  createPRQuestion,
  createReleaseRun,
  createSocialChangelog,
} from "@shared/models";
import type { IStorage } from "./storage";
import { getCodeFactoryPaths } from "./paths";
import { DEFAULT_CONFIG } from "./defaultConfig";
import { appendLogFile } from "./logFiles";

type ConfigRow = {
  github_token: string;
  coding_agent: Config["codingAgent"];
  model: string;
  max_turns: number;
  batch_window_ms: number;
  poll_interval_ms: number;
  max_changes_per_run: number;
  auto_resolve_merge_conflicts: number;
  auto_create_releases: number;
  auto_update_docs: number;
  trusted_reviewers_json: string;
  ignored_bots_json: string;
};

const LEGACY_CONFIG_MODEL_PLACEHOLDER = "cli-managed";
export const SQLITE_LOCK_TIMEOUT_MS = 1000;
export const SQLITE_LOCK_RECOVERY_RETRIES = 1;
const SQLITE_RETRYABLE_LOCK_ERRCODES = new Set([5, 6]);
const DEFAULT_RUNTIME_STATE: RuntimeState = {
  drainMode: false,
  drainRequestedAt: null,
  drainReason: null,
};

type SqliteError = Error & {
  code?: string;
  errcode?: number;
  errstr?: string;
  statusCode?: number;
};

type PRRow = {
  id: string;
  number: number;
  title: string;
  repo: string;
  branch: string;
  author: string;
  url: string;
  status: PR["status"];
  accepted: number;
  rejected: number;
  flagged: number;
  tests_passed: number | null;
  lint_passed: number | null;
  last_checked: string | null;
  watch_enabled: number;
  docs_assessment_json: string | null;
  added_at: string;
};

type FeedbackItemRow = {
  id: string;
  pr_id: string;
  author: string;
  body: string;
  body_html: string;
  reply_kind: FeedbackItem["replyKind"];
  source_id: string;
  source_node_id: string | null;
  source_url: string | null;
  thread_id: string | null;
  thread_resolved: number | null;
  audit_token: string;
  file: string | null;
  line: number | null;
  type: FeedbackItem["type"];
  created_at: string;
  decision: FeedbackItem["decision"];
  decision_reason: string | null;
  action: string | null;
  status: string;
  status_reason: string | null;
};

type LogRow = {
  id: string;
  pr_id: string;
  run_id: string | null;
  timestamp: string;
  level: LogEntry["level"];
  phase: string | null;
  message: string;
  metadata_json: string | null;
};

type RuntimeStateRow = {
  drain_mode: number;
  drain_requested_at: string | null;
  drain_reason: string | null;
};

type AgentRunRow = {
  id: string;
  pr_id: string;
  preferred_agent: Config["codingAgent"];
  resolved_agent: Config["codingAgent"] | null;
  status: AgentRunStatus;
  phase: string;
  prompt: string | null;
  initial_head_sha: string | null;
  metadata_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type QuestionRow = {
  id: string;
  pr_id: string;
  question: string;
  answer: string | null;
  status: PRQuestion["status"];
  error: string | null;
  created_at: string;
  answered_at: string | null;
};

type BackgroundJobRow = {
  id: string;
  kind: BackgroundJobKind;
  target_id: string;
  dedupe_key: string;
  status: BackgroundJobStatus;
  priority: number;
  available_at: string;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  attempt_count: number;
  last_error: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type SocialChangelogRow = {
  id: string;
  date: string;
  trigger_count: number;
  pr_summaries_json: string;
  content: string | null;
  status: SocialChangelog["status"];
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

type ReleaseRunRow = {
  id: string;
  repo: string;
  base_branch: string;
  trigger_pr_number: number;
  trigger_pr_title: string;
  trigger_pr_url: string;
  trigger_merge_sha: string;
  trigger_merged_at: string;
  status: ReleaseRunStatus;
  decision_reason: string | null;
  recommended_bump: "patch" | "minor" | "major" | null;
  proposed_version: string | null;
  release_title: string | null;
  release_notes: string | null;
  included_prs_json: string;
  target_sha: string | null;
  github_release_id: number | null;
  github_release_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export class SqliteStorage implements IStorage {
  private db!: DatabaseSync;
  private readonly rootDir: string;
  private readonly logRootDir: string;
  private readonly stateDbPath: string;

  constructor(rootDirOverride?: string) {
    const paths = getCodeFactoryPaths(rootDirOverride);
    mkdirSync(paths.rootDir, { recursive: true });
    mkdirSync(paths.logRootDir, { recursive: true });

    this.rootDir = paths.rootDir;
    this.logRootDir = paths.logRootDir;
    this.stateDbPath = paths.stateDbPath;
    this.db = this.createDatabaseConnection();

    this.bootstrap();
  }

  private createDatabaseConnection(): DatabaseSync {
    const db = new DatabaseSync(this.stateDbPath, {
      timeout: SQLITE_LOCK_TIMEOUT_MS,
      enableForeignKeyConstraints: true,
    });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    return db;
  }

  private isRetryableLockError(error: unknown): error is SqliteError {
    if (!(error instanceof Error)) {
      return false;
    }

    const sqliteError = error as SqliteError;
    return sqliteError.code === "ERR_SQLITE_ERROR"
      && (
        (typeof sqliteError.errcode === "number" && SQLITE_RETRYABLE_LOCK_ERRCODES.has(sqliteError.errcode))
        || (typeof sqliteError.errstr === "string" && sqliteError.errstr.toLowerCase().includes("locked"))
      );
  }

  private reopenDatabase(): void {
    const previousDb = this.db;
    this.db = this.createDatabaseConnection();
    try {
      previousDb.close();
    } catch {
      // Best-effort cleanup after opening the replacement connection.
    }
  }

  private throwPersistentLockError(error: SqliteError): never {
    const wrapped = new Error(
      `SQLite database remained locked after recovery attempts at ${this.stateDbPath}. Stop the competing Code Factory process or use a different OH_MY_PR_HOME.`,
      { cause: error },
    ) as SqliteError;
    wrapped.name = "SqliteDatabaseLockedError";
    wrapped.code = error.code;
    wrapped.errcode = error.errcode;
    wrapped.errstr = error.errstr;
    wrapped.statusCode = 503;
    throw wrapped;
  }

  private withLockRecovery<T>(operation: () => T): T {
    let lastError: SqliteError | undefined;

    for (let attempt = 0; attempt <= SQLITE_LOCK_RECOVERY_RETRIES; attempt += 1) {
      try {
        return operation();
      } catch (error) {
        if (!this.isRetryableLockError(error)) {
          throw error;
        }

        lastError = error;
        if (this.db.isTransaction || attempt === SQLITE_LOCK_RECOVERY_RETRIES) {
          break;
        }

        this.reopenDatabase();
      }
    }

    this.throwPersistentLockError(lastError ?? new Error("SQLite database lock recovery failed."));
  }

  private exec(sql: string): void {
    this.withLockRecovery(() => {
      this.db.exec(sql);
    });
  }

  private get<Row>(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.withLockRecovery(
      () => this.db.prepare(sql).get(...params) as Row | undefined,
    );
  }

  private all<Row>(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.withLockRecovery(
      () => this.db.prepare(sql).all(...params) as Row[],
    );
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    return this.withLockRecovery(
      () => this.db.prepare(sql).run(...params),
    );
  }

  private withWriteTransaction<T>(operation: () => T): T {
    if (this.db.isTransaction) {
      return operation();
    }

    this.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Preserve the original error if rollback also fails.
        }
      }
      throw error;
    }
  }

  private bootstrap(): void {
    this.exec(`
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        github_token TEXT NOT NULL,
        coding_agent TEXT NOT NULL,
        model TEXT NOT NULL,
        max_turns INTEGER NOT NULL,
        batch_window_ms INTEGER NOT NULL,
        poll_interval_ms INTEGER NOT NULL,
        max_changes_per_run INTEGER NOT NULL,
        auto_resolve_merge_conflicts INTEGER NOT NULL DEFAULT 1,
        auto_create_releases INTEGER NOT NULL DEFAULT 1,
        auto_update_docs INTEGER NOT NULL DEFAULT 1,
        trusted_reviewers_json TEXT NOT NULL,
        ignored_bots_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS watched_repos (
        repo TEXT PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS prs (
        id TEXT PRIMARY KEY,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        author TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        accepted INTEGER NOT NULL,
        rejected INTEGER NOT NULL,
        flagged INTEGER NOT NULL,
        tests_passed INTEGER,
        lint_passed INTEGER,
        last_checked TEXT,
        watch_enabled INTEGER NOT NULL DEFAULT 1,
        docs_assessment_json TEXT,
        added_at TEXT NOT NULL,
        UNIQUE(repo, number)
      );

      CREATE TABLE IF NOT EXISTS feedback_items (
        id TEXT PRIMARY KEY,
        pr_id TEXT NOT NULL,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        body_html TEXT NOT NULL,
        reply_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_node_id TEXT,
        source_url TEXT,
        thread_id TEXT,
        thread_resolved INTEGER,
        audit_token TEXT NOT NULL,
        file TEXT,
        line INTEGER,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decision TEXT,
        decision_reason TEXT,
        action TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        status_reason TEXT,
        FOREIGN KEY(pr_id) REFERENCES prs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        pr_id TEXT NOT NULL,
        run_id TEXT,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        phase TEXT,
        message TEXT NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY(pr_id) REFERENCES prs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS runtime_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        drain_mode INTEGER NOT NULL DEFAULT 0,
        drain_requested_at TEXT,
        drain_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        pr_id TEXT NOT NULL,
        preferred_agent TEXT NOT NULL,
        resolved_agent TEXT,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        prompt TEXT,
        initial_head_sha TEXT,
        metadata_json TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(pr_id) REFERENCES prs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS background_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS pr_questions (
        id TEXT PRIMARY KEY,
        pr_id TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT,
        FOREIGN KEY(pr_id) REFERENCES prs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS social_changelogs (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        trigger_count INTEGER NOT NULL,
        pr_summaries_json TEXT NOT NULL,
        content TEXT,
        status TEXT NOT NULL DEFAULT 'generating',
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(date, trigger_count)
      );

      CREATE TABLE IF NOT EXISTS release_runs (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        trigger_pr_number INTEGER NOT NULL,
        trigger_pr_title TEXT NOT NULL,
        trigger_pr_url TEXT NOT NULL,
        trigger_merge_sha TEXT NOT NULL,
        trigger_merged_at TEXT NOT NULL,
        status TEXT NOT NULL,
        decision_reason TEXT,
        recommended_bump TEXT,
        proposed_version TEXT,
        release_title TEXT,
        release_notes TEXT,
        included_prs_json TEXT NOT NULL,
        target_sha TEXT,
        github_release_id INTEGER,
        github_release_url TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(repo, trigger_pr_number, trigger_merge_sha)
      );

      CREATE INDEX IF NOT EXISTS idx_feedback_items_pr_id ON feedback_items(pr_id);
      CREATE INDEX IF NOT EXISTS idx_logs_pr_id_timestamp ON logs(pr_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_status_updated_at ON agent_runs(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_background_jobs_status_available_at ON background_jobs(status, available_at, priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_background_jobs_lease_expires_at ON background_jobs(status, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_background_jobs_kind_status ON background_jobs(kind, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_background_jobs_dedupe_active ON background_jobs(dedupe_key) WHERE status IN ('queued', 'leased');
      CREATE INDEX IF NOT EXISTS idx_pr_questions_pr_id ON pr_questions(pr_id);
      CREATE INDEX IF NOT EXISTS idx_social_changelogs_date ON social_changelogs(date);
      CREATE INDEX IF NOT EXISTS idx_release_runs_created_at ON release_runs(created_at);
      CREATE INDEX IF NOT EXISTS idx_release_runs_status_created_at ON release_runs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_release_runs_repo_trigger_merge_sha ON release_runs(repo, trigger_merge_sha);
    `);

    this.ensureColumn("feedback_items", "reply_kind", "TEXT NOT NULL DEFAULT 'general_comment'");
    this.ensureColumn("feedback_items", "source_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("feedback_items", "source_node_id", "TEXT");
    this.ensureColumn("feedback_items", "source_url", "TEXT");
    this.ensureColumn("feedback_items", "thread_id", "TEXT");
    this.ensureColumn("feedback_items", "thread_resolved", "INTEGER");
    this.ensureColumn("feedback_items", "audit_token", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("feedback_items", "status", "TEXT NOT NULL DEFAULT 'pending'");
    this.ensureColumn("feedback_items", "status_reason", "TEXT");
    this.ensureColumn("config", "auto_resolve_merge_conflicts", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("config", "auto_create_releases", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("config", "auto_update_docs", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("prs", "watch_enabled", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("prs", "docs_assessment_json", "TEXT");

    const configExists = this.get<{ present: number }>("SELECT 1 AS present FROM config WHERE id = 1");
    if (!configExists) {
      this.writeConfig(DEFAULT_CONFIG);
    }

    const runtimeStateExists = this.get<{ present: number }>(
      "SELECT 1 AS present FROM runtime_state WHERE id = 1",
    );
    if (!runtimeStateExists) {
      this.run(`
        INSERT INTO runtime_state (id, drain_mode, drain_requested_at, drain_reason)
        VALUES (1, 0, NULL, NULL)
      `);
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (rows.some((row) => row.name === column)) {
      return;
    }

    this.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private parseConfigRow(row: ConfigRow | undefined, watchedRepos: string[]): Config {
    if (!row) {
      return {
        ...DEFAULT_CONFIG,
        watchedRepos,
      };
    }

    return {
      githubToken: row.github_token,
      codingAgent: row.coding_agent,
      maxTurns: row.max_turns,
      batchWindowMs: row.batch_window_ms,
      pollIntervalMs: row.poll_interval_ms,
      maxChangesPerRun: row.max_changes_per_run,
      autoResolveMergeConflicts: Boolean(row.auto_resolve_merge_conflicts),
      autoCreateReleases: Boolean(row.auto_create_releases ?? 1),
      autoUpdateDocs: Boolean(row.auto_update_docs ?? 1),
      watchedRepos,
      trustedReviewers: JSON.parse(row.trusted_reviewers_json),
      ignoredBots: JSON.parse(row.ignored_bots_json),
    };
  }

  private writeConfig(config: Config): void {
    this.withWriteTransaction(() => {
      const legacyModelValue = (
        this.get<{ model?: string }>("SELECT model FROM config WHERE id = 1")
      )?.model ?? LEGACY_CONFIG_MODEL_PLACEHOLDER;

      this.run(`
        INSERT INTO config (
          id,
          github_token,
          coding_agent,
          model,
          max_turns,
          batch_window_ms,
          poll_interval_ms,
          max_changes_per_run,
          auto_resolve_merge_conflicts,
          auto_create_releases,
          auto_update_docs,
          trusted_reviewers_json,
          ignored_bots_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          github_token = excluded.github_token,
          coding_agent = excluded.coding_agent,
          model = excluded.model,
          max_turns = excluded.max_turns,
          batch_window_ms = excluded.batch_window_ms,
          poll_interval_ms = excluded.poll_interval_ms,
          max_changes_per_run = excluded.max_changes_per_run,
          auto_resolve_merge_conflicts = excluded.auto_resolve_merge_conflicts,
          auto_create_releases = excluded.auto_create_releases,
          auto_update_docs = excluded.auto_update_docs,
          trusted_reviewers_json = excluded.trusted_reviewers_json,
          ignored_bots_json = excluded.ignored_bots_json
      `,
        1,
        config.githubToken,
        config.codingAgent,
        legacyModelValue,
        config.maxTurns,
        config.batchWindowMs,
        config.pollIntervalMs,
        config.maxChangesPerRun,
        Number(config.autoResolveMergeConflicts),
        Number(config.autoCreateReleases),
        Number(config.autoUpdateDocs),
        JSON.stringify(config.trustedReviewers),
        JSON.stringify(config.ignoredBots),
      );

      this.exec("DELETE FROM watched_repos");
      for (const repo of config.watchedRepos) {
        this.run("INSERT INTO watched_repos (repo) VALUES (?)", repo);
      }
    });
  }

  private getWatchedRepos(): string[] {
    const rows = this.all<{ repo: string }>("SELECT repo FROM watched_repos ORDER BY repo ASC");
    return rows.map((row) => row.repo);
  }

  private parsePRRow(row: PRRow, feedbackItems: FeedbackItem[]): PR {
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      repo: row.repo,
      branch: row.branch,
      author: row.author,
      url: row.url,
      status: row.status,
      feedbackItems,
      accepted: row.accepted,
      rejected: row.rejected,
      flagged: row.flagged,
      testsPassed: row.tests_passed === null ? null : Boolean(row.tests_passed),
      lintPassed: row.lint_passed === null ? null : Boolean(row.lint_passed),
      lastChecked: row.last_checked,
      watchEnabled: Boolean(row.watch_enabled),
      docsAssessment: this.parseDocsAssessment(row.docs_assessment_json),
      addedAt: row.added_at,
    };
  }

  private parseDocsAssessment(raw: string | null): PR["docsAssessment"] {
    if (!raw) {
      return null;
    }

    try {
      return docsAssessmentSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private parseRuntimeStateRow(row: RuntimeStateRow | undefined): RuntimeState {
    if (!row) {
      return {
        ...DEFAULT_RUNTIME_STATE,
      };
    }

    return {
      drainMode: Boolean(row.drain_mode),
      drainRequestedAt: row.drain_requested_at,
      drainReason: row.drain_reason,
    };
  }

  private parseAgentRunRow(row: AgentRunRow): AgentRun {
    return {
      id: row.id,
      prId: row.pr_id,
      preferredAgent: row.preferred_agent,
      resolvedAgent: row.resolved_agent,
      status: row.status,
      phase: row.phase,
      prompt: row.prompt,
      initialHeadSha: row.initial_head_sha,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private parseBackgroundJobRow(row: BackgroundJobRow): BackgroundJob {
    return {
      id: row.id,
      kind: row.kind,
      targetId: row.target_id,
      dedupeKey: row.dedupe_key,
      status: backgroundJobStatusEnum.parse(row.status),
      priority: row.priority,
      availableAt: row.available_at,
      leaseOwner: row.lease_owner,
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at,
      heartbeatAt: row.heartbeat_at,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  private finalizeBackgroundJob(
    id: string,
    leaseToken: string,
    status: "completed" | "failed" | "canceled",
    error: string | null,
    completedAt: string,
  ): BackgroundJob | undefined {
    return this.withWriteTransaction(() => {
      const current = this.get<BackgroundJobRow>(`
        SELECT id, kind, target_id, dedupe_key, status, priority, available_at,
               lease_owner, lease_token, lease_expires_at, heartbeat_at, attempt_count,
               last_error, payload_json, created_at, updated_at, completed_at
        FROM background_jobs
        WHERE id = ? AND status = 'leased' AND lease_token = ?
      `, id, leaseToken);

      if (!current) {
        return undefined;
      }

      const updated = applyBackgroundJobUpdate(this.parseBackgroundJobRow(current), {
        status,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        lastError: error,
        completedAt,
      });

      this.run(`
        UPDATE background_jobs
        SET status = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
            heartbeat_at = NULL, last_error = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'leased' AND lease_token = ?
      `,
        updated.status,
        updated.lastError,
        updated.completedAt,
        updated.updatedAt,
        id,
        leaseToken,
      );

      return updated;
    });
  }

  private getFeedbackItemsForPRIds(prIds: string[]): Map<string, FeedbackItem[]> {
    const itemsByPrId = new Map<string, FeedbackItem[]>();
    if (prIds.length === 0) {
      return itemsByPrId;
    }

    const placeholders = prIds.map(() => "?").join(", ");
    const rows = this.all<FeedbackItemRow>(`
      SELECT id, pr_id, author, body, body_html, reply_kind, source_id, source_node_id, source_url,
             thread_id, thread_resolved, audit_token, file, line, type, created_at, decision,
             decision_reason, action, status, status_reason
      FROM feedback_items
      WHERE pr_id IN (${placeholders})
      ORDER BY created_at ASC
    `, ...prIds);

    for (const row of rows) {
      const item: FeedbackItem = {
        id: row.id,
        author: row.author,
        body: row.body,
        bodyHtml: row.body_html,
        replyKind: row.reply_kind,
        sourceId: row.source_id || row.id,
        sourceNodeId: row.source_node_id,
        sourceUrl: row.source_url,
        threadId: row.thread_id,
        threadResolved: row.thread_resolved === null ? null : Boolean(row.thread_resolved),
        auditToken: row.audit_token || `codefactory-feedback:${row.id}`,
        file: row.file,
        line: row.line,
        type: row.type,
        createdAt: row.created_at,
        decision: row.decision,
        decisionReason: row.decision_reason,
        action: row.action,
        status: feedbackStatusEnum.catch("pending").parse(row.status ?? "pending"),
        statusReason: row.status_reason ?? null,
      };

      const items = itemsByPrId.get(row.pr_id) || [];
      items.push(item);
      itemsByPrId.set(row.pr_id, items);
    }

    return itemsByPrId;
  }

  private replaceFeedbackItems(prId: string, items: FeedbackItem[]): void {
    this.run("DELETE FROM feedback_items WHERE pr_id = ?", prId);

    for (const item of items) {
      this.run(`
        INSERT INTO feedback_items (
          id, pr_id, author, body, body_html, reply_kind, source_id, source_node_id, source_url,
          thread_id, thread_resolved, audit_token, file, line, type, created_at, decision, decision_reason, action,
          status, status_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        item.id,
        prId,
        item.author,
        item.body,
        item.bodyHtml,
        item.replyKind,
        item.sourceId,
        item.sourceNodeId,
        item.sourceUrl,
        item.threadId,
        item.threadResolved === null ? null : Number(item.threadResolved),
        item.auditToken,
        item.file,
        item.line,
        item.type,
        item.createdAt,
        item.decision,
        item.decisionReason,
        item.action,
        item.status,
        item.statusReason,
      );
    }
  }

  async getPRs(): Promise<PR[]> {
    const rows = this.all<PRRow>(`
      SELECT id, number, title, repo, branch, author, url, status, accepted, rejected, flagged,
             tests_passed, lint_passed, last_checked, watch_enabled, docs_assessment_json, added_at
      FROM prs
      WHERE status != 'archived'
      ORDER BY datetime(added_at) DESC
    `);

    const itemsByPrId = this.getFeedbackItemsForPRIds(rows.map((row) => row.id));

    return rows.map((row) => this.parsePRRow(row, itemsByPrId.get(row.id) || []));
  }

  async getArchivedPRs(): Promise<PR[]> {
    const rows = this.all<PRRow>(`
      SELECT id, number, title, repo, branch, author, url, status, accepted, rejected, flagged,
             tests_passed, lint_passed, last_checked, watch_enabled, docs_assessment_json, added_at
      FROM prs
      WHERE status = 'archived'
      ORDER BY datetime(added_at) DESC
    `);

    const itemsByPrId = this.getFeedbackItemsForPRIds(rows.map((row) => row.id));

    return rows.map((row) => this.parsePRRow(row, itemsByPrId.get(row.id) || []));
  }

  async getPR(id: string): Promise<PR | undefined> {
    const row = this.get<PRRow>(`
      SELECT id, number, title, repo, branch, author, url, status, accepted, rejected, flagged,
             tests_passed, lint_passed, last_checked, watch_enabled, docs_assessment_json, added_at
      FROM prs
      WHERE id = ?
    `, id);

    if (!row) {
      return undefined;
    }

    const itemsByPrId = this.getFeedbackItemsForPRIds([id]);
    return this.parsePRRow(row, itemsByPrId.get(id) || []);
  }

  async getPRByRepoAndNumber(repo: string, number: number): Promise<PR | undefined> {
    const row = this.get<PRRow>(`
      SELECT id, number, title, repo, branch, author, url, status, accepted, rejected, flagged,
             tests_passed, lint_passed, last_checked, watch_enabled, docs_assessment_json, added_at
      FROM prs
      WHERE repo = ? AND number = ?
    `, repo, number);

    if (!row) {
      return undefined;
    }

    const itemsByPrId = this.getFeedbackItemsForPRIds([row.id]);
    return this.parsePRRow(row, itemsByPrId.get(row.id) || []);
  }

  async addPR(pr: NewPR): Promise<PR> {
    const full = createPR(pr);

    this.withWriteTransaction(() => {
      this.run(`
        INSERT INTO prs (
          id, number, title, repo, branch, author, url, status, accepted, rejected, flagged,
          tests_passed, lint_passed, last_checked, watch_enabled, docs_assessment_json, added_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        full.id,
        full.number,
        full.title,
        full.repo,
        full.branch,
        full.author,
        full.url,
        full.status,
        full.accepted,
        full.rejected,
        full.flagged,
        full.testsPassed === null ? null : Number(full.testsPassed),
        full.lintPassed === null ? null : Number(full.lintPassed),
        full.lastChecked,
        Number(full.watchEnabled),
        full.docsAssessment ? JSON.stringify(full.docsAssessment) : null,
        full.addedAt,
      );

      this.replaceFeedbackItems(full.id, full.feedbackItems);
    });
    return full;
  }

  async updatePR(id: string, updates: Partial<PR>): Promise<PR | undefined> {
    const existing = await this.getPR(id);
    if (!existing) {
      return undefined;
    }

    const updated = applyPRUpdate(existing, updates);

    this.withWriteTransaction(() => {
      this.run(`
        UPDATE prs
        SET number = ?, title = ?, repo = ?, branch = ?, author = ?, url = ?, status = ?,
            accepted = ?, rejected = ?, flagged = ?, tests_passed = ?, lint_passed = ?, last_checked = ?, watch_enabled = ?, docs_assessment_json = ?
        WHERE id = ?
      `,
        updated.number,
        updated.title,
        updated.repo,
        updated.branch,
        updated.author,
        updated.url,
        updated.status,
        updated.accepted,
        updated.rejected,
        updated.flagged,
        updated.testsPassed === null ? null : Number(updated.testsPassed),
        updated.lintPassed === null ? null : Number(updated.lintPassed),
        updated.lastChecked,
        Number(updated.watchEnabled),
        updated.docsAssessment ? JSON.stringify(updated.docsAssessment) : null,
        id,
      );

      this.replaceFeedbackItems(id, updated.feedbackItems);
    });
    return updated;
  }

  async removePR(id: string): Promise<boolean> {
    const result = this.run("DELETE FROM prs WHERE id = ?", id);
    return result.changes > 0;
  }

  async getQuestions(prId: string): Promise<PRQuestion[]> {
    const rows = this.all<QuestionRow>(`
      SELECT id, pr_id, question, answer, status, error, created_at, answered_at
      FROM pr_questions
      WHERE pr_id = ?
      ORDER BY datetime(created_at) ASC
    `, prId);

    return rows.map((row) => ({
      id: row.id,
      prId: row.pr_id,
      question: row.question,
      answer: row.answer,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      answeredAt: row.answered_at,
    }));
  }

  async addQuestion(prId: string, question: string): Promise<PRQuestion> {
    const entry = createPRQuestion(prId, question);

    this.run(`
      INSERT INTO pr_questions (id, pr_id, question, answer, status, error, created_at, answered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, entry.id, entry.prId, entry.question, entry.answer, entry.status, entry.error, entry.createdAt, entry.answeredAt);

    return entry;
  }

  async updateQuestion(id: string, updates: Partial<PRQuestion>): Promise<PRQuestion | undefined> {
    const row = this.get<QuestionRow>(`
      SELECT id, pr_id, question, answer, status, error, created_at, answered_at
      FROM pr_questions WHERE id = ?
    `, id);

    if (!row) return undefined;

    const current: PRQuestion = {
      id: row.id, prId: row.pr_id, question: row.question, answer: row.answer,
      status: row.status, error: row.error, createdAt: row.created_at, answeredAt: row.answered_at,
    };

    const updated = applyPRQuestionUpdate(current, updates);

    this.run(`
      UPDATE pr_questions SET answer = ?, status = ?, error = ?, answered_at = ? WHERE id = ?
    `, updated.answer, updated.status, updated.error, updated.answeredAt, updated.id);

    return updated;
  }

  async getLogs(prId?: string): Promise<LogEntry[]> {
    const rows = prId
      ? this.all<LogRow>(`
          SELECT id, pr_id, run_id, timestamp, level, phase, message, metadata_json
          FROM logs
          WHERE pr_id = ?
          ORDER BY datetime(timestamp) ASC
          LIMIT 500
        `, prId)
      : this.all<LogRow>(`
          SELECT id, pr_id, run_id, timestamp, level, phase, message, metadata_json
          FROM logs
          ORDER BY datetime(timestamp) ASC
          LIMIT 500
        `);

    return rows.map((row) => ({
      id: row.id,
      prId: row.pr_id,
      runId: row.run_id,
      timestamp: row.timestamp,
      level: row.level,
      phase: row.phase,
      message: row.message,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    }));
  }

  async addLog(
    prId: string,
    level: "info" | "warn" | "error",
    message: string,
    details?: {
      runId?: string | null;
      phase?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<LogEntry> {
    const entry = createLogEntry(prId, level, message, details);

    this.run(`
      INSERT INTO logs (id, pr_id, run_id, timestamp, level, phase, message, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      entry.id,
      entry.prId,
      entry.runId,
      entry.timestamp,
      entry.level,
      entry.phase,
      entry.message,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    );

    const pr = this.get<{ repo: string; number: number }>(
      "SELECT repo, number FROM prs WHERE id = ?",
      prId,
    );
    if (pr) {
      appendLogFile(this.logRootDir, pr, entry);
    }

    return entry;
  }

  async clearLogs(prId?: string): Promise<void> {
    if (prId) {
      this.run("DELETE FROM logs WHERE pr_id = ?", prId);
      return;
    }

    this.exec("DELETE FROM logs");
  }

  async getConfig(): Promise<Config> {
    const row = this.get<ConfigRow>(`
      SELECT github_token, coding_agent, model, max_turns, batch_window_ms,
             poll_interval_ms, max_changes_per_run, auto_resolve_merge_conflicts, auto_create_releases,
             auto_update_docs,
             trusted_reviewers_json, ignored_bots_json
      FROM config
      WHERE id = 1
    `);

    return this.parseConfigRow(row, this.getWatchedRepos());
  }

  async updateConfig(updates: Partial<Config>): Promise<Config> {
    const current = await this.getConfig();
    const next = applyConfigUpdate(current, updates);
    this.writeConfig(next);
    return next;
  }

  async getRuntimeState(): Promise<RuntimeState> {
    const row = this.get<RuntimeStateRow>(`
      SELECT drain_mode, drain_requested_at, drain_reason
      FROM runtime_state
      WHERE id = 1
    `);

    return this.parseRuntimeStateRow(row);
  }

  async updateRuntimeState(updates: Partial<RuntimeState>): Promise<RuntimeState> {
    const current = await this.getRuntimeState();
    const next: RuntimeState = {
      ...current,
      ...updates,
    };

    this.run(`
      INSERT INTO runtime_state (id, drain_mode, drain_requested_at, drain_reason)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        drain_mode = excluded.drain_mode,
        drain_requested_at = excluded.drain_requested_at,
        drain_reason = excluded.drain_reason
    `,
      Number(next.drainMode),
      next.drainRequestedAt,
      next.drainReason,
    );

    return next;
  }

  async getBackgroundJob(id: string): Promise<BackgroundJob | undefined> {
    const row = this.get<BackgroundJobRow>(`
      SELECT id, kind, target_id, dedupe_key, status, priority, available_at,
             lease_owner, lease_token, lease_expires_at, heartbeat_at, attempt_count,
             last_error, payload_json, created_at, updated_at, completed_at
      FROM background_jobs
      WHERE id = ?
    `, id);

    return row ? this.parseBackgroundJobRow(row) : undefined;
  }

  async listBackgroundJobs(filters?: {
    kind?: BackgroundJobKind;
    status?: BackgroundJobStatus;
    dedupeKey?: string;
    targetId?: string;
  }): Promise<BackgroundJob[]> {
    const clauses: string[] = [];
    const values: Array<string> = [];

    if (filters?.kind) {
      clauses.push("kind = ?");
      values.push(filters.kind);
    }

    if (filters?.status) {
      clauses.push("status = ?");
      values.push(filters.status);
    }

    if (filters?.dedupeKey) {
      clauses.push("dedupe_key = ?");
      values.push(filters.dedupeKey);
    }

    if (filters?.targetId) {
      clauses.push("target_id = ?");
      values.push(filters.targetId);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    const rows = this.all<BackgroundJobRow>(`
      SELECT id, kind, target_id, dedupe_key, status, priority, available_at,
             lease_owner, lease_token, lease_expires_at, heartbeat_at, attempt_count,
             last_error, payload_json, created_at, updated_at, completed_at
      FROM background_jobs
      ${whereClause}
      ORDER BY priority ASC, datetime(available_at) ASC, datetime(created_at) ASC
    `, ...values);

    return rows.map((row) => this.parseBackgroundJobRow(row));
  }

  async enqueueBackgroundJob(data: {
    kind: BackgroundJobKind;
    targetId: string;
    dedupeKey: string;
    payload?: Record<string, unknown>;
    priority?: number;
    availableAt?: string;
  }): Promise<BackgroundJob> {
    const existing = this.get<BackgroundJobRow>(`
      SELECT id, kind, target_id, dedupe_key, status, priority, available_at,
             lease_owner, lease_token, lease_expires_at, heartbeat_at, attempt_count,
             last_error, payload_json, created_at, updated_at, completed_at
      FROM background_jobs
      WHERE dedupe_key = ? AND status IN ('queued', 'leased')
      ORDER BY datetime(created_at) ASC
      LIMIT 1
    `, data.dedupeKey);
    if (existing) {
      return this.parseBackgroundJobRow(existing);
    }

    const entry = createBackgroundJob({
      kind: data.kind,
      targetId: data.targetId,
      dedupeKey: data.dedupeKey,
      payload: data.payload ?? {},
      priority: data.priority,
      availableAt: data.availableAt ?? new Date().toISOString(),
    });

    try {
      this.run(`
        INSERT INTO background_jobs (
          id, kind, target_id, dedupe_key, status, priority, available_at,
          lease_owner, lease_token, lease_expires_at, heartbeat_at, attempt_count,
          last_error, payload_json, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        entry.id,
        entry.kind,
        entry.targetId,
        entry.dedupeKey,
        entry.status,
        entry.priority,
        entry.availableAt,
        entry.leaseOwner,
        entry.leaseToken,
        entry.leaseExpiresAt,
        entry.heartbeatAt,
        entry.attemptCount,
        entry.lastError,
        JSON.stringify(entry.payload),
        entry.createdAt,
        entry.updatedAt,
        entry.completedAt,
      );
    } catch {
      const deduped = this.get<BackgroundJobRow>(`
        SELECT id, kind, target_id, dedupe_key, status, priority, available_at,
               lease_owner, lease_token, lease_expires_at, heartbeat_at, attempt_count,
               last_error, payload_json, created_at, updated_at, completed_at
        FROM background_jobs
        WHERE dedupe_key = ? AND status IN ('queued', 'leased')
        ORDER BY datetime(created_at) ASC
        LIMIT 1
      `, data.dedupeKey);
      if (!deduped) {
        throw new Error(`Failed to enqueue background job for dedupe key ${data.dedupeKey}`);
      }
      return this.parseBackgroundJobRow(deduped);
    }

    return entry;
  }

  async claimNextBackgroundJob(params: {
    workerId: string;
    leaseToken: string;
    leaseExpiresAt: string;
    now: string;
    kinds?: BackgroundJobKind[];
  }): Promise<BackgroundJob | undefined> {
    return this.withWriteTransaction(() => {
      const clauses = [
        "status = 'queued'",
        "datetime(available_at) <= datetime(?)",
      ];
      const values: Array<SQLInputValue> = [params.now];

      if (params.kinds && params.kinds.length > 0) {
        clauses.push(`kind IN (${params.kinds.map(() => "?").join(", ")})`);
        values.push(...params.kinds);
      }

      const candidate = this.get<BackgroundJobRow>(`
        SELECT id, kind, target_id, dedupe_key, status, priority, available_at,
               lease_owner, lease_token, lease_expires_at, heartbeat_at, attempt_count,
               last_error, payload_json, created_at, updated_at, completed_at
        FROM background_jobs
        WHERE ${clauses.join(" AND ")}
        ORDER BY priority ASC, datetime(available_at) ASC, datetime(created_at) ASC
        LIMIT 1
      `, ...values);

      if (!candidate) {
        return undefined;
      }

      const updated = applyBackgroundJobUpdate(this.parseBackgroundJobRow(candidate), {
        status: "leased",
        leaseOwner: params.workerId,
        leaseToken: params.leaseToken,
        leaseExpiresAt: params.leaseExpiresAt,
        heartbeatAt: params.now,
        attemptCount: candidate.attempt_count + 1,
        completedAt: null,
      });

      const result = this.run(`
        UPDATE background_jobs
        SET status = ?, lease_owner = ?, lease_token = ?, lease_expires_at = ?, heartbeat_at = ?,
            attempt_count = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND status = 'queued'
      `,
        updated.status,
        updated.leaseOwner,
        updated.leaseToken,
        updated.leaseExpiresAt,
        updated.heartbeatAt,
        updated.attemptCount,
        updated.updatedAt,
        updated.completedAt,
        updated.id,
      );

      if (result.changes === 0) {
        return undefined;
      }

      return updated;
    });
  }

  async heartbeatBackgroundJob(
    id: string,
    leaseToken: string,
    heartbeatAt: string,
    leaseExpiresAt: string,
  ): Promise<BackgroundJob | undefined> {
    return this.withWriteTransaction(() => {
      const current = this.get<BackgroundJobRow>(`
        SELECT id, kind, target_id, dedupe_key, status, priority, available_at,
               lease_owner, lease_token, lease_expires_at, heartbeat_at, attempt_count,
               last_error, payload_json, created_at, updated_at, completed_at
        FROM background_jobs
        WHERE id = ? AND status = 'leased' AND lease_token = ?
      `, id, leaseToken);

      if (!current) {
        return undefined;
      }

      const updated = applyBackgroundJobUpdate(this.parseBackgroundJobRow(current), {
        heartbeatAt,
        leaseExpiresAt,
      });

      this.run(`
        UPDATE background_jobs
        SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND status = 'leased' AND lease_token = ?
      `,
        updated.leaseExpiresAt,
        updated.heartbeatAt,
        updated.updatedAt,
        id,
        leaseToken,
      );

      return updated;
    });
  }

  async completeBackgroundJob(id: string, leaseToken: string, completedAt: string): Promise<BackgroundJob | undefined> {
    return this.finalizeBackgroundJob(id, leaseToken, "completed", null, completedAt);
  }

  async failBackgroundJob(id: string, leaseToken: string, error: string, completedAt: string): Promise<BackgroundJob | undefined> {
    return this.finalizeBackgroundJob(id, leaseToken, "failed", error, completedAt);
  }

  async cancelBackgroundJob(
    id: string,
    leaseToken: string,
    error: string | null,
    completedAt: string,
  ): Promise<BackgroundJob | undefined> {
    return this.finalizeBackgroundJob(id, leaseToken, "canceled", error, completedAt);
  }

  async requeueExpiredBackgroundJobs(now: string): Promise<number> {
    const result = this.run(`
      UPDATE background_jobs
      SET status = 'queued',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          updated_at = ?,
          completed_at = NULL
      WHERE status = 'leased' AND lease_expires_at IS NOT NULL AND datetime(lease_expires_at) <= datetime(?)
    `, now, now);

    return Number(result.changes);
  }

  async getAgentRun(id: string): Promise<AgentRun | undefined> {
    const row = this.get<AgentRunRow>(`
      SELECT id, pr_id, preferred_agent, resolved_agent, status, phase, prompt, initial_head_sha,
             metadata_json, last_error, created_at, updated_at
      FROM agent_runs
      WHERE id = ?
    `, id);

    if (!row) {
      return undefined;
    }

    return this.parseAgentRunRow(row);
  }

  async listAgentRuns(filters?: { status?: AgentRunStatus; prId?: string }): Promise<AgentRun[]> {
    const clauses: string[] = [];
    const values: string[] = [];

    if (filters?.status) {
      clauses.push("status = ?");
      values.push(filters.status);
    }

    if (filters?.prId) {
      clauses.push("pr_id = ?");
      values.push(filters.prId);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    const rows = this.all<AgentRunRow>(`
      SELECT id, pr_id, preferred_agent, resolved_agent, status, phase, prompt, initial_head_sha,
             metadata_json, last_error, created_at, updated_at
      FROM agent_runs
      ${whereClause}
      ORDER BY datetime(created_at) ASC
    `, ...values);

    return rows.map((row) => this.parseAgentRunRow(row));
  }

  async upsertAgentRun(run: AgentRun): Promise<AgentRun> {
    const existing = await this.getAgentRun(run.id);
    const stored = existing ? { ...run, createdAt: existing.createdAt } : run;

    this.run(`
      INSERT INTO agent_runs (
        id, pr_id, preferred_agent, resolved_agent, status, phase, prompt, initial_head_sha,
        metadata_json, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        pr_id = excluded.pr_id,
        preferred_agent = excluded.preferred_agent,
        resolved_agent = excluded.resolved_agent,
        status = excluded.status,
        phase = excluded.phase,
        prompt = excluded.prompt,
        initial_head_sha = excluded.initial_head_sha,
        metadata_json = excluded.metadata_json,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `,
      stored.id,
      stored.prId,
      stored.preferredAgent,
      stored.resolvedAgent,
      stored.status,
      stored.phase,
      stored.prompt,
      stored.initialHeadSha,
      stored.metadata ? JSON.stringify(stored.metadata) : null,
      stored.lastError,
      stored.createdAt,
      stored.updatedAt,
    );

    return stored;
  }

  // ── Social changelogs ───────────────────────────────────────────────────

  async getSocialChangelogs(): Promise<SocialChangelog[]> {
    const rows = this.all<SocialChangelogRow>(`
      SELECT id, date, trigger_count, pr_summaries_json, content, status, error, created_at, completed_at
      FROM social_changelogs
      ORDER BY datetime(created_at) DESC
    `);
    return rows.map((row) => this.parseSocialChangelogRow(row));
  }

  async getSocialChangelog(id: string): Promise<SocialChangelog | undefined> {
    const row = this.get<SocialChangelogRow>(`
      SELECT id, date, trigger_count, pr_summaries_json, content, status, error, created_at, completed_at
      FROM social_changelogs
      WHERE id = ?
    `, id);
    return row ? this.parseSocialChangelogRow(row) : undefined;
  }

  async getSocialChangelogForDateAndCount(date: string, triggerCount: number): Promise<SocialChangelog | undefined> {
    const row = this.get<SocialChangelogRow>(`
      SELECT id, date, trigger_count, pr_summaries_json, content, status, error, created_at, completed_at
      FROM social_changelogs
      WHERE date = ? AND trigger_count = ?
    `, date, triggerCount);
    return row ? this.parseSocialChangelogRow(row) : undefined;
  }

  async createSocialChangelog(data: Omit<SocialChangelog, "id" | "createdAt">): Promise<SocialChangelog> {
    const entry = createSocialChangelog(data);
    this.run(`
      INSERT INTO social_changelogs (id, date, trigger_count, pr_summaries_json, content, status, error, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      entry.id,
      entry.date,
      entry.triggerCount,
      JSON.stringify(entry.prSummaries),
      entry.content,
      entry.status,
      entry.error,
      entry.createdAt,
      entry.completedAt,
    );
    return entry;
  }

  async updateSocialChangelog(id: string, updates: Partial<SocialChangelog>): Promise<SocialChangelog | undefined> {
    const existing = await this.getSocialChangelog(id);
    if (!existing) return undefined;
    const next = applySocialChangelogUpdate(existing, updates);
    this.run(`
      UPDATE social_changelogs
      SET date = ?, trigger_count = ?, pr_summaries_json = ?, content = ?, status = ?, error = ?, created_at = ?, completed_at = ?
      WHERE id = ?
    `,
      next.date,
      next.triggerCount,
      JSON.stringify(next.prSummaries),
      next.content,
      next.status,
      next.error,
      next.createdAt,
      next.completedAt,
      id,
    );
    return next;
  }

  private parseSocialChangelogRow(row: SocialChangelogRow): SocialChangelog {
    return {
      id: row.id,
      date: row.date,
      triggerCount: row.trigger_count,
      prSummaries: JSON.parse(row.pr_summaries_json) as SocialChangelog["prSummaries"],
      content: row.content,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }

  private parseReleaseRunRow(row: ReleaseRunRow): ReleaseRun {
    return {
      id: row.id,
      repo: row.repo,
      baseBranch: row.base_branch,
      triggerPrNumber: row.trigger_pr_number,
      triggerPrTitle: row.trigger_pr_title,
      triggerPrUrl: row.trigger_pr_url,
      triggerMergeSha: row.trigger_merge_sha,
      triggerMergedAt: row.trigger_merged_at,
      status: row.status,
      decisionReason: row.decision_reason,
      recommendedBump: row.recommended_bump,
      proposedVersion: row.proposed_version,
      releaseTitle: row.release_title,
      releaseNotes: row.release_notes,
      includedPrs: JSON.parse(row.included_prs_json) as ReleaseRun["includedPrs"],
      targetSha: row.target_sha,
      githubReleaseId: row.github_release_id,
      githubReleaseUrl: row.github_release_url,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  async getReleaseRun(id: string): Promise<ReleaseRun | undefined> {
    const row = this.get<ReleaseRunRow>(`
      SELECT id, repo, base_branch, trigger_pr_number, trigger_pr_title, trigger_pr_url,
             trigger_merge_sha, trigger_merged_at, status, decision_reason, recommended_bump,
             proposed_version, release_title, release_notes, included_prs_json, target_sha,
             github_release_id, github_release_url, error, created_at, updated_at, completed_at
      FROM release_runs
      WHERE id = ?
    `, id);
    return row ? this.parseReleaseRunRow(row) : undefined;
  }

  async getReleaseRunByRepoAndMergeSha(repo: string, triggerMergeSha: string): Promise<ReleaseRun | undefined> {
    const row = this.get<ReleaseRunRow>(`
      SELECT id, repo, base_branch, trigger_pr_number, trigger_pr_title, trigger_pr_url,
             trigger_merge_sha, trigger_merged_at, status, decision_reason, recommended_bump,
             proposed_version, release_title, release_notes, included_prs_json, target_sha,
             github_release_id, github_release_url, error, created_at, updated_at, completed_at
      FROM release_runs
      WHERE repo = ? AND trigger_merge_sha = ?
      ORDER BY datetime(created_at) DESC, rowid DESC
      LIMIT 1
    `, repo, triggerMergeSha);
    return row ? this.parseReleaseRunRow(row) : undefined;
  }

  async getReleaseRunByTrigger(repo: string, triggerPrNumber: number, triggerMergeSha: string): Promise<ReleaseRun | undefined> {
    const row = this.get<ReleaseRunRow>(`
      SELECT id, repo, base_branch, trigger_pr_number, trigger_pr_title, trigger_pr_url,
             trigger_merge_sha, trigger_merged_at, status, decision_reason, recommended_bump,
             proposed_version, release_title, release_notes, included_prs_json, target_sha,
             github_release_id, github_release_url, error, created_at, updated_at, completed_at
      FROM release_runs
      WHERE repo = ? AND trigger_pr_number = ? AND trigger_merge_sha = ?
      ORDER BY datetime(created_at) DESC, rowid DESC
      LIMIT 1
    `, repo, triggerPrNumber, triggerMergeSha);
    return row ? this.parseReleaseRunRow(row) : undefined;
  }

  async listReleaseRuns(filters?: { status?: ReleaseRunStatus; repo?: string }): Promise<ReleaseRun[]> {
    const clauses: string[] = [];
    const values: Array<string | ReleaseRunStatus> = [];

    if (filters?.status) {
      clauses.push("status = ?");
      values.push(filters.status);
    }

    if (filters?.repo) {
      clauses.push("repo = ?");
      values.push(filters.repo);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.all<ReleaseRunRow>(`
      SELECT id, repo, base_branch, trigger_pr_number, trigger_pr_title, trigger_pr_url,
             trigger_merge_sha, trigger_merged_at, status, decision_reason, recommended_bump,
             proposed_version, release_title, release_notes, included_prs_json, target_sha,
             github_release_id, github_release_url, error, created_at, updated_at, completed_at
      FROM release_runs
      ${whereClause}
      ORDER BY datetime(created_at) DESC, rowid DESC
    `, ...values);

    return rows.map((row) => this.parseReleaseRunRow(row));
  }

  async createReleaseRun(data: Omit<ReleaseRun, "id" | "createdAt" | "updatedAt">): Promise<ReleaseRun> {
    const entry = createReleaseRun(data);
    this.run(`
      INSERT INTO release_runs (
        id, repo, base_branch, trigger_pr_number, trigger_pr_title, trigger_pr_url,
        trigger_merge_sha, trigger_merged_at, status, decision_reason, recommended_bump,
        proposed_version, release_title, release_notes, included_prs_json, target_sha,
        github_release_id, github_release_url, error, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      entry.id,
      entry.repo,
      entry.baseBranch,
      entry.triggerPrNumber,
      entry.triggerPrTitle,
      entry.triggerPrUrl,
      entry.triggerMergeSha,
      entry.triggerMergedAt,
      entry.status,
      entry.decisionReason,
      entry.recommendedBump,
      entry.proposedVersion,
      entry.releaseTitle,
      entry.releaseNotes,
      JSON.stringify(entry.includedPrs),
      entry.targetSha,
      entry.githubReleaseId,
      entry.githubReleaseUrl,
      entry.error,
      entry.createdAt,
      entry.updatedAt,
      entry.completedAt,
    );
    return entry;
  }

  async updateReleaseRun(id: string, updates: Partial<ReleaseRun>): Promise<ReleaseRun | undefined> {
    const existing = await this.getReleaseRun(id);
    if (!existing) return undefined;
    const next = applyReleaseRunUpdate(existing, updates);

    this.run(`
      UPDATE release_runs
      SET repo = ?, base_branch = ?, trigger_pr_number = ?, trigger_pr_title = ?, trigger_pr_url = ?,
          trigger_merge_sha = ?, trigger_merged_at = ?, status = ?, decision_reason = ?,
          recommended_bump = ?, proposed_version = ?, release_title = ?, release_notes = ?,
          included_prs_json = ?, target_sha = ?, github_release_id = ?, github_release_url = ?,
          error = ?, created_at = ?, updated_at = ?, completed_at = ?
      WHERE id = ?
    `,
      next.repo,
      next.baseBranch,
      next.triggerPrNumber,
      next.triggerPrTitle,
      next.triggerPrUrl,
      next.triggerMergeSha,
      next.triggerMergedAt,
      next.status,
      next.decisionReason,
      next.recommendedBump,
      next.proposedVersion,
      next.releaseTitle,
      next.releaseNotes,
      JSON.stringify(next.includedPrs),
      next.targetSha,
      next.githubReleaseId,
      next.githubReleaseUrl,
      next.error,
      next.createdAt,
      next.updatedAt,
      next.completedAt,
      id,
    );
    return next;
  }

  close(): void {
    this.db.close();
  }

  getRootDir(): string {
    return this.rootDir;
  }
}
