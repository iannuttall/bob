import type { EngineId } from "./config/types";

export type ParsedDirectives = {
  engine: EngineId | null;
  project: string | null;
  branch: string | null;
  text: string;
};

const ENGINE_DIRECTIVE_RE = /^\/(claude|codex|opencode|pi)\b\s*/i;
const AGENT_COMMAND_RE = /^\/agent\s*$/i;
const STATUS_COMMAND_RE = /^\/status\s*$/i;
const START_COMMAND_RE = /^\/start\s*$/i;
const PROJECT_DIRECTIVE_RE = /^\/([a-zA-Z0-9_-]+)\s+/;
const BRANCH_DIRECTIVE_RE = /^@([a-zA-Z0-9_/-]+)\s*/;

/**
 * Parse directives from the beginning of a message.
 *
 * Supported formats:
 * - /claude <text>     -> engine: "claude"
 * - /codex <text>      -> engine: "codex"
 * - /project @branch   -> project binding (future)
 * - @branch <text>     -> branch binding (future)
 */
export function parseDirectives(text: string): ParsedDirectives {
  let remaining = text.trim();
  let engine: EngineId | null = null;
  let project: string | null = null;
  let branch: string | null = null;

  // Check for engine directive first
  const engineMatch = remaining.match(ENGINE_DIRECTIVE_RE);
  if (engineMatch?.[1]) {
    const engineStr = engineMatch[1].toLowerCase();
    if (isValidEngine(engineStr)) {
      engine = engineStr;
      remaining = remaining.slice(engineMatch[0].length);
    }
  }

  // Check for project directive (if not an engine directive)
  if (!engine) {
    const projectMatch = remaining.match(PROJECT_DIRECTIVE_RE);
    if (projectMatch?.[1]) {
      project = projectMatch[1];
      remaining = remaining.slice(projectMatch[0].length);
    }
  }

  // Check for branch directive
  const branchMatch = remaining.match(BRANCH_DIRECTIVE_RE);
  if (branchMatch?.[1]) {
    branch = branchMatch[1];
    remaining = remaining.slice(branchMatch[0].length);
  }

  return {
    engine,
    project,
    branch,
    text: remaining.trim() || text.trim(), // Fall back to original if nothing left
  };
}

function isValidEngine(engine: string): engine is EngineId {
  return engine === "claude" || engine === "codex" || engine === "opencode" || engine === "pi";
}

/**
 * Check if message is /agent command (toggle engine).
 */
export function isAgentCommand(text: string): boolean {
  return AGENT_COMMAND_RE.test(text.trim());
}

/**
 * Check if message is /start command (Telegram bot init).
 */
export function isStartCommand(text: string): boolean {
  return START_COMMAND_RE.test(text.trim());
}

/**
 * Check if message is /status command.
 */
export function isStatusCommand(text: string): boolean {
  return STATUS_COMMAND_RE.test(text.trim());
}
