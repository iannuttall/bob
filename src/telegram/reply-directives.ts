export const SILENT_REPLY_TOKEN = "NO_REPLY";

export type StreamMode = "edit" | "send" | "off";

export type ReplyDirectiveResult = {
  text: string;
  replyToMessageId?: number;
  replyToCurrent: boolean;
  react?: string;
  streamMode?: StreamMode;
  isSilent: boolean;
};

const REPLY_TAG_RE = /\[\[\s*(?:reply_to_current|reply_to\s*:\s*([^\]\n]+))\s*\]\]/gi;
const REACT_TAG_RE = /\[\[\s*react\s*:\s*([^\]\n]+)\s*\]\]/gi;
const STREAM_TAG_RE = /\[\[\s*stream\s*:\s*(edit|send|off)\s*\]\]/gi;
const TG_TAG_RE = /\[tg:([a-z_]+)(?::([^\]\n]+))?\]/gi;

function normalizeDirectiveWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

export function parseReplyDirectives(
  rawText: string,
  options: { currentMessageId?: number; silentTokens?: string[] } = {},
): ReplyDirectiveResult {
  let text = rawText ?? "";
  let replyToCurrent = false;
  let replyToMessageId: number | undefined;
  let react: string | undefined;
  let streamMode: StreamMode | undefined;

  text = text.replace(STREAM_TAG_RE, (_match, modeRaw: string) => {
    const mode = modeRaw.trim() as StreamMode;
    if (mode === "edit" || mode === "send" || mode === "off") {
      streamMode = mode;
    }
    return " ";
  });

  text = text.replace(REACT_TAG_RE, (_match, emojiRaw: string) => {
    const emoji = emojiRaw.trim();
    if (emoji) {
      react = emoji;
    }
    return " ";
  });

  text = text.replace(TG_TAG_RE, (_match, tagRaw: string, valueRaw?: string) => {
    const tag = tagRaw.trim();
    const value = valueRaw?.trim();
    if (tag === "react" && value) {
      react = value;
      return " ";
    }
    if (tag === "stream" && value) {
      const mode = value as StreamMode;
      if (mode === "edit" || mode === "send" || mode === "off") {
        streamMode = mode;
      }
      return " ";
    }
    if (tag === "reply_to_current") {
      replyToCurrent = true;
      return " ";
    }
    if (tag === "reply_to" && value) {
      const id = Number(value);
      if (Number.isFinite(id)) {
        replyToMessageId = id;
      }
      return " ";
    }
    return " ";
  });

  text = text.replace(REPLY_TAG_RE, (_match, idRaw: string | undefined) => {
    if (idRaw === undefined) {
      replyToCurrent = true;
      return " ";
    }
    const id = Number(idRaw.trim());
    if (Number.isFinite(id)) {
      replyToMessageId = id;
    }
    return " ";
  });

  text = normalizeDirectiveWhitespace(text);

  const silentCheck = stripSilentToken(text, options.silentTokens);
  return {
    text: silentCheck.text,
    replyToMessageId: replyToMessageId ?? (replyToCurrent ? options.currentMessageId : undefined),
    replyToCurrent,
    react,
    streamMode,
    isSilent: silentCheck.isSilent,
  };
}

function stripSilentToken(
  text: string,
  tokens: string[] = [SILENT_REPLY_TOKEN],
): { text: string; isSilent: boolean } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { text: "", isSilent: false };
  }
  for (const token of tokens) {
    if (!token) continue;
    if (trimmed === token) {
      return { text: "", isSilent: true };
    }
    if (trimmed.startsWith(`${token} `)) {
      const rest = trimmed.slice(token.length).trim();
      if (!rest) {
        return { text: "", isSilent: true };
      }
    }
    if (trimmed.endsWith(` ${token}`)) {
      const rest = trimmed.slice(0, -token.length).trim();
      if (!rest) {
        return { text: "", isSilent: true };
      }
    }
  }
  return { text, isSilent: false };
}
