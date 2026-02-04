/**
 * Format parsed sessions to markdown.
 */

import type { Action, Session } from "./parse";

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const date = d.toISOString().split("T")[0]; // YYYY-MM-DD
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  return `${date} ${time}`;
}

function formatDate(ts: string): string {
  return new Date(ts).toISOString().split("T")[0] ?? ""; // YYYY-MM-DD
}

/**
 * Format an action as "ToolName: detail" or just "ToolName".
 * Exported for use in conversation logging.
 */
export function formatActionCompact(action: Action): string {
  if (action.detail) {
    return `${action.name}: ${action.detail}`;
  }
  return action.name;
}

/**
 * Compact format optimized for token efficiency and human readability.
 * Uses [tag] on its own line, then content below.
 * Uses [you] for assistant since the agent reading this IS bob.
 */
export function formatMarkdown(session: Session): string {
  const lines: string[] = [];

  // Header section
  lines.push(`[date] ${formatDate(session.startedAt)}`);
  lines.push(`[engine] ${session.engine}`);
  lines.push("");

  // Conversation - no blank lines between user/you, only around actions
  for (let i = 0; i < session.turns.length; i++) {
    const turn = session.turns[i];
    if (!turn) continue;
    const ts = formatTimestamp(turn.timestamp);
    const hasActions = turn.actions.length > 0;

    if (turn.user) {
      lines.push(`[user] ${ts}`);
      lines.push(turn.user);
    }

    if (hasActions) {
      lines.push(""); // blank before tools
      if (turn.actions.length === 1) {
        const firstAction = turn.actions[0];
        if (firstAction) {
          lines.push(`[tool] ${formatActionCompact(firstAction)}`);
        }
      } else {
        lines.push("[tools]");
        for (const action of turn.actions) {
          lines.push(`- ${formatActionCompact(action)}`);
        }
      }
      lines.push(""); // blank after tools
    }

    if (turn.assistant) {
      lines.push(`[you] ${ts}`);
      lines.push(turn.assistant);
    }

    // Add blank line between turns only if next turn exists
    if (i < session.turns.length - 1) {
      const nextTurn = session.turns[i + 1];
      const nextHasActions = nextTurn ? nextTurn.actions.length > 0 : false;
      // Only add spacing if this turn had actions or next has actions
      if (hasActions || nextHasActions) {
        lines.push("");
      }
    }
  }

  return lines.join("\n").trim();
}

/**
 * Ultra-compact format for context injection - minimal tokens.
 */
export function formatCompact(session: Session): string {
  const lines: string[] = [];

  for (const turn of session.turns) {
    if (turn.user) {
      lines.push(`user: ${turn.user}`);
    }
    if (turn.actions.length > 0) {
      const summary = turn.actions.map((a) => a.name.toLowerCase()).join(", ");
      lines.push(`[${summary}]`);
    }
    if (turn.assistant) {
      lines.push(`you: ${turn.assistant}`);
    }
  }

  return lines.join("\n");
}

/**
 * First user message as preview for session listing.
 */
export function formatPreview(session: Session, maxLength = 50): string {
  const firstTurn = session.turns[0];
  if (!firstTurn?.user) return "(empty session)";

  const preview = firstTurn.user.slice(0, maxLength);
  return preview.length < firstTurn.user.length ? `${preview}...` : preview;
}
