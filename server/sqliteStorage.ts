import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import { feedbackStatusEnum } from "@shared/schema";
import type { Config, FeedbackItem, LogEntry, PR, PRQuestion } from "@shared/schema";
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
  trusted_reviewers_json: string;
  ignored_bots_json: string;
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

export class SqliteStorage implements IStorage {
  private readonly db: DatabaseSync;
  private readonly rootDir: string;
  private readonly logRootDir: string;

  constructor(rootDirOverride?: string) {
    const paths = getCodeFactoryPaths(rootDirOverride);
    mkdirSync(paths.rootDir, { recursive: true });
    mkdirSync(paths.logRootDir, { recursive: true });

    this.rootDir = paths.rootDir;
    this.logRootDir = paths.logRootDir;
    this.db = new DatabaseSync(paths.stateDbPath);
    this.db.exec("PRAGMA foreign_keys = ON");

    this.bootstrap();
  }

  private bootstrap(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        github_token TEXT NOT NULL,
        coding_agent TEXT NOT NULL,
        model TEXT NOT NULL,
        max_turns INTEGER NOT NULL,
        batch_window_ms INTEGER NOT NULL,
        poll_interval_ms INTEGER NOT NULL,
        max_changes_per_run INTEGER NOT NULL,
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

      CREATE INDEX IF NOT EXISTS idx_feedback_items_pr_id ON feedback_items(pr_id);
      CREATE INDEX IF NOT EXISTS idx_logs_pr_id_timestamp ON logs(pr_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_pr_questions_pr_id ON pr_questions(pr_id);
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

    const configExists = this.db.prepare("SELECT 1 AS present FROM config WHERE id = 1").get() as { present: number } | undefined;
    if (!configExists) {
      this.writeConfig(DEFAULT_CONFIG);
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) {
      return;
    }

    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private parseConfigRow(row: ConfigRow, watchedRepos: string[]): Config {
    return {
      githubToken: row.github_token,
      codingAgent: row.coding_agent,
      model: row.model,
      maxTurns: row.max_turns,
      batchWindowMs: row.batch_window_ms,
      pollIntervalMs: row.poll_interval_ms,
      maxChangesPerRun: row.max_changes_per_run,
      watchedRepos,
      trustedReviewers: JSON.parse(row.trusted_reviewers_json),
      ignoredBots: JSON.parse(row.ignored_bots_json),
    };
  }

  private writeConfig(config: Config): void {
    this.db.prepare(`
      INSERT INTO config (
        id,
        github_token,
        coding_agent,
        model,
        max_turns,
        batch_window_ms,
        poll_interval_ms,
        max_changes_per_run,
        trusted_reviewers_json,
        ignored_bots_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        github_token = excluded.github_token,
        coding_agent = excluded.coding_agent,
        model = excluded.model,
        max_turns = excluded.max_turns,
        batch_window_ms = excluded.batch_window_ms,
        poll_interval_ms = excluded.poll_interval_ms,
        max_changes_per_run = excluded.max_changes_per_run,
        trusted_reviewers_json = excluded.trusted_reviewers_json,
        ignored_bots_json = excluded.ignored_bots_json
    `).run(
      1,
      config.githubToken,
      config.codingAgent,
      config.model,
      config.maxTurns,
      config.batchWindowMs,
      config.pollIntervalMs,
      config.maxChangesPerRun,
      JSON.stringify(config.trustedReviewers),
      JSON.stringify(config.ignoredBots),
    );

    this.db.exec("DELETE FROM watched_repos");
    const insertWatchedRepo = this.db.prepare("INSERT INTO watched_repos (repo) VALUES (?)");
    for (const repo of config.watchedRepos) {
      insertWatchedRepo.run(repo);
    }
  }

  private getWatchedRepos(): string[] {
    const rows = this.db.prepare("SELECT repo FROM watched_repos ORDER BY repo ASC").all() as Array<{ repo: string }>;
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
      addedAt: row.added_at,
    };
  }

  private getFeedbackItemsForPRIds(prIds: string[]): Map<string, FeedbackItem[]> {
    const itemsByPrId = new Map<string, FeedbackItem[]>();
    if (prIds.length === 0) {
      return itemsByPrId;
    }

    const placeholders = prIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT id, pr_id, author, body, body_html, reply_kind, source_id, source_node_id, source_url,
             thread_id, thread_resolved, audit_token, file, line, type, created_at, decision,
             decision_reason, action, status, status_reason
      FROM feedback_items
      WHERE pr_id IN (${placeholders})
      ORDER BY created_at ASC
    `).all(...prIds) as FeedbackItemRow[];

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
    this.db.prepare("DELETE FROM feedback_items WHERE pr_id = ?").run(prId);
    const insert = this.db.prepare(`
      INSERT INTO feedback_items (
        id, pr_id, author, body, body_html, reply_kind, source_id, source_node_id, source_url,
        thread_id, thread_resolved, audit_token, file, line, type, created_at, decision, decision_reason, action,
        status, status_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of items) {
      insert.run(
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
    const rows = this.db.prepare(`
      SELECT id, number, title, repo, branch, author, url, status, accepted, rejected, flagged,
             tests_passed, lint_passed, last_checked, added_at
      FROM prs
      WHERE status != 'archived'
      ORDER BY datetime(added_at) DESC
    `).all() as PRRow[];

    const itemsByPrId = this.getFeedbackItemsForPRIds(rows.map((row) => row.id));

    return rows.map((row) => this.parsePRRow(row, itemsByPrId.get(row.id) || []));
  }

  async getArchivedPRs(): Promise<PR[]> {
    const rows = this.db.prepare(`
      SELECT id, number, title, repo, branch, author, url, status, accepted, rejected, flagged,
             tests_passed, lint_passed, last_checked, added_at
      FROM prs
      WHERE status = 'archived'
      ORDER BY datetime(added_at) DESC
    `).all() as PRRow[];

    const itemsByPrId = this.getFeedbackItemsForPRIds(rows.map((row) => row.id));

    return rows.map((row) => this.parsePRRow(row, itemsByPrId.get(row.id) || []));
  }

  async getPR(id: string): Promise<PR | undefined> {
    const row = this.db.prepare(`
      SELECT id, number, title, repo, branch, author, url, status, accepted, rejected, flagged,
             tests_passed, lint_passed, last_checked, added_at
      FROM prs
      WHERE id = ?
    `).get(id) as PRRow | undefined;

    if (!row) {
      return undefined;
    }

    const itemsByPrId = this.getFeedbackItemsForPRIds([id]);
    return this.parsePRRow(row, itemsByPrId.get(id) || []);
  }

  async getPRByRepoAndNumber(repo: string, number: number): Promise<PR | undefined> {
    const row = this.db.prepare(`
      SELECT id, number, title, repo, branch, author, url, status, accepted, rejected, flagged,
             tests_passed, lint_passed, last_checked, added_at
      FROM prs
      WHERE repo = ? AND number = ?
    `).get(repo, number) as PRRow | undefined;

    if (!row) {
      return undefined;
    }

    const itemsByPrId = this.getFeedbackItemsForPRIds([row.id]);
    return this.parsePRRow(row, itemsByPrId.get(row.id) || []);
  }

  async addPR(pr: Omit<PR, "id" | "addedAt">): Promise<PR> {
    const id = randomUUID();
    const full: PR = {
      ...pr,
      id,
      addedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO prs (
        id, number, title, repo, branch, author, url, status, accepted, rejected, flagged,
        tests_passed, lint_passed, last_checked, added_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
      full.addedAt,
    );

    this.replaceFeedbackItems(full.id, full.feedbackItems);
    return full;
  }

  async updatePR(id: string, updates: Partial<PR>): Promise<PR | undefined> {
    const existing = await this.getPR(id);
    if (!existing) {
      return undefined;
    }

    const updated: PR = {
      ...existing,
      ...updates,
      id: existing.id,
      addedAt: existing.addedAt,
    };

    this.db.prepare(`
      UPDATE prs
      SET number = ?, title = ?, repo = ?, branch = ?, author = ?, url = ?, status = ?,
          accepted = ?, rejected = ?, flagged = ?, tests_passed = ?, lint_passed = ?, last_checked = ?
      WHERE id = ?
    `).run(
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
      id,
    );

    this.replaceFeedbackItems(id, updated.feedbackItems);
    return updated;
  }

  async removePR(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM prs WHERE id = ?").run(id);
    return result.changes > 0;
  }

  async getQuestions(prId: string): Promise<PRQuestion[]> {
    const rows = this.db.prepare(`
      SELECT id, pr_id, question, answer, status, error, created_at, answered_at
      FROM pr_questions
      WHERE pr_id = ?
      ORDER BY datetime(created_at) ASC
    `).all(prId) as QuestionRow[];

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
    const entry: PRQuestion = {
      id: randomUUID(),
      prId,
      question,
      answer: null,
      status: "pending",
      error: null,
      createdAt: new Date().toISOString(),
      answeredAt: null,
    };

    this.db.prepare(`
      INSERT INTO pr_questions (id, pr_id, question, answer, status, error, created_at, answered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entry.id, entry.prId, entry.question, entry.answer, entry.status, entry.error, entry.createdAt, entry.answeredAt);

    return entry;
  }

  async updateQuestion(id: string, updates: Partial<PRQuestion>): Promise<PRQuestion | undefined> {
    const row = this.db.prepare(`
      SELECT id, pr_id, question, answer, status, error, created_at, answered_at
      FROM pr_questions WHERE id = ?
    `).get(id) as QuestionRow | undefined;

    if (!row) return undefined;

    const current: PRQuestion = {
      id: row.id, prId: row.pr_id, question: row.question, answer: row.answer,
      status: row.status, error: row.error, createdAt: row.created_at, answeredAt: row.answered_at,
    };

    const updated = { ...current, ...updates, id: current.id, prId: current.prId, createdAt: current.createdAt };

    this.db.prepare(`
      UPDATE pr_questions SET answer = ?, status = ?, error = ?, answered_at = ? WHERE id = ?
    `).run(updated.answer, updated.status, updated.error, updated.answeredAt, updated.id);

    return updated;
  }

  async getLogs(prId?: string): Promise<LogEntry[]> {
    const rows = prId
      ? this.db.prepare(`
          SELECT id, pr_id, run_id, timestamp, level, phase, message, metadata_json
          FROM logs
          WHERE pr_id = ?
          ORDER BY datetime(timestamp) ASC
          LIMIT 500
        `).all(prId) as LogRow[]
      : this.db.prepare(`
          SELECT id, pr_id, run_id, timestamp, level, phase, message, metadata_json
          FROM logs
          ORDER BY datetime(timestamp) ASC
          LIMIT 500
        `).all() as LogRow[];

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
    const entry: LogEntry = {
      id: randomUUID(),
      prId,
      runId: details?.runId ?? null,
      timestamp: new Date().toISOString(),
      level,
      phase: details?.phase ?? null,
      message,
      metadata: details?.metadata ?? null,
    };

    this.db.prepare(`
      INSERT INTO logs (id, pr_id, run_id, timestamp, level, phase, message, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.prId,
      entry.runId,
      entry.timestamp,
      entry.level,
      entry.phase,
      entry.message,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    );

    const pr = await this.getPR(prId);
    if (pr) {
      appendLogFile(this.logRootDir, pr, entry);
    }

    return entry;
  }

  async clearLogs(prId?: string): Promise<void> {
    if (prId) {
      this.db.prepare("DELETE FROM logs WHERE pr_id = ?").run(prId);
      return;
    }

    this.db.exec("DELETE FROM logs");
  }

  async getConfig(): Promise<Config> {
    const row = this.db.prepare(`
      SELECT github_token, coding_agent, model, max_turns, batch_window_ms,
             poll_interval_ms, max_changes_per_run, trusted_reviewers_json, ignored_bots_json
      FROM config
      WHERE id = 1
    `).get() as ConfigRow;

    return this.parseConfigRow(row, this.getWatchedRepos());
  }

  async updateConfig(updates: Partial<Config>): Promise<Config> {
    const current = await this.getConfig();
    const next: Config = {
      ...current,
      ...updates,
      watchedRepos: updates.watchedRepos ? [...updates.watchedRepos] : current.watchedRepos,
      trustedReviewers: updates.trustedReviewers ? [...updates.trustedReviewers] : current.trustedReviewers,
      ignoredBots: updates.ignoredBots ? [...updates.ignoredBots] : current.ignoredBots,
    };

    this.writeConfig(next);
    return next;
  }

  close(): void {
    this.db.close();
  }

  getRootDir(): string {
    return this.rootDir;
  }
}
