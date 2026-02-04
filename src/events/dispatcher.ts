import { readFileSync } from "node:fs";
import path from "node:path";
import { runClaudeSdk, runCodexSdk } from "../runner";
import { buildPromptFromConfig } from "../prompt/system";
import { DEFAULT_CONTEXT_LIMIT, formatContext } from "../prompt/context";
import type { MessageLogger } from "../storage/messages";
import type { TelegramTransportConfig } from "../telegram";
import type { EventRecord, EventStore } from "./store";
import { streamAgentReply } from "../telegram/reply-stream";
import { SILENT_REPLY_TOKEN } from "../telegram/reply-directives";
import { appendConversation } from "../conversations";
import type { EngineId } from "../config/types";

const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
const DEFAULT_EVENT_PROMPT =
  "Process the queued events. Decide if the user should be notified or if follow-ups should be scheduled. If nothing needs attention, reply HEARTBEAT_OK.";

export type EventDispatchConfig = {
  enabled: boolean;
  prompt?: string;
  file?: string;
};

export type EventDispatchOptions = {
  globalRoot: string;
  dataRoot: string;
  transport: TelegramTransportConfig;
  messageLogger?: MessageLogger;
  eventStore: EventStore;
  heartbeat: EventDispatchConfig;
  defaultEngine?: EngineId;
  engines?: {
    claude: { skipPermissions: boolean };
    codex: { yolo: boolean };
  };
};

export type EventDispatchResult = {
  processed: number;
  sent: number;
};

export async function processEvents(options: EventDispatchOptions): Promise<EventDispatchResult> {
  if (!options.heartbeat.enabled) {
    return { processed: 0, sent: 0 };
  }
  const { claimToken, events } = options.eventStore.claimEvents();
  if (events.length === 0) {
    return { processed: 0, sent: 0 };
  }

  let sent = 0;
  try {
    const heartbeatContent = readHeartbeatFile(
      resolveHeartbeatFile(options.globalRoot, options.heartbeat.file),
    );
    const promptText = (options.heartbeat.prompt ?? DEFAULT_EVENT_PROMPT).trim();
    const groups = groupEvents(events);

    const memoryRoot = path.join(options.globalRoot, "memory");

    for (const group of groups) {
      const target = { chatId: group.chatId, threadId: group.threadId };
      const eventBlock = formatEventBlock(group.events);
      const contextBlock = loadRecentContext(
        options.messageLogger,
        target.chatId,
        target.threadId,
      );

      const heartbeatBlock = heartbeatContent
        ? `Heartbeat context:\n${heartbeatContent}`
        : null;

      const fullPrompt = buildPromptFromConfig({
        globalRoot: options.globalRoot,
        memoryRoot,
        userText: `${promptText}\n\n${eventBlock}`,
        contextBlock,
        memoryOverride: heartbeatBlock,
      });

      const sentReply = await streamAgentReply({
        transport: options.transport,
        chatId: target.chatId,
        threadId: target.threadId ?? undefined,
        messageLogger: options.messageLogger,
        silentTokens: [HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN],
        run: async (onDelta) => {
          if (options.defaultEngine === "codex") {
            const sdkResult = await runCodexSdk({
              prompt: fullPrompt,
              cwd: process.cwd(),
              onDelta,
              yolo: options.engines?.codex.yolo ?? true,
            });
            return { result: sdkResult.result, actions: sdkResult.actions };
          } else {
            const sdkResult = await runClaudeSdk({
              prompt: fullPrompt,
              cwd: process.cwd(),
              onDelta,
              skipPermissions: options.engines?.claude.skipPermissions ?? true,
            });
            return { result: sdkResult.result, actions: sdkResult.actions };
          }
        },
      });

      // Append to daily conversation log
      if (sentReply.responseText) {
        const engineType = options.defaultEngine === "codex" ? "codex" : "claude";
        appendConversation(memoryRoot, engineType, {
          userText: `[EVENT] ${promptText}`,
          assistantText: sentReply.responseText,
          actions: sentReply.actions,
        });
      }

      if (sentReply.didSend || sentReply.didReact) {
        sent += 1;
      }
    }

    options.eventStore.ackEvents(claimToken);
    return { processed: events.length, sent };
  } catch (error) {
    options.eventStore.releaseClaim(claimToken);
    throw error;
  }
}

function groupEvents(events: EventRecord[]) {
  const groups = new Map<
    string,
    { chatId: number; threadId: number | null; events: EventRecord[] }
  >();
  for (const event of events) {
    const key = `${event.chatId}:${event.threadId ?? "none"}`;
    const existing = groups.get(key);
    if (existing) {
      existing.events.push(event);
    } else {
      groups.set(key, {
        chatId: event.chatId,
        threadId: event.threadId ?? null,
        events: [event],
      });
    }
  }
  return Array.from(groups.values());
}

function formatEventBlock(events: EventRecord[]): string {
  const payload = events.map((event) => ({
    id: event.id,
    kind: event.kind,
    chat_id: event.chatId,
    thread_id: event.threadId ?? null,
    created_at: event.createdAt,
    payload: event.payload,
  }));
  return `Events:\n${JSON.stringify(payload, null, 2)}`;
}

function loadRecentContext(
  logger: MessageLogger | undefined,
  chatId: number,
  threadId: number | null,
): string | null {
  if (!logger) {
    return null;
  }
  const history = logger.getRecentMessages({
    chatId,
    threadId: threadId ?? undefined,
    limit: DEFAULT_CONTEXT_LIMIT,
  });
  return formatContext(history);
}

function resolveHeartbeatFile(globalRoot: string, raw?: string): string {
  if (raw?.trim()) {
    if (raw.startsWith("~")) {
      return path.resolve(raw.replace(/^~\//, `${process.env.HOME ?? ""}/`));
    }
    if (path.isAbsolute(raw)) {
      return raw;
    }
    return path.join(globalRoot, raw);
  }
  return path.join(globalRoot, "HEARTBEAT.md");
}

function readHeartbeatFile(filePath: string): string | null {
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    return raw || null;
  } catch {
    return null;
  }
}
