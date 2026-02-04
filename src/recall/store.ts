/**
 * Recall store - SQLite with FTS5 + vector embeddings.
 */

import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Chunk } from "./chunk";

export type RecallStore = {
  db: Database;
  dbPath: string;
  addChunk: (chunk: Chunk, embedding?: Float32Array) => number;
  addChunks: (chunks: Chunk[]) => number[];
  searchFts: (query: string, limit?: number) => RecallHit[];
  searchVector: (embedding: Float32Array, limit?: number) => RecallHit[];
  getSourceFingerprint: (source: string) => string | null;
  setSourceFingerprint: (source: string, fingerprint: string) => void;
  deleteBySource: (source: string) => void;
  getUnembedded: (limit?: number) => Array<{ id: number; content: string }>;
  setEmbedding: (id: number, embedding: Float32Array) => void;
  getChunk: (id: number) => RecallHit | null;
  getBySource: (source: string) => RecallHit[];
  clear: () => void;
  close: () => void;
};

export type RecallHit = {
  id: number;
  source: string;
  title: string;
  breadcrumbs: string[];
  content: string;
  preview: string;
  lineStart: number;
  lineEnd: number;
  tokenCount: number;
  score: number;
  createdAt: string;
};

function setSQLiteFromBrewPrefixEnv(): void {
  const candidates: string[] = [];

  if (process.platform === "darwin") {
    const brewPrefix = Bun.env.BREW_PREFIX || Bun.env.HOMEBREW_PREFIX;
    if (brewPrefix) {
      candidates.push(`${brewPrefix}/opt/sqlite/lib/libsqlite3.dylib`);
      candidates.push(`${brewPrefix}/lib/libsqlite3.dylib`);
    } else {
      candidates.push("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
      candidates.push("/usr/local/opt/sqlite/lib/libsqlite3.dylib");
    }
  }

  for (const candidate of candidates) {
    try {
      if (Bun.file(candidate).size > 0) {
        Database.setCustomSQLite(candidate);
        return;
      }
    } catch {
      // ignore
    }
  }
}

setSQLiteFromBrewPrefixEnv();

export function createRecallStore(dataRoot: string): RecallStore {
  const dbPath = path.join(dataRoot, "bob.db");

  if (!existsSync(dataRoot)) {
    mkdirSync(dataRoot, { recursive: true });
  }

  const db = new Database(dbPath);
  const vecEnabled = initDatabase(db);
  ensureSchema(db);

  return {
    db,
    dbPath,

    addChunk(chunk: Chunk, embedding?: Float32Array): number {
      const now = new Date().toISOString();
      const stmt = db.prepare(`
        INSERT INTO chunks (source, title, breadcrumbs, content, preview, line_start, line_end, token_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        chunk.source,
        chunk.title,
        JSON.stringify(chunk.breadcrumbs),
        chunk.content,
        chunk.preview,
        chunk.lineStart,
        chunk.lineEnd,
        chunk.tokenCount,
        now,
      );
      const id = Number(result.lastInsertRowid);

      if (embedding) {
        persistEmbedding(db, id, embedding, vecEnabled);
      }

      return id;
    },

    addChunks(chunks: Chunk[]): number[] {
      const ids: number[] = [];
      const now = new Date().toISOString();
      const stmt = db.prepare(`
        INSERT INTO chunks (source, title, breadcrumbs, content, preview, line_start, line_end, token_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      db.exec("BEGIN");
      try {
        for (const chunk of chunks) {
          const result = stmt.run(
            chunk.source,
            chunk.title,
            JSON.stringify(chunk.breadcrumbs),
            chunk.content,
            chunk.preview,
            chunk.lineStart,
            chunk.lineEnd,
            chunk.tokenCount,
            now,
          );
          ids.push(Number(result.lastInsertRowid));
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }

      return ids;
    },

    searchFts(query: string, limit = 10): RecallHit[] {
      const stmt = db.prepare(`
        SELECT c.id, c.source, c.title, c.breadcrumbs, c.content, c.preview,
               c.line_start, c.line_end, c.token_count, c.created_at,
               bm25(chunks_fts) as score
        FROM chunks_fts
        JOIN chunks c ON chunks_fts.rowid = c.id
        WHERE chunks_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `);
      const rows = stmt.all(query, limit) as Array<{
        id: number;
        source: string;
        title: string;
        breadcrumbs: string;
        content: string;
        preview: string;
        line_start: number;
        line_end: number;
        token_count: number;
        created_at: string;
        score: number;
      }>;

      return rows.map((row) => ({
        id: row.id,
        source: row.source,
        title: row.title,
        breadcrumbs: parseBreadcrumbs(row.breadcrumbs),
        content: row.content,
        preview: row.preview,
        lineStart: row.line_start,
        lineEnd: row.line_end,
        tokenCount: row.token_count,
        createdAt: row.created_at,
        score: -row.score, // BM25 returns negative scores, lower is better
      }));
    },

    searchVector(queryEmbedding: Float32Array, limit = 10): RecallHit[] {
      if (vecEnabled) {
        ensureVecTable(db, queryEmbedding.length);
        backfillVectorsIfNeeded(db);
        const vecHits = searchVecTable(db, queryEmbedding, limit);
        if (vecHits.length > 0) {
          return vecHits;
        }
      }

      // Fallback to in-process cosine search when vec index is unavailable.
      return searchVectorFallback(db, queryEmbedding, limit);
    },

    getSourceFingerprint(source: string): string | null {
      const row = db
        .prepare("SELECT fingerprint FROM sources WHERE source = ?")
        .get(source) as { fingerprint?: string } | undefined;
      return row?.fingerprint ?? null;
    },

    setSourceFingerprint(source: string, fingerprint: string): void {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT OR REPLACE INTO sources (source, fingerprint, updated_at) VALUES (?, ?, ?)",
      ).run(source, fingerprint, now);
    },

    deleteBySource(source: string): void {
      const ids = db.prepare("SELECT id FROM chunks WHERE source = ?").all(source) as Array<{
        id: number;
      }>;
      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(", ");
        const values = ids.map((row) => row.id);
        db.prepare(`DELETE FROM embeddings WHERE chunk_id IN (${placeholders})`).run(...values);
        if (hasVecTable(db)) {
          db.prepare(`DELETE FROM vectors_vec WHERE chunk_id IN (${placeholders})`).run(...values);
        }
      }
      db.prepare("DELETE FROM chunks WHERE source = ?").run(source);
      db.prepare("DELETE FROM sources WHERE source = ?").run(source);
    },

    getUnembedded(limit = 100): Array<{ id: number; content: string }> {
      const stmt = db.prepare(`
        SELECT c.id, c.content
        FROM chunks c
        LEFT JOIN embeddings e ON c.id = e.chunk_id
        WHERE e.chunk_id IS NULL
        LIMIT ?
      `);
      return stmt.all(limit) as Array<{ id: number; content: string }>;
    },

    setEmbedding(id: number, embedding: Float32Array): void {
      persistEmbedding(db, id, embedding, vecEnabled);
    },

    getChunk(id: number): RecallHit | null {
      const stmt = db.prepare(`
        SELECT id, source, title, breadcrumbs, content, preview, line_start, line_end, token_count, created_at
        FROM chunks WHERE id = ?
      `);
      const row = stmt.get(id) as {
        id: number;
        source: string;
        title: string;
        breadcrumbs: string;
        content: string;
        preview: string;
        line_start: number;
        line_end: number;
        token_count: number;
        created_at: string;
      } | undefined;

      if (!row) return null;

      return {
        id: row.id,
        source: row.source,
        title: row.title,
        breadcrumbs: parseBreadcrumbs(row.breadcrumbs),
        content: row.content,
        preview: row.preview,
        lineStart: row.line_start,
        lineEnd: row.line_end,
        tokenCount: row.token_count,
        createdAt: row.created_at,
        score: 0,
      };
    },

    getBySource(source: string): RecallHit[] {
      const stmt = db.prepare(`
        SELECT id, source, title, breadcrumbs, content, preview, line_start, line_end, token_count, created_at
        FROM chunks WHERE source = ? OR source LIKE ?
        ORDER BY line_start
      `);
      const rows = stmt.all(source, `${source}%`) as Array<{
        id: number;
        source: string;
        title: string;
        breadcrumbs: string;
        content: string;
        preview: string;
        line_start: number;
        line_end: number;
        token_count: number;
        created_at: string;
      }>;

      return rows.map((row) => ({
        id: row.id,
        source: row.source,
        title: row.title,
        breadcrumbs: parseBreadcrumbs(row.breadcrumbs),
        content: row.content,
        preview: row.preview,
        lineStart: row.line_start,
        lineEnd: row.line_end,
        tokenCount: row.token_count,
        createdAt: row.created_at,
        score: 0,
      }));
    },

    clear() {
      db.exec("DELETE FROM embeddings");
      db.exec("DELETE FROM chunks");
      db.exec("DELETE FROM sources");
    },

    close() {
      db.close();
    },
  };
}

function parseBreadcrumbs(json: string | null): string[] {
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      breadcrumbs TEXT,
      content TEXT NOT NULL,
      preview TEXT,
      line_start INTEGER,
      line_end INTEGER,
      token_count INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks (source);
    CREATE INDEX IF NOT EXISTS idx_chunks_created ON chunks (created_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      source,
      title,
      content,
      content=chunks,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts (rowid, source, title, content)
      VALUES (NEW.id, NEW.source, NEW.title, NEW.content);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts (chunks_fts, rowid, source, title, content)
      VALUES ('delete', OLD.id, OLD.source, OLD.title, OLD.content);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts (chunks_fts, rowid, source, title, content)
      VALUES ('delete', OLD.id, OLD.source, OLD.title, OLD.content);
      INSERT INTO chunks_fts (rowid, source, title, content)
      VALUES (NEW.id, NEW.source, NEW.title, NEW.content);
    END;

    CREATE TABLE IF NOT EXISTS embeddings (
      chunk_id INTEGER PRIMARY KEY,
      vector BLOB NOT NULL,
      FOREIGN KEY (chunk_id) REFERENCES chunks (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sources (
      source TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Add breadcrumbs column if it doesn't exist (migration)
  try {
    db.exec("ALTER TABLE chunks ADD COLUMN breadcrumbs TEXT");
  } catch {
    // Column already exists
  }
}

function initDatabase(db: Database): boolean {
  try {
    sqliteVec.load(db);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("does not support dynamic extension loading")) {
      console.warn(
        "sqlite-vec extension could not be loaded. Install Homebrew SQLite or set BREW_PREFIX/HOMEBREW_PREFIX.",
      );
      return false;
    }
    console.warn(`sqlite-vec extension could not be loaded: ${message}`);
    return false;
  }
}

function ensureVecTable(db: Database, dimensions: number): void {
  const tableInfo = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`)
    .get() as { sql: string } | null;
  if (tableInfo) {
    const match = tableInfo.sql.match(/float\[(\d+)\]/);
    const hasChunkId = tableInfo.sql.includes("chunk_id");
    const hasCosine = tableInfo.sql.includes("distance_metric=cosine");
    const existingDims = match?.[1] ? Number.parseInt(match[1], 10) : null;
    if (existingDims === dimensions && hasChunkId && hasCosine) return;
    db.exec("DROP TABLE IF EXISTS vectors_vec");
  }
  db.exec(
    `CREATE VIRTUAL TABLE vectors_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`,
  );
}

function hasVecTable(db: Database): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`)
    .get() as { name?: string } | undefined;
  return Boolean(row?.name);
}

function persistEmbedding(db: Database, id: number, embedding: Float32Array, vecEnabled: boolean): void {
  db.prepare("INSERT OR REPLACE INTO embeddings (chunk_id, vector) VALUES (?, ?)").run(
    id,
    Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
  );
  if (!vecEnabled) return;
  ensureVecTable(db, embedding.length);
  db.prepare("INSERT OR REPLACE INTO vectors_vec (chunk_id, embedding) VALUES (?, ?)").run(
    id,
    embedding,
  );
}

function backfillVectorsIfNeeded(db: Database): void {
  if (!hasVecTable(db)) return;
  const embeddingCount = db
    .prepare("SELECT COUNT(*) as c FROM embeddings")
    .get() as { c: number } | undefined;
  const vecCount = db
    .prepare("SELECT COUNT(*) as c FROM vectors_vec")
    .get() as { c: number } | undefined;
  if (!embeddingCount?.c || vecCount?.c === embeddingCount.c) {
    return;
  }
  const rows = db.prepare(`
    SELECT e.chunk_id as chunkId, e.vector as vector
    FROM embeddings e
  `).all() as Array<{ chunkId: number; vector: Buffer }>;
  if (rows.length === 0) return;
  const insert = db.prepare("INSERT OR REPLACE INTO vectors_vec (chunk_id, embedding) VALUES (?, ?)");
  for (const row of rows) {
    const vector = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.length / 4);
    insert.run(row.chunkId, vector);
  }
}

function searchVecTable(db: Database, embedding: Float32Array, limit: number): RecallHit[] {
  if (!hasVecTable(db)) return [];
  // sqlite-vec virtual tables hang when JOINed in the same query; do a two-step lookup.
  const vecRows = db.prepare(`
    SELECT chunk_id, distance
    FROM vectors_vec
    WHERE embedding MATCH ? AND k = ?
  `).all(embedding, limit * 3) as Array<{ chunk_id: number; distance: number }>;

  if (vecRows.length === 0) return [];
  const ids = vecRows.map((row) => row.chunk_id);
  const distanceMap = new Map(vecRows.map((row) => [row.chunk_id, row.distance]));
  const placeholders = ids.map(() => "?").join(", ");
  const chunks = db.prepare(`
    SELECT id, source, title, breadcrumbs, content, preview,
           line_start, line_end, token_count, created_at
    FROM chunks
    WHERE id IN (${placeholders})
  `).all(...ids) as Array<{
    id: number;
    source: string;
    title: string;
    breadcrumbs: string;
    content: string;
    preview: string;
    line_start: number;
    line_end: number;
    token_count: number;
    created_at: string;
  }>;

  const results = chunks.map((row) => {
    const distance = distanceMap.get(row.id) ?? 1;
    return {
      id: row.id,
      source: row.source,
      title: row.title,
      breadcrumbs: parseBreadcrumbs(row.breadcrumbs),
      content: row.content,
      preview: row.preview,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      tokenCount: row.token_count,
      createdAt: row.created_at,
      score: 1 - distance,
    };
  });

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

function searchVectorFallback(db: Database, queryEmbedding: Float32Array, limit: number): RecallHit[] {
  const stmt = db.prepare(`
    SELECT c.id, c.source, c.title, c.breadcrumbs, c.content, c.preview,
           c.line_start, c.line_end, c.token_count, c.created_at,
           e.vector
    FROM embeddings e
    JOIN chunks c ON e.chunk_id = c.id
  `);
  const rows = stmt.all() as Array<{
    id: number;
    source: string;
    title: string;
    breadcrumbs: string;
    content: string;
    preview: string;
    line_start: number;
    line_end: number;
    token_count: number;
    created_at: string;
    vector: Buffer;
  }>;

  const results: RecallHit[] = [];
  for (const row of rows) {
    const vector = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.length / 4);
    const score = cosineSim(queryEmbedding, vector);
    results.push({
      id: row.id,
      source: row.source,
      title: row.title,
      breadcrumbs: parseBreadcrumbs(row.breadcrumbs),
      content: row.content,
      preview: row.preview,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      tokenCount: row.token_count,
      createdAt: row.created_at,
      score,
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
