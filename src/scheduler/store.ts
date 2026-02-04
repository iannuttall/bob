import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ContextMode, JobPayload, JobRecord, JobType, ScheduleKind } from "./types";
import { computeNextRunAt } from "./schedule";

const BOB_ID = "bob"; // Single global bob

export type JobStore = {
  dbPath: string;
  removeJob: (id: number) => boolean;
  addJob: (input: {
    chatId: number;
    threadId?: number | null;
    scheduleKind: ScheduleKind;
    scheduleSpec: string;
    jobType: JobType;
    payload: JobPayload;
    enabled?: boolean;
    contextMode?: ContextMode;
    now?: Date;
  }) => JobRecord;
  listJobs: () => JobRecord[];
  getJobsForChat: (chatId: number) => JobRecord[];
  getDueJobs: (params: { now: Date; limit?: number }) => JobRecord[];
  claimDueJobs: (params: { now: Date; limit?: number }) => JobRecord[];
  getNextRunAt: () => Date | null;
  updateAfterRun: (params: {
    id: number;
    lastRunAt: string;
    nextRunAt: string | null;
    enabled: boolean;
  }) => void;
  close: () => void;
};

export function createJobStore(params: { dataRoot: string }): JobStore {
  const dbPath = path.join(params.dataRoot, "jobs.db");
  mkdirSync(params.dataRoot, { recursive: true });
  const db = new Database(dbPath);
  ensureSchema(db);

  const insert = db.prepare(
    `INSERT INTO jobs (bob_id, chat_id, thread_id, schedule_kind, schedule_spec, job_type, payload, enabled, next_run_at, context_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectAll = db.prepare(
    `SELECT id, bob_id as bobId, chat_id as chatId, thread_id as threadId,
        schedule_kind as scheduleKind, schedule_spec as scheduleSpec,
        job_type as jobType, payload, enabled, next_run_at as nextRunAt, last_run_at as lastRunAt,
        context_mode as contextMode
     FROM jobs WHERE bob_id = ? ORDER BY id ASC`,
  );
  const selectDue = db.prepare(
    `SELECT id, bob_id as bobId, chat_id as chatId, thread_id as threadId,
        schedule_kind as scheduleKind, schedule_spec as scheduleSpec,
        job_type as jobType, payload, enabled, next_run_at as nextRunAt, last_run_at as lastRunAt,
        context_mode as contextMode
     FROM jobs
     WHERE bob_id = ? AND enabled = 1 AND next_run_at <= ?
     ORDER BY next_run_at ASC
     LIMIT ?`,
  );
  const updateRun = db.prepare(
    `UPDATE jobs SET last_run_at = ?, next_run_at = ?, enabled = ? WHERE id = ?`,
  );
  const remove = db.prepare(`DELETE FROM jobs WHERE id = ?`);
  const selectNext = db.prepare(
    `SELECT MIN(next_run_at) as nextRunAt
     FROM jobs WHERE bob_id = ? AND enabled = 1`,
  );
  const selectByChat = db.prepare(
    `SELECT id, bob_id as bobId, chat_id as chatId, thread_id as threadId,
        schedule_kind as scheduleKind, schedule_spec as scheduleSpec,
        job_type as jobType, payload, enabled, next_run_at as nextRunAt, last_run_at as lastRunAt,
        context_mode as contextMode
     FROM jobs WHERE bob_id = ? AND chat_id = ? AND enabled = 1 ORDER BY next_run_at ASC`,
  );

  const claimDueJobs = db.transaction((input: { now: Date; limit?: number }) => {
    const rows = selectDue.all(BOB_ID, input.now.toISOString(), input.limit ?? 10) as Array<{
      id: number;
      bobId: string;
      chatId: number;
      threadId: number | null;
      scheduleKind: ScheduleKind;
      scheduleSpec: string;
      jobType: JobType;
      payload: string;
      enabled: number;
      nextRunAt: string | null;
      lastRunAt: string | null;
      contextMode: string | null;
    }>;
    if (rows.length === 0) {
      return [];
    }
    const atIds = rows.filter((row) => row.scheduleKind === "at").map((row) => row.id);
    if (atIds.length > 0) {
      const placeholders = atIds.map(() => "?").join(", ");
      const stmt = db.prepare(
        `UPDATE jobs SET enabled = 0 WHERE bob_id = ? AND id IN (${placeholders})`,
      );
      stmt.run(BOB_ID, ...atIds);
    }
    const claimed = new Set(atIds);
    return rows.map((row) => ({
      ...row,
      enabled: row.enabled === 1 && !claimed.has(row.id),
      nextRunAt: row.nextRunAt,
      payload: safeParsePayload(row.payload),
      contextMode: (row.contextMode as ContextMode) ?? "session",
    }));
  });

  return {
    dbPath,
    removeJob: (id) => {
      const result = remove.run(id) as { changes: number };
      return result.changes > 0;
    },
    addJob: (input) => {
      const now = input.now ?? new Date();
      const nextRun = computeNextRunAt(input.scheduleKind, input.scheduleSpec, now);
      if (!nextRun) {
        throw new Error("Unable to compute next run time");
      }
      const enabled = input.enabled ?? true;
      const contextMode = input.contextMode ?? "session";
      const payloadText = JSON.stringify(input.payload);
      const result = insert.run(
        BOB_ID,
        input.chatId,
        input.threadId ?? null,
        input.scheduleKind,
        input.scheduleSpec,
        input.jobType,
        payloadText,
        enabled ? 1 : 0,
        nextRun.toISOString(),
        contextMode,
      ) as { lastInsertRowid: number };

      return {
        id: Number(result.lastInsertRowid),
        bobId: BOB_ID,
        chatId: input.chatId,
        threadId: input.threadId ?? null,
        scheduleKind: input.scheduleKind,
        scheduleSpec: input.scheduleSpec,
        jobType: input.jobType,
        payload: input.payload,
        enabled,
        nextRunAt: nextRun.toISOString(),
        lastRunAt: null,
        contextMode,
      };
    },
    getJobsForChat: (chatId: number) => {
      const rows = selectByChat.all(BOB_ID, chatId) as Array<{
        id: number;
        bobId: string;
        chatId: number;
        threadId: number | null;
        scheduleKind: ScheduleKind;
        scheduleSpec: string;
        jobType: JobType;
        payload: string;
        enabled: number;
        nextRunAt: string | null;
        lastRunAt: string | null;
        contextMode: string | null;
      }>;
      return rows.map((row) => ({
        ...row,
        enabled: row.enabled === 1,
        payload: safeParsePayload(row.payload),
        contextMode: (row.contextMode as ContextMode) ?? "session",
      }));
    },
    listJobs: () => {
      const rows = selectAll.all(BOB_ID) as Array<{
        id: number;
        bobId: string;
        chatId: number;
        threadId: number | null;
        scheduleKind: ScheduleKind;
        scheduleSpec: string;
        jobType: JobType;
        payload: string;
        enabled: number;
        nextRunAt: string | null;
        lastRunAt: string | null;
        contextMode: string | null;
      }>;
      return rows.map((row) => ({
        ...row,
        enabled: row.enabled === 1,
        payload: safeParsePayload(row.payload),
        contextMode: (row.contextMode as ContextMode) ?? "session",
      }));
    },
    getDueJobs: ({ now, limit }) => {
      const rows = selectDue.all(BOB_ID, now.toISOString(), limit ?? 10) as Array<{
        id: number;
        bobId: string;
        chatId: number;
        threadId: number | null;
        scheduleKind: ScheduleKind;
        scheduleSpec: string;
        jobType: JobType;
        payload: string;
        enabled: number;
        nextRunAt: string | null;
        lastRunAt: string | null;
        contextMode: string | null;
      }>;
      return rows.map((row) => ({
        ...row,
        enabled: row.enabled === 1,
        payload: safeParsePayload(row.payload),
        contextMode: (row.contextMode as ContextMode) ?? "session",
      }));
    },
    claimDueJobs: ({ now, limit }) => claimDueJobs({ now, limit }),
    getNextRunAt: () => {
      const row = selectNext.get(BOB_ID) as { nextRunAt?: string | null } | undefined;
      if (!row?.nextRunAt) {
        return null;
      }
      const next = new Date(row.nextRunAt);
      if (Number.isNaN(next.getTime())) {
        return null;
      }
      return next;
    },
    updateAfterRun: ({ id, lastRunAt, nextRunAt, enabled }) => {
      updateRun.run(lastRunAt, nextRunAt, enabled ? 1 : 0, id);
    },
    close: () => {
      db.close();
    },
  };
}

function safeParsePayload(raw: string): JobPayload {
  try {
    return JSON.parse(raw) as JobPayload;
  } catch {
    return { text: raw } as JobPayload;
  }
}

function ensureSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bob_id TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      thread_id INTEGER,
      schedule_kind TEXT NOT NULL,
      schedule_spec TEXT NOT NULL,
      job_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT NOT NULL,
      last_run_at TEXT,
      context_mode TEXT DEFAULT 'session'
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (bob_id, enabled, next_run_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_bob_id ON jobs (bob_id)");
  // Migration: add context_mode column if missing
  ensureColumn(db, "jobs", "context_mode", "TEXT DEFAULT 'session'");
}

function ensureColumn(db: Database, table: string, column: string, definition: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const exists = rows.some((row) => row.name === column);
  if (exists) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
