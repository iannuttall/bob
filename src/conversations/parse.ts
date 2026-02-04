/**
 * Parse SDK session logs into a common format.
 * Handles both Claude and Codex JSONL formats.
 */

import { readFileSync } from "node:fs";

export type Turn = {
  timestamp: string;
  user?: string;
  assistant?: string;
  actions: Action[];
};

export type Action = {
  type: "bash" | "read" | "write" | "edit" | "tool";
  name: string;
  detail?: string;
};

export type Session = {
  id: string;
  engine: "claude" | "codex";
  startedAt: string;
  turns: Turn[];
};

// --- Claude Format ---

type ClaudeEntry = {
  type: string;
  sessionId?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  };
  timestamp?: string;
};

function parseClaudeUserText(content: string | Array<{ type: string; text?: string }>): string | null {
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && block.text) {
        // Look for "User: " at the end of the text block
        const userMatch = block.text.match(/\nUser:\s*(.+?)$/s);
        if (userMatch?.[1]) return userMatch[1].trim();
        // Also check for "User [id:X]:" format
        const userIdMatch = block.text.match(/\nUser\s*\[id:\d+\]:\s*(.+?)$/s);
        if (userIdMatch?.[1]) return userIdMatch[1].trim();
      }
      if (block.type === "tool_result") return null;
    }
    return null;
  }

  // String content - find last "User:" line
  const lines = content.split("\n");
  let lastUserLine = "";
  for (const line of lines) {
    if (line.startsWith("User:") || line.match(/^User \[id:\d+\]:/)) {
      lastUserLine = line;
    }
  }
  if (lastUserLine) {
    return lastUserLine.replace(/^User(\s*\[id:\d+\])?:\s*/, "").trim();
  }
  if (content.length < 500 && !content.includes("# instructions")) {
    return content.trim();
  }
  return null;
}

function parseClaudeAssistant(
  content: string | Array<{ type: string; text?: string; name?: string; input?: unknown }>,
): { text: string; actions: Action[] } {
  const actions: Action[] = [];
  let text = "";

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && block.text) {
        text += `${block.text}\n`;
      } else if (block.type === "tool_use" && block.name) {
        const input = block.input as Record<string, unknown>;
        if (block.name === "Bash" && input.command) {
          actions.push({ type: "bash", name: "Bash", detail: String(input.command) });
        } else if (block.name === "Write" && input.file_path) {
          actions.push({ type: "write", name: "Write", detail: String(input.file_path) });
        } else if (block.name === "Read" && input.file_path) {
          actions.push({ type: "read", name: "Read", detail: String(input.file_path) });
        } else if (block.name === "Edit" && input.file_path) {
          actions.push({ type: "edit", name: "Edit", detail: String(input.file_path) });
        } else if (block.name === "WebSearch" && input.query) {
          actions.push({ type: "tool", name: "WebSearch", detail: String(input.query) });
        } else if (block.name === "WebFetch" && input.url) {
          actions.push({ type: "tool", name: "WebFetch", detail: String(input.url) });
        } else if (block.name === "Grep" && input.pattern) {
          actions.push({ type: "tool", name: "Grep", detail: String(input.pattern) });
        } else if (block.name === "Glob" && input.pattern) {
          actions.push({ type: "tool", name: "Glob", detail: String(input.pattern) });
        } else if (block.name === "Task" && input.prompt) {
          const prompt = String(input.prompt).slice(0, 100);
          actions.push({ type: "tool", name: "Task", detail: prompt });
        } else if (block.name === "Skill" && input.skill) {
          actions.push({ type: "tool", name: "Skill", detail: String(input.skill) });
        } else {
          actions.push({ type: "tool", name: block.name });
        }
      }
    }
  }

  return { text: text.trim(), actions };
}

