import { chunkTelegramMessage, renderTelegramMarkdown } from "./render";
import { editTelegramMessage, sendTelegramMessage, sendTelegramReaction } from "./transport";
import { parseReplyDirectives, type StreamMode } from "./reply-directives";
import type { MessageLogger } from "../storage/messages";
import type { TelegramTransportConfig } from "./transport";
import type { Action } from "../conversations/parse";

type RunResult = {
  result: string;
  actions?: Action[];
};

type StreamReplyOptions = {
  transport: TelegramTransportConfig;
  chatId: number;
  threadId?: number;
  currentMessageId?: number;
  run: (onDelta: (delta: string) => void) => Promise<string | RunResult>;
  messageLogger?: MessageLogger;
  role?: "assistant";
  silentTokens?: string[];
  onWillSend?: () => void;
  isCancelled?: () => boolean;
};

type StreamState = {
  buffer: string;
  mode: StreamMode;
  sentMessageId: number | null;
  lastSentText: string;
  lastRenderedText: string;
  lastFlushAt: number;
};

const FLUSH_INTERVAL_MS = 900;
const STREAM_PREVIEW_LIMIT = 3000;
const TYPING_DELAY_MS = 600;

export async function streamAgentReply(
  options: StreamReplyOptions,
): Promise<{ didSend: boolean; didReact: boolean; responseText: string; actions: Action[] }> {
  const state: StreamState = {
    buffer: "",
    mode: "edit",
    sentMessageId: null,
    lastSentText: "",
    lastRenderedText: "",
    lastFlushAt: 0,
  };

  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let didSend = false;
  let didReact = false;
  let didTriggerSend = false;
  let flushInProgress = false;
  let pendingFlush = false;
  let typingTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    triggerSend();
  }, TYPING_DELAY_MS);
  if (typeof typingTimer.unref === "function") {
    typingTimer.unref();
  }
  const triggerSend = () => {
    if (didTriggerSend) return;
    didTriggerSend = true;
    options.onWillSend?.();
    if (typingTimer) {
      clearTimeout(typingTimer);
      typingTimer = null;
    }
  };
  const cancelTypingTimer = () => {
    if (typingTimer) {
      clearTimeout(typingTimer);
      typingTimer = null;
    }
  };
  const scheduleFlush = () => {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      void flush(false);
    }, FLUSH_INTERVAL_MS);
    if (typeof scheduled.unref === "function") {
      scheduled.unref();
    }
  };

  const flush = async (final: boolean) => {
    // Check if cancelled
    if (options.isCancelled?.()) {
      return;
    }

    // Mutex: prevent concurrent flushes from racing
    if (flushInProgress) {
      if (!final) {
        pendingFlush = true;
      }
      return;
    }
    flushInProgress = true;

    try {
    const parsed = parseReplyDirectives(state.buffer, {
      currentMessageId: options.currentMessageId,
      silentTokens: options.silentTokens,
    });
    if (parsed.streamMode) {
      state.mode = parsed.streamMode;
    }

    if (parsed.isSilent && final) {
      cancelTypingTimer();
      if (parsed.react && options.currentMessageId) {
        const ok = await sendTelegramReaction(
          options.transport,
          options.chatId,
          options.currentMessageId,
          parsed.react,
        );
        if (ok) {
          didReact = true;
        } else {
          await sendTelegramMessage(options.transport, options.chatId, parsed.react, {
            threadId: options.threadId,
          });
          didSend = true;
        }
      }
      return;
    }

    if (state.mode === "off" && !final) {
      return;
    }

    const cleaned = sanitizeUserText(parsed.text);
    if (final && !cleaned.trim() && parsed.react && options.currentMessageId) {
      cancelTypingTimer();
      const ok = await sendTelegramReaction(
        options.transport,
        options.chatId,
        options.currentMessageId,
        parsed.react,
      );
      if (ok) {
        didReact = true;
      } else {
        await sendTelegramMessage(options.transport, options.chatId, parsed.react, {
          threadId: options.threadId,
        });
        didSend = true;
      }
      return;
    }
    if (!cleaned.trim()) {
      return;
    }

    cancelTypingTimer();
    const now = Date.now();
    if (!final && now - state.lastFlushAt < FLUSH_INTERVAL_MS) {
      scheduleFlush();
      return;
    }
    state.lastFlushAt = now;

    if (state.mode === "send") {
      const delta = cleaned.slice(state.lastSentText.length);
      if (!delta.trim()) {
        return;
      }
      const replyToMessageId = state.sentMessageId ? undefined : parsed.replyToMessageId;
      triggerSend();
      const messageId = await sendTelegramMessage(
        options.transport,
        options.chatId,
        delta,
        {
          threadId: options.threadId,
          replyToMessageId,
        },
      );
      if (messageId && state.sentMessageId === null) {
        state.sentMessageId = messageId;
      }
      if (messageId) {
        didSend = true;
      }
      state.lastSentText = cleaned;
      return;
    }

    const preview = final ? cleaned : cleaned.slice(0, STREAM_PREVIEW_LIMIT);
    const rendered = renderTelegramMarkdown(preview);
    const chunks = chunkTelegramMessage(rendered);
    const primary = chunks[0];
    if (!primary) return;

    // Skip if content hasn't changed (prevents duplicate messages)
    if (state.sentMessageId !== null && cleaned === state.lastSentText) {
      console.log(`[stream] skipping flush - content unchanged (final=${final})`);
      return;
    }

    console.log(`[stream] flush final=${final} sentMessageId=${state.sentMessageId} textLen=${cleaned.length}`);

    if (state.sentMessageId === null) {
      console.log(`[stream] SEND new message`);
      triggerSend();
      state.sentMessageId = await sendTelegramMessage(
        options.transport,
        options.chatId,
        primary.text,
        {
          threadId: options.threadId,
          replyToMessageId: parsed.replyToMessageId,
          chunk: false,
          entities: primary.entities,
        },
      );
      if (state.sentMessageId) {
        didSend = true;
      }
    } else {
      try {
        console.log(`[stream] EDIT message ${state.sentMessageId}`);
        await editTelegramMessage(
          options.transport,
          options.chatId,
          state.sentMessageId,
          primary.text,
          {
            entities: primary.entities,
          },
        );
        didSend = true;
      } catch (error) {
        // Only send new message if it's NOT a "message not modified" error
        const errMsg = error instanceof Error ? error.message : String(error);
        console.log(`[stream] edit failed: ${errMsg}`);
        if (!/not modified/i.test(errMsg)) {
          console.log(`[stream] SEND fallback message (edit failed)`);
          const newMessageId = await sendTelegramMessage(
            options.transport,
            options.chatId,
            primary.text,
            {
              threadId: options.threadId,
              chunk: false,
              entities: primary.entities,
            },
          );
          if (newMessageId) {
            state.sentMessageId = newMessageId;
          }
          state.mode = "send";
          didSend = true;
        }
      }
    }

    if (final && chunks.length > 1) {
      triggerSend();
      for (const chunk of chunks.slice(1)) {
        await sendTelegramMessage(options.transport, options.chatId, chunk.text, {
          threadId: options.threadId,
          entities: chunk.entities,
        });
        didSend = true;
      }
    }

    state.lastSentText = cleaned;

    if (final && parsed.react && options.currentMessageId) {
      const ok = await sendTelegramReaction(
        options.transport,
        options.chatId,
        options.currentMessageId,
        parsed.react,
      );
      if (ok) {
        didReact = true;
      } else {
        await sendTelegramMessage(options.transport, options.chatId, parsed.react, {
          threadId: options.threadId,
        });
        didSend = true;
      }
    }
    } finally {
      flushInProgress = false;
      // If a non-final flush was requested while we were busy, schedule another
      if (pendingFlush) {
        pendingFlush = false;
        scheduleFlush();
      }
    }
  };

  const runResult = await options.run((delta) => {
    state.buffer = appendDeltaWithSpace(state.buffer, delta);
    const parsed = parseReplyDirectives(state.buffer, {
      currentMessageId: options.currentMessageId,
      silentTokens: options.silentTokens,
    });
    const cleaned = sanitizeUserText(parsed.text);
    if (cleaned.trim()) {
      triggerSend();
    }
    scheduleFlush();
  });

  // Handle both string and RunResult return types
  const finalText = typeof runResult === "string" ? runResult : runResult.result;
  const actions = typeof runResult === "string" ? [] : (runResult.actions ?? []);

  state.buffer = finalText;
  if (scheduled) {
    clearTimeout(scheduled);
    scheduled = null;
  }
  await flush(true);

  if (options.messageLogger && state.lastSentText.trim()) {
    options.messageLogger.logMessage({
      chatId: options.chatId,
      threadId: options.threadId,
      role: "assistant",
      text: state.lastSentText.trim(),
      messageId: state.sentMessageId ?? undefined,
    });
  }
  return { didSend, didReact, responseText: state.lastSentText.trim(), actions };
}

function sanitizeUserText(text: string) {
  if (!text) return "";
  let cleaned = text;
  cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  cleaned = cleaned.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "");
  cleaned = cleaned.replace(/```(?:thinking|analysis)[\s\S]*?```/gi, "");
  cleaned = cleaned.replace(/^\s*(Thinking|Reasoning|Chain of thought)\s*:.*$/gim, "");
  return cleaned.trim();
}

function appendDeltaWithSpace(buffer: string, delta: string) {
  if (!delta) return buffer;
  if (!buffer) return delta;
  const last = buffer[buffer.length - 1] ?? "";
  const first = delta[0] ?? "";
  if (needsJoinSpace(last, first)) {
    return `${buffer} ${delta}`;
  }
  return buffer + delta;
}

function needsJoinSpace(last: string, first: string) {
  if (!last || !first) return false;
  if (/\s/.test(last) || /\s/.test(first)) return false;
  if (!/^[A-Za-z0-9]/.test(first)) return false;
  return /[.!?]/.test(last);
}
