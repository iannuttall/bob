export const DEFAULT_CONTEXT_LIMIT = 12;

export function formatContext(
  history: Array<{ role: "user" | "assistant"; text: string; messageId?: number | null }>,
): string | null {
  if (history.length === 0) {
    return null;
  }
  const lines = history.map((entry) => {
    const label = entry.role === "user" ? "User" : "Assistant";
    const tag =
      entry.messageId !== undefined && entry.messageId !== null ? ` [id:${entry.messageId}]` : "";
    return `${label}${tag}: ${entry.text}`;
  });
  return `Recent conversation (most recent last):\n${lines.join("\n")}`;
}