function parseClaude(content: string, sessionId: string): Session {
  const lines = content.split("\n").filter((l) => l.trim());
  const entries: ClaudeEntry[] = [];

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }

  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;

  for (const entry of entries) {
    if (entry.type === "user" && entry.message?.role === "user") {
      const userText = parseClaudeUserText(
        entry.message.content as string | Array<{ type: string; text?: string }>,
      );
      if (userText) {
        // Start new turn
        currentTurn = {
          timestamp: entry.timestamp ?? new Date().toISOString(),
          user: userText,
          actions: [],
        };
        turns.push(currentTurn);
      }
    } else if (entry.type === "assistant" && entry.message?.content && currentTurn) {
      const { text, actions } = parseClaudeAssistant(entry.message.content);
      currentTurn.actions.push(...actions);
      if (text) {
        currentTurn.assistant = (currentTurn.assistant ?? "") + text;
      }
    }
  }

  const firstEntry = entries.find((e) => e.timestamp);
  return {
    id: sessionId,
    engine: "claude",
    startedAt: firstEntry?.timestamp ?? new Date().toISOString(),
    turns,
  };
}

// --- Codex Format ---

type CodexEntry = {
  type: string;
  timestamp: string;
  payload: {
    type?: string;
    id?: string;
    message?: string;
    text?: string;
    role?: string;
    name?: string;
    input?: string;
    arguments?: string;
    content?: Array<{ type: string; text?: string }>;
    call?: { name?: string; arguments?: string };
    action?: { type?: string; query?: string; url?: string };
  };
};

function isSystemContent(text: string): boolean {
  // Skip system prompts, instructions, environment context
  return (
    text.includes("# SOUL.md") ||
    text.includes("<INSTRUCTIONS>") ||
    text.includes("<environment_context>") ||
    text.includes("<permissions") ||
    text.includes("# instructions for") ||
    text.startsWith("---") // YAML frontmatter
  );
}

function parseCodex(content: string, sessionId: string): Session {
  const lines = content.split("\n").filter((l) => l.trim());
  const entries: CodexEntry[] = [];

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }

  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;

  for (const entry of entries) {
    if (entry.type === "event_msg") {
      const payload = entry.payload;

      if (payload.type === "user_message" && payload.message) {
        // Skip system content
        if (isSystemContent(payload.message)) continue;

        // Skip if same as previous turn (dedupe)
        const lastTurn = turns[turns.length - 1];
        if (lastTurn?.user === payload.message) continue;

        // Start new turn
        currentTurn = {
          timestamp: entry.timestamp,
          user: payload.message,
          actions: [],
        };
        turns.push(currentTurn);
      } else if (payload.type === "agent_message" && payload.message && currentTurn) {
        currentTurn.assistant = (currentTurn.assistant ?? "") + payload.message;
      } else if (payload.type === "exec_command" && currentTurn) {
        // Tool call
        const call = payload.call;
        if (call?.name === "shell" && call.arguments) {
          try {
            const args = JSON.parse(call.arguments);
            currentTurn.actions.push({ type: "bash", name: "shell", detail: args.command });
          } catch {
            currentTurn.actions.push({ type: "bash", name: "shell" });
          }
        } else if (call?.name) {
          currentTurn.actions.push({ type: "tool", name: call.name });
        }
      }
    } else if (entry.type === "response_item") {
      const payload = entry.payload;

      if (payload.role === "user") {
        // Alternative user message format
        const content = payload.content;
        if (Array.isArray(content)) {
          const textBlock = content.find((c) => c.type === "input_text" && c.text);
          if (textBlock?.text && !isSystemContent(textBlock.text)) {
            currentTurn = {
              timestamp: entry.timestamp,
              user: textBlock.text,
              actions: [],
            };
            turns.push(currentTurn);
          }
        }
      } else if (payload.type === "function_call" && currentTurn) {
        // Tool call - exec_command, write_stdin
        const name = payload.name as string;
        let detail: string | undefined;

        if (payload.arguments) {
          try {
            const args = JSON.parse(payload.arguments as string);
            if (name === "exec_command" && args.cmd) {
              detail = args.cmd;
            } else if (args.command) {
              detail = args.command;
            } else if (args.file_path) {
              detail = args.file_path;
            }
          } catch {
            // ignore parse errors
          }
        }

        if (name === "exec_command") {
          currentTurn.actions.push({ type: "bash", name: "Bash", detail });
        } else if (name === "write_stdin") {
          // Skip write_stdin as it's typically follow-up to exec_command
        } else {
          currentTurn.actions.push({ type: "tool", name });
        }
      } else if (payload.type === "custom_tool_call" && currentTurn) {
        // Custom tools like apply_patch
        const name = payload.name as string;
        if (name === "apply_patch" && payload.input) {
          // Extract file path from patch input
          const match = payload.input.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/);
          const filePath = match?.[1];
          currentTurn.actions.push({ type: "edit", name: "Edit", detail: filePath });
        } else {
          currentTurn.actions.push({ type: "tool", name });
        }
      } else if (payload.type === "web_search_call" && currentTurn) {
        // Web search
        const action = payload.action;
        if (action?.type === "search" && action.query) {
          currentTurn.actions.push({ type: "tool", name: "WebSearch", detail: action.query });
        } else if (action?.type === "open_page" && action.url) {
          currentTurn.actions.push({ type: "tool", name: "WebFetch", detail: action.url });
        }
      }
    }
  }

  const meta = entries.find((e) => e.type === "session_meta");
  return {
    id: sessionId,
    engine: "codex",
    startedAt: meta?.timestamp ?? entries[0]?.timestamp ?? new Date().toISOString(),
    turns,
  };
}

