import { loadConfig } from "./config/load";
import { runClaudeSdk, runCodexSdk } from "./runner";
import type { ImageContent } from "./runner";
import { createMessageLogger } from "./storage/messages";
import { startScheduler } from "./scheduler";
import {
  sendTelegramReaction,
  sendTelegramMessage,
  startTelegramTransport,
  startTypingIndicator,
  registerTelegramCommands,
  downloadTelegramImage,
} from "./telegram";
import { buildPromptFromConfig } from "./prompt/system";
import { DEFAULT_CONTEXT_LIMIT, formatContext } from "./prompt/context";
import { streamAgentReply } from "./telegram/reply-stream";
import { SessionStore } from "./sessions/store";
import { appendConversation } from "./conversations";
import { parseDirectives, isAgentCommand, isStartCommand, isStatusCommand } from "./directives";
import { createJobStore } from "./scheduler/store";
import { checkForCrash, clearExitInfo, writeExitInfo } from "./crash/recovery";
import { createEventStore } from "./events/store";
import { checkForUpdates, formatVersionContext } from "./utils/version";
import type { EngineId } from "./config/types";
import path from "node:path";


async function main() {
  const config = await loadConfig();
  const token = config.telegram.token ?? process.env.BOB_TELEGRAM_TOKEN;

  if (!token) {
    console.error("missing telegram token. set telegram.token in ~/.bob/config.toml or BOB_TELEGRAM_TOKEN.");
    process.exit(1);
  }

  const allowlist = config.telegram.allowlist;
  const transportConfig = {
    token,
    allowlist,
    statePath: path.join(config.dataRoot, "telegram-offset.json"),
  };
  const ackReaction = config.telegram.ackReaction;

  // setup signal handlers for clean shutdown tracking
  const handleExit = (code: number) => {
    writeExitInfo(config.dataRoot, code);
  };
  process.on("exit", handleExit);
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));

  // check for crash on startup
  const crash = checkForCrash(config.dataRoot, config.paths.logsRoot);
  if (crash) {
    console.log(`detected crash (exit code ${crash.exitCode}), dispatching recovery event...`);
    const eventStore = createEventStore({ dataRoot: config.dataRoot });
    // dispatch crash event to first allowed user (or a default chat if configured)
    const crashNotifyChat = allowlist[0];
    if (crashNotifyChat !== undefined) {
      eventStore.addEvent({
        chatId: crashNotifyChat,
        kind: "daemon_crashed",
        payload: {
          exitCode: crash.exitCode,
          timestamp: crash.timestamp,
          stderr: crash.stderr?.slice(-2000), // limit size
        },
      });
    }
    eventStore.close();
    clearExitInfo(config.dataRoot);
  }

  const messageLogger = createMessageLogger({
    dataRoot: config.dataRoot,
  });

  const sessionStore = new SessionStore(config.paths.sessionsPath);

  // sync cwd on startup (clear sessions if working directory changed)
  sessionStore.syncCwd(process.cwd());

  startScheduler({
    dataRoot: config.dataRoot,
    globalRoot: config.globalRoot,
    transport: transportConfig,
    messageLogger,
    defaultEngine: config.engine,
    engines: config.engines,
    locale: config.locale,
    timezone: config.timezone,
    heartbeat: config.heartbeat,
    dnd: config.dnd,
  });

  // Register bot commands so they show in Telegram's / menu
  await registerTelegramCommands(transportConfig);

  // Check for updates (cached, daily)
  let versionNotice: string | null = null;
  try {
    const versionInfo = await checkForUpdates(config.dataRoot);
    versionNotice = formatVersionContext(versionInfo);
    if (versionNotice) {
      console.log(`update available: ${versionInfo.current} → ${versionInfo.latest}`);
    }
  } catch {
    // Non-fatal - version check is best-effort
  }

  await startTelegramTransport(transportConfig, {
    onReady: () => {
      console.log("telegram transport ready.");
      console.log("bob ready. listening on telegram.");
    },
    onMessage: async (message) => {
      // Handle /start command - Telegram bot init greeting
      if (isStartCommand(message.text)) {
        await sendTelegramMessage(
          transportConfig,
          message.chatId,
          "hey! send me a message and i'll get to work.",
          { threadId: message.threadId },
        );
        return;
      }

      // Handle /agent command - toggle between claude and codex
      if (isAgentCommand(message.text)) {
        const chatDefault = sessionStore.getDefaultEngine(message.chatId);
        const current = chatDefault ?? config.engine;
        const next = current === "claude" ? "codex" : "claude";
        sessionStore.setDefaultEngine(message.chatId, next);
        await sendTelegramMessage(
          transportConfig,
          message.chatId,
          `switched to ${next}`,
          { threadId: message.threadId },
        );
        return;
      }

      // Handle /status command - show engine and upcoming jobs
      if (isStatusCommand(message.text)) {
        const chatDefault = sessionStore.getDefaultEngine(message.chatId);
        const currentEngine = chatDefault ?? config.engine;

        const jobStore = createJobStore({ dataRoot: config.dataRoot });
        const jobs = jobStore.getJobsForChat(message.chatId);
        jobStore.close();

        const lines: string[] = [];
        lines.push(`engine: ${currentEngine}`);

        if (jobs.length > 0) {
          lines.push("");
          lines.push("upcoming:");
          for (const job of jobs.slice(0, 5)) {
            const next = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "pending";
            const prompt = (job.payload as { prompt?: string })?.prompt ?? job.jobType;
            lines.push(`• ${next} - ${prompt.slice(0, 40)}`);
          }
          if (jobs.length > 5) {
            lines.push(`... and ${jobs.length - 5} more`);
          }
        } else {
          lines.push("no scheduled jobs");
        }

        await sendTelegramMessage(
          transportConfig,
          message.chatId,
          lines.join("\n"),
          { threadId: message.threadId },
        );
        return;
      }

      // Parse directives from message (e.g., /claude, /codex)
      const { engine: directiveEngine, text: cleanText } = parseDirectives(message.text);

      // Resolve engine: directive -> chat default -> global default
      const chatDefaultEngine = sessionStore.getDefaultEngine(message.chatId);
      const engine: EngineId = directiveEngine ?? chatDefaultEngine ?? config.engine;

      const history = messageLogger.getRecentMessages({
        chatId: message.chatId,
        threadId: message.threadId,
        limit: DEFAULT_CONTEXT_LIMIT,
      });
      const contextBlock = formatContext(history);

      messageLogger.logMessage({
        chatId: message.chatId,
        threadId: message.threadId,
        role: "user",
        text: message.text,
        messageId: message.messageId,
      });

      let stopTyping: (() => void) | null = null;
      let didReact = false;
      let didAck = false;

      if (ackReaction && message.messageId) {
        didAck = await sendTelegramReaction(
          transportConfig,
          message.chatId,
          message.messageId,
          ackReaction,
        );
      }

      try {
        // Download images if present
        let images: ImageContent[] | undefined;
        if (message.images && message.images.length > 0) {
          images = [];
          for (const img of message.images) {
            const downloaded = await downloadTelegramImage(transportConfig, img);
            images.push(downloaded);
          }
        }

        const prompt = buildPromptFromConfig({
          globalRoot: config.globalRoot,
          memoryRoot: config.paths.memoryRoot,
          skillsRoot: config.paths.skillsRoot,
          userText: cleanText,
          contextBlock,
          chatId: message.chatId,
          messageId: message.messageId,
          locale: config.locale,
          timezone: config.timezone,
          versionNotice,
        });

        const result = await streamAgentReply({
          transport: transportConfig,
          chatId: message.chatId,
          threadId: message.threadId,
          currentMessageId: message.messageId,
          messageLogger,
          onWillSend: () => {
            if (stopTyping) return;
            stopTyping = startTypingIndicator(transportConfig, message.chatId, {
              threadId: message.threadId,
            });
          },
          run: async (onDelta) => {
            if (engine === "codex") {
              const sdkResult = await runCodexSdk({
                prompt,
                images,
                cwd: process.cwd(),
                onDelta,
                yolo: config.engines.codex.yolo,
              });
              return { result: sdkResult.result, actions: sdkResult.actions };
            } else {
              // Default to Claude for claude/opencode/pi
              const sdkResult = await runClaudeSdk({
                prompt,
                images,
                cwd: process.cwd(),
                onDelta,
                skipPermissions: config.engines.claude.skipPermissions,
              });
              return { result: sdkResult.result, actions: sdkResult.actions };
            }
          },
        });

        // Append to daily conversation log
        if (result.responseText) {
          const engineType = engine === "codex" ? "codex" : "claude";
          appendConversation(config.paths.memoryRoot, engineType, {
            userText: cleanText,
            assistantText: result.responseText,
            actions: result.actions,
          });
        }

        didReact = result.didReact;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`SDK error for chat ${message.chatId}: ${errMsg}`);
        await sendTelegramMessage(
          transportConfig,
          message.chatId,
          `something went wrong: ${errMsg}`,
          { threadId: message.threadId },
        );
      } finally {
        const stopTypingFn = stopTyping as (() => void) | null;
        stopTypingFn?.();
        if (didAck && !didReact && message.messageId) {
          await sendTelegramReaction(transportConfig, message.chatId, message.messageId, "");
        }
      }
    },
    onIgnored: (message, reason) => {
      console.log(`Ignored message from ${message.senderId}: ${reason}`);
    },
    onError: (error) => {
      console.error(`Telegram transport error: ${error.message}`);
    },
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
