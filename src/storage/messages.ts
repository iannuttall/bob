import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";

const BOB_ID = "bob"; // Single global bob

export type MessageRole = "user" | "assistant";

export type MessageLogInput = {
  chatId: number;
  threadId?: number;
  messageId?: number;
  role: MessageRole;
  text: string;
  createdAt?: string;
};

export type MessageLogEntry = {
  role: MessageRole;
  text: string;
  createdAt: string;
  messageId?: number | null;
};

export type MessageLogRangeEntry = {
  chatId: number;
  threadId?: number | null;
  role: MessageRole;
  text: string;
  createdAt: string;
  messageId?: number | null;
};

export type MessageLogger = {
  dbPath: string;
  logMessage: (input: MessageLogInput) => boolean;
  getLastConversation: () => { chatId: number; threadId?: number | null } | null;
  getRecentMessages: (params: {
    chatId: number;
    threadId?: number;
    limit: number;
  }) => MessageLogEntry[];
  getMessagesInRange: (params: { start: string; end: string }) => MessageLogRangeEntry[];
  pruneOlderThanDays: (days: number) => number;
  close: () => void;
};

export function createMessageLogger(params: {
  dataRoot: string;
  onError?: (error: Error) => void;
}): MessageLogger {
  const dbPath = path.join(params.dataRoot, "messages.db");
  migrateLegacyMessagesDb(path.join(params.dataRoot, "memory.db"), dbPath);
  const onError =
    params.onError ??
    ((error: Error) => {
      console.error(`Message log error: ${error.message}`);
    });

  try {
    mkdirSync(params.dataRoot, { recursive: true });
    const db = new Database(dbPath);
    ensureSchema(db);
    const insert = db.prepare(
      `INSERT INTO messages (bob_id, chat_id, thread_id, message_id, role, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectRecent = db.prepare(
      `SELECT role, text, created_at as createdAt, message_id as messageId
       FROM messages
       WHERE bob_id = ?
         AND chat_id = ?
         AND ((thread_id IS NULL AND ? IS NULL) OR thread_id = ?)
       ORDER BY created_at DESC
       LIMIT ?`,
    );
    const selectLastConversation = db.prepare(
      `SELECT chat_id as chatId, thread_id as threadId
       FROM messages
       WHERE bob_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    const selectRange = db.prepare(
      `SELECT chat_id as chatId, thread_id as threadId, role, text, created_at as createdAt, message_id as messageId
       FROM messages
       WHERE bob_id = ?
         AND created_at >= ?
         AND created_at < ?
       ORDER BY created_at ASC`,
    );
    const deleteOld = db.prepare(
      `DELETE FROM messages
       WHERE bob_id = ? AND created_at < ?`,
    );

    return {
      dbPath,
      logMessage: (input) => {
        try {
          insert.run(
            BOB_ID,
            input.chatId,
            input.threadId ?? null,
            input.messageId ?? null,
            input.role,
            input.text,
            input.createdAt ?? new Date().toISOString(),
          );
          return true;
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
          return false;
        }
      },
      getLastConversation: () => {
        try {
          const row = selectLastConversation.get(BOB_ID) as
            | { chatId: number; threadId: number | null }
            | undefined;
          if (!row) return null;
          return { chatId: row.chatId, threadId: row.threadId };
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
          return null;
        }
      },
      getRecentMessages: ({ chatId, threadId, limit }) => {
        try {
          const rows = selectRecent.all(
            BOB_ID,
            chatId,
            threadId ?? null,
            threadId ?? null,
            limit,
          ) as MessageLogEntry[];
          return rows.reverse();
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
          return [];
        }
      },
      getMessagesInRange: ({ start, end }) => {
        try {
          const rows = selectRange.all(BOB_ID, start, end) as MessageLogRangeEntry[];
          return rows;
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
          return [];
        }
      },
      pruneOlderThanDays: (days) => {
        if (!Number.isFinite(days) || days <= 0) {
          return 0;
        }
        const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
        const result = deleteOld.run(BOB_ID, cutoff) as { changes?: number };
        return Number(result.changes ?? 0);
      },
      close: () => {
        db.close();
      },
    };
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
    return {
      dbPath,
      logMessage: () => false,
      getLastConversation: () => null,
      getRecentMessages: () => [],
      getMessagesInRange: () => [],
      pruneOlderThanDays: () => 0,
      close: () => {},
    };
  }
}

function ensureSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bob_id TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      thread_id INTEGER,
      message_id INTEGER,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, "messages", "message_id", "INTEGER");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_messages_chat_thread_created ON messages (chat_id, thread_id, created_at)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_bob_id ON messages (bob_id)");
}

function ensureColumn(db: Database, table: string, column: string, definition: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const exists = rows.some((row) => row.name === column);
  if (exists) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrateLegacyMessagesDb(legacyPath: string, targetPath: string) {
  if (existsSync(targetPath) || !existsSync(legacyPath)) {
    return;
  }
  try {
    const legacyDb = new Database(legacyPath);
    const hasMessages = Boolean(
      legacyDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
        .get(),
    );
    const hasMemoryDocs = Boolean(
      legacyDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_documents'")
        .get(),
    );
    legacyDb.close();
    if (hasMessages && !hasMemoryDocs) {
      renameSync(legacyPath, targetPath);
    }
  } catch {
    // best-effort; if it fails we fall back to a fresh messages.db
  }
}