// --- Public API ---

/**
 * Parse Claude assistant content blocks into text and actions.
 * Used both for JSONL parsing and real-time stream parsing.
 */
export function parseClaudeContent(
  content: string | Array<{ type: string; text?: string; name?: string; input?: unknown }>,
): { text: string; actions: Action[] } {
  return parseClaudeAssistant(content);
}

/**
 * Parse a Codex tool call into an Action.
 */
export function parseCodexToolCall(
  name: string,
  args?: string,
): Action | null {
  let detail: string | undefined;

  if (args) {
    try {
      const parsed = JSON.parse(args);
      if (name === "shell" && parsed.command) {
        return { type: "bash", name: "shell", detail: parsed.command };
      }
      if (name === "exec_command" && parsed.cmd) {
        return { type: "bash", name: "Bash", detail: parsed.cmd };
      }
      if (parsed.command) detail = parsed.command;
      if (parsed.file_path) detail = parsed.file_path;
      if (parsed.path) detail = parsed.path;
    } catch {
      // ignore parse errors
    }
  }

  if (name === "shell" || name === "exec_command") {
    return { type: "bash", name: "Bash", detail };
  }
  if (name === "apply_patch") {
    return { type: "edit", name: "Edit", detail };
  }
  if (name === "read_file") {
    return { type: "read", name: "Read", detail };
  }
  if (name === "write_file") {
    return { type: "write", name: "Write", detail };
  }

  return { type: "tool", name, detail };
}

export function detectEngine(content: string): "claude" | "codex" {
  // Codex has session_meta with originator: "codex_exec"
  if (content.includes('"originator":"codex_exec"') || content.includes('"type":"session_meta"')) {
    return "codex";
  }
  return "claude";
}

export function parseSession(filePath: string): Session {
  const content = readFileSync(filePath, "utf-8");
  const sessionId = filePath.split("/").pop()?.replace(".jsonl", "") ?? "unknown";
  const engine = detectEngine(content);

  if (engine === "codex") {
    return parseCodex(content, sessionId);
  }
  return parseClaude(content, sessionId);
}

export function parseSessionContent(content: string, sessionId: string): Session {
  const engine = detectEngine(content);
  if (engine === "codex") {
    return parseCodex(content, sessionId);
  }
  return parseClaude(content, sessionId);
}
