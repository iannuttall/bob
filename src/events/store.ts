import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BOB_ID = "bob"; // Single global bob

export type EventRecord = {
  id: number;
  bobId: string;
  chatId: number;
  threadId: number | null;
  kind: string;
  payload: unknown;
  createdAt: string;
  claimedAt: string | null;
  processedAt: string | null;
};

export type EventInput = {
  chatId: number;
  threadId?: number | null;
  kind: string;
  payload?: unknown;
  createdAt?: string;
};

export type ClaimResult = {
  claimToken: string;
  events: EventRecord[];
};

export type EventStore = {
  dbPath: string;
  addEvent: (input: EventInput) => EventRecord;
  listEvents: (options?: { includeProcessed?: boolean }) => EventRecord[];
  countPending: (options?: { now?: Date }) => number;
  claimEvents: (options?: { limit?: number; now?: Date; staleAfterMs?: number }) => ClaimResult;
  ackEvents: (claimToken: string, processedAt?: string) => number;
  releaseClaim: (claimToken: string) => number;
  pruneProcessedOlderThanDays: (days: number) => number;
  close: () => void;
};

const DEFAULT_STALE_MS = 30 * 60_000;

export function createEventStore(params: { dataRoot: string }): EventStore {
  const dbPath = path.join(params.dataRoot, "events.db");
  mkdirSync(params.dataRoot, { recursive: true });
  const db = new Database(dbPath);
  ensureSchema(db);

  const insert = db.prepare(
    `INSERT INTO events (bob_id, chat_id, thread_id, kind, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const list = db.prepare(
    `SELECT id, bob_id as bobId, chat_id as chatId, thread_id as threadId,
            kind, payload, created_at as createdAt, claimed_at as claimedAt,
            processed_at as processedAt
     FROM events
     WHERE bob_id = ?
       AND (? = 1 OR processed_at IS NULL)
     ORDER BY created_at ASC`,
  );
  const countPending = db.prepare(
    `SELECT COUNT(*) as count
     FROM events
     WHERE bob_id = ?
       AND processed_at IS NULL
       AND (claimed_at IS NULL OR claimed_at <= ?)`,
  );
  const claim = db.prepare(
    `UPDATE events
     SET claimed_at = ?, claim_token = ?
     WHERE id IN (
       SELECT id
       FROM events
       WHERE bob_id = ?
         AND processed_at IS NULL
         AND (claimed_at IS NULL OR claimed_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?
     )`,
  );
  const selectClaimed = db.prepare(
    `SELECT id, bob_id as bobId, chat_id as chatId, thread_id as threadId,
            kind, payload, created_at as createdAt, claimed_at as claimedAt,
            processed_at as processedAt
     FROM events
     WHERE bob_id = ? AND claim_token = ?
     ORDER BY created_at ASC`,
  );
  const ack = db.prepare(
    `UPDATE events
     SET processed_at = ?
     WHERE bob_id = ? AND claim_token = ?`,
  );
  const release = db.prepare(
    `UPDATE events
     SET claimed_at = NULL, claim_token = NULL
     WHERE bob_id = ? AND claim_token = ?`,
  );
  const pruneProcessed = db.prepare(
    `DELETE FROM events
     WHERE bob_id = ?
       AND processed_at IS NOT NULL
       AND processed_at < ?`,
  );

  return {
    dbPath,
    addEvent: (input) => {
      const now = input.createdAt ?? new Date().toISOString();
      const payloadRaw = serializePayload(input.payload);
      const threadId = input.threadId ?? null;
      const result = insert.run(BOB_ID, input.chatId, threadId, input.kind, payloadRaw, now);
      return {
        id: Number(result.lastInsertRowid),
        bobId: BOB_ID,
        chatId: input.chatId,
        threadId,
        kind: input.kind,
        payload: deserializePayload(payloadRaw),
        createdAt: now,
        claimedAt: null,
        processedAt: null,
      };
    },
    listEvents: (options) => {
      const rows = list.all(BOB_ID, options?.includeProcessed ? 1 : 0) as EventRecord[];
      return rows.map((row) => ({
        ...row,
        payload: deserializePayload(String((row as { payload: unknown }).payload)),
      }));
    },
    countPending: (options) => {
      const now = options?.now ?? new Date();
      const staleBefore = new Date(now.getTime() - DEFAULT_STALE_MS).toISOString();
      const row = countPending.get(BOB_ID, staleBefore) as { count: number } | undefined;
      return row?.count ?? 0;
    },
    claimEvents: (options) => {
      const now = options?.now ?? new Date();
      const staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_MS;
      const staleBefore = new Date(now.getTime() - staleAfterMs).toISOString();
      const claimToken = randomUUID();
      const limit = options?.limit ?? 20;
      const claimed = db.transaction(() => {
        claim.run(now.toISOString(), claimToken, BOB_ID, staleBefore, limit);
        const rows = selectClaimed.all(BOB_ID, claimToken) as EventRecord[];
        return rows.map((row) => ({
          ...row,
          payload: deserializePayload(String((row as { payload: unknown }).payload)),
        }));
      })();
      return { claimToken, events: claimed };
    },
    ackEvents: (claimToken, processedAt) => {
      const timestamp = processedAt ?? new Date().toISOString();
      const result = ack.run(timestamp, BOB_ID, claimToken);
      return Number(result.changes ?? 0);
    },
    releaseClaim: (claimToken) => {
      const result = release.run(BOB_ID, claimToken);
      return Number(result.changes ?? 0);
    },
    pruneProcessedOlderThanDays: (days) => {
      if (!Number.isFinite(days) || days <= 0) {
        return 0;
      }
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const result = pruneProcessed.run(BOB_ID, cutoff) as { changes?: number };
      return Number(result.changes ?? 0);
    },
    close: () => {
      db.close();
    },
  };
}

function serializePayload(payload: unknown): string {
  if (payload === undefined) return "{}";
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) return "{}";
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed);
    } catch {
      return JSON.stringify({ text: trimmed });
    }
  }
  try {
    return JSON.stringify(payload ?? {});
  } catch {
    return JSON.stringify({ text: String(payload) });
  }
}

function deserializePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function ensureSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bob_id TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      thread_id INTEGER,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      processed_at TEXT,
      claim_token TEXT
    );
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_events_pending ON events (bob_id, processed_at, claimed_at)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_claim ON events (bob_id, claim_token)");
}
