import { readFileSync, existsSync } from "node:fs";
import type { EngineId } from "../config/types";
import { atomicWriteJson } from "../utils/atomic-write";

export type ResumeToken = {
  engine: EngineId;
  value: string;
};

export type ChatContext = {
  project: string | null;
  branch: string | null;
};

export type ChatSession = {
  sessions: Partial<Record<EngineId, { resume: string; updatedAt: string }>>;
  context?: ChatContext;
  defaultEngine?: EngineId;
};

export type SessionsState = {
  version: number;
  cwd: string | null;
  chats: Record<string, ChatSession>;
};

const CURRENT_VERSION = 1;

/**
 * Atomic JSON-based session store like takopi.
 * Stores per-chat, per-engine resume tokens.
 */
export class SessionStore {
  private path: string;
  private state: SessionsState;

  constructor(sessionsPath: string) {
    this.path = sessionsPath;
    this.state = this.load();
  }

  private load(): SessionsState {
    if (!existsSync(this.path)) {
      return { version: CURRENT_VERSION, cwd: null, chats: {} };
    }
    try {
      const raw = readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw) as SessionsState;
      if (parsed.version !== CURRENT_VERSION) {
        console.warn(`Sessions version mismatch, resetting`);
        return { version: CURRENT_VERSION, cwd: null, chats: {} };
      }
      return parsed;
    } catch {
      return { version: CURRENT_VERSION, cwd: null, chats: {} };
    }
  }

  private save() {
    atomicWriteJson(this.path, this.state);
  }

  private chatKey(chatId: number): string {
    return String(chatId);
  }

  /**
   * Get resume token for a specific chat and engine.
   */
  getResume(chatId: number, engine: EngineId): ResumeToken | null {
    const key = this.chatKey(chatId);
    const chat = this.state.chats[key];
    if (!chat) return null;
    const session = chat.sessions[engine];
    if (!session) return null;
    return { engine, value: session.resume };
  }

  /**
   * Set resume token for a specific chat and engine.
   */
  setResume(chatId: number, token: ResumeToken) {
    const key = this.chatKey(chatId);
    if (!this.state.chats[key]) {
      this.state.chats[key] = { sessions: {} };
    }
    this.state.chats[key].sessions[token.engine] = {
      resume: token.value,
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  /**
   * Clear all sessions for a specific chat.
   */
  clearChat(chatId: number) {
    const key = this.chatKey(chatId);
    delete this.state.chats[key];
    this.save();
  }

  /**
   * Clear sessions for a specific chat and engine.
   */
  clearEngine(chatId: number, engine: EngineId) {
    const key = this.chatKey(chatId);
    const chat = this.state.chats[key];
    if (chat) {
      delete chat.sessions[engine];
      this.save();
    }
  }

  /**
   * Sync cwd on startup - if working directory changed, clear all sessions.
   * This is the takopi pattern for auto-reset.
   */
  syncCwd(cwd: string): boolean {
    if (this.state.cwd && this.state.cwd !== cwd) {
      console.log(`Working directory changed (${this.state.cwd} -> ${cwd}), clearing sessions`);
      this.state.chats = {};
      this.state.cwd = cwd;
      this.save();
      return true;
    }
    if (!this.state.cwd) {
      this.state.cwd = cwd;
      this.save();
    }
    return false;
  }

  /**
   * Get all sessions for a chat (for status display).
   */
  getChatSessions(chatId: number): ChatSession | null {
    const key = this.chatKey(chatId);
    return this.state.chats[key] ?? null;
  }

  /**
   * Set context (project/branch binding) for a chat.
   */
  setContext(chatId: number, context: ChatContext) {
    const key = this.chatKey(chatId);
    if (!this.state.chats[key]) {
      this.state.chats[key] = { sessions: {} };
    }
    this.state.chats[key].context = context;
    this.save();
  }

  /**
   * Get context for a chat.
   */
  getContext(chatId: number): ChatContext | null {
    const key = this.chatKey(chatId);
    const chat = this.state.chats[key];
    if (!chat?.context) return null;
    return chat.context;
  }

  /**
   * Clear context for a chat.
   */
  clearContext(chatId: number) {
    const key = this.chatKey(chatId);
    const chat = this.state.chats[key];
    if (chat) {
      delete chat.context;
      this.save();
    }
  }

  /**
   * Get default engine for a chat.
   */
  getDefaultEngine(chatId: number): EngineId | null {
    const key = this.chatKey(chatId);
    const chat = this.state.chats[key];
    return chat?.defaultEngine ?? null;
  }

  /**
   * Set default engine for a chat.
   */
  setDefaultEngine(chatId: number, engine: EngineId) {
    const key = this.chatKey(chatId);
    if (!this.state.chats[key]) {
      this.state.chats[key] = { sessions: {} };
    }
    this.state.chats[key].defaultEngine = engine;
    this.save();
  }

  /**
   * Clear default engine for a chat (fall back to global default).
   */
  clearDefaultEngine(chatId: number) {
    const key = this.chatKey(chatId);
    const chat = this.state.chats[key];
    if (chat) {
      delete chat.defaultEngine;
      this.save();
    }
  }
}

// Resume token extraction patterns from CLI output
export const RESUME_PATTERNS: Record<EngineId, RegExp> = {
  claude: /claude\s+(?:--resume|-r)\s+([^\s`"']+)/i,
  codex: /codex\s+resume\s+([^\s`"']+)/i,
  opencode: /opencode\s+(?:--resume|-r)\s+([^\s`"']+)/i,
  pi: /pi\s+(?:--resume|-r)\s+([^\s`"']+)/i,
};

// JSON stream session_id extraction for claude
const CLAUDE_SESSION_RE = /"session_id"\s*:\s*"([^"]+)"/;

/**
 * Extract resume token from CLI output text.
 */
export function extractResumeToken(text: string, engine: EngineId): string | null {
  // Try JSON stream format first (claude)
  if (engine === "claude") {
    const jsonMatch = text.match(CLAUDE_SESSION_RE);
    if (jsonMatch?.[1]) {
      return jsonMatch[1];
    }
  }

  // Try pattern matching
  const pattern = RESUME_PATTERNS[engine];
  if (pattern) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Format a resume command for display.
 */
export function formatResumeCommand(token: ResumeToken): string {
  switch (token.engine) {
    case "claude":
      return `claude --resume ${token.value}`;
    case "codex":
      return `codex resume ${token.value}`;
    case "opencode":
      return `opencode --resume ${token.value}`;
    case "pi":
      return `pi --resume ${token.value}`;
    default:
      return `${token.engine} --resume ${token.value}`;
  }
}
