import { existsSync, unlinkSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import type { MessageLogger } from "../storage/messages";
import type { TelegramTransportConfig } from "../telegram";
import { sendTelegramMessage } from "../telegram";
import { runClaudeSdk, runCodexSdk } from "../runner";
import { buildPromptFromConfig } from "../prompt/system";
import { DEFAULT_CONTEXT_LIMIT, formatContext } from "../prompt/context";
import { processEvents } from "../events/dispatcher";
import { createEventStore } from "../events/store";
import { streamAgentReply } from "../telegram/reply-stream";
import { appendConversation } from "../conversations";
import { computeNextRunAt } from "./schedule";
import { createJobStore } from "./store";
import type { JobRecord, ScriptPayload } from "./types";
import type { EngineId } from "../config/types";
import type { DndConfig } from "../dnd";
import { isDndActive } from "../dnd";

export type SchedulerOptions = {
  dataRoot: string;
  globalRoot: string;
  transport: TelegramTransportConfig;
  messageLogger?: MessageLogger;
  defaultEngine?: EngineId;
  engines?: {
    claude: { skipPermissions: boolean };
    codex: { yolo: boolean };
  };
  locale?: string;
  timezone?: string;
  dnd?: DndConfig;
  heartbeat?: {
    enabled: boolean;
    prompt?: string;
    file?: string;
  };
  pollIntervalMs?: number;
  maxSleepMs?: number;
  wakeDebounceMs?: number;
};

export function startScheduler(options: SchedulerOptions) {
  const store = createJobStore({ dataRoot: options.dataRoot });
  const eventStore = createEventStore({ dataRoot: options.dataRoot });
  const maxSleepMs = options.maxSleepMs ?? options.pollIntervalMs ?? 5 * 60_000;
  const wakeDebounceMs = options.wakeDebounceMs ?? 200;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: ReturnType<typeof watch> | null = null;
  let running = false;
  let stopped = false;
  const pidPath = writeSchedulerPid(options.dataRoot);
  const handleSignal = () => {
    requestWake();
  };

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      if (options.heartbeat?.enabled) {
        await processEvents({
          globalRoot: options.globalRoot,
          dataRoot: options.dataRoot,
          transport: options.transport,
          messageLogger: options.messageLogger,
          eventStore,
          heartbeat: options.heartbeat,
          defaultEngine: options.defaultEngine,
          engines: options.engines,
        });
      }
      for (;;) {
        const now = new Date();
        const due = store.claimDueJobs({ now, limit: 10 });
        console.log(`[scheduler] tick: ${due.length} due jobs at ${now.toISOString()}`);
        if (due.length === 0) {
          break;
        }
        for (const job of due) {
          console.log(`[scheduler] executing job #${job.id}: ${job.jobType}`);
          await executeJob(job, options).then(
            (nextRun) => {
              const nextRunAt = nextRun?.toISOString() ?? job.nextRunAt ?? now.toISOString();
              store.updateAfterRun({
                id: job.id,
                lastRunAt: now.toISOString(),
                nextRunAt,
                enabled: nextRun !== null,
              });
            },
            (error) => {
              console.error(
                `Job ${job.id} failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            },
          );
        }
      }
    } finally {
      running = false;
      scheduleNext();
    }
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    const now = Date.now();
    const hasPendingEvents =
      options.heartbeat?.enabled && eventStore.countPending({ now: new Date(now) }) > 0;
    const nextRunAt = store.getNextRunAt();
    const delay = hasPendingEvents
      ? 0
      : nextRunAt
        ? Math.max(0, nextRunAt.getTime() - now)
        : maxSleepMs;
    const actualDelay = Math.min(delay, maxSleepMs);
    console.log(`[scheduler] next tick in ${Math.round(actualDelay / 1000)}s${nextRunAt ? ` (next job: ${nextRunAt.toISOString()})` : ''}`);
    schedule(actualDelay);
  };

  const requestWake = () => {
    if (stopped) return;
    if (wakeTimer) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      scheduleNext();
    }, wakeDebounceMs);
    if (typeof wakeTimer.unref === "function") {
      wakeTimer.unref();
    }
  };

  try {
    watcher = watch(store.dbPath, { persistent: false }, () => {
      requestWake();
    });
  } catch (error) {
    console.warn(
      `Scheduler watcher disabled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  process.on("SIGUSR1", handleSignal);
  console.log(`[scheduler] started (pid: ${process.pid})`);
  scheduleNext();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
    if (wakeTimer) {
      clearTimeout(wakeTimer);
    }
    watcher?.close();
    store.close();
    eventStore.close();
    process.off("SIGUSR1", handleSignal);
    removeSchedulerPid(pidPath);
  };
}

function writeSchedulerPid(dataRoot: string) {
  const pidPath = path.join(dataRoot, "scheduler.pid");
  try {
    writeFileSync(pidPath, `${process.pid}\n`, "utf-8");
  } catch {
    return null;
  }
  return pidPath;
}

function removeSchedulerPid(pidPath: string | null) {
  if (!pidPath) return;
  try {
    unlinkSync(pidPath);
  } catch {
    // best-effort cleanup
  }
}

async function executeJob(job: JobRecord, options: SchedulerOptions): Promise<Date | null> {
  // Check DND for non-urgent, user-facing jobs
  const payload = job.payload as { urgent?: boolean };
  const isUrgent = payload.urgent === true;
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (!isUrgent && options.dnd && (job.jobType === "send_message" || job.jobType === "agent_turn")) {
    const dndStatus = isDndActive(options.dnd, options.dataRoot, timezone);
    if (dndStatus.active) {
      // Reschedule to when DND ends
      console.log(`[scheduler] job #${job.id} deferred (dnd active until ${dndStatus.endsAt?.toISOString()})`);
      return dndStatus.endsAt;
    }
  }

  if (job.jobType === "send_message") {
    const payload = job.payload as { text?: string; replyToMessageId?: number };
    const text = payload.text ?? "";
    if (!text.trim()) {
      throw new Error("send_message payload missing text");
    }
    const sentMessageId = await sendTelegramMessage(options.transport, job.chatId, text, {
      threadId: job.threadId ?? undefined,
      replyToMessageId: payload.replyToMessageId,
    });
    if (options.messageLogger) {
      options.messageLogger.logMessage({
        chatId: job.chatId,
        threadId: job.threadId ?? undefined,
        role: "assistant",
        text,
        messageId: sentMessageId ?? undefined,
      });
    }
  } else if (job.jobType === "agent_turn") {
    const payload = job.payload as { prompt?: string; replyToMessageId?: number; quotedMessage?: string };
    const rawPrompt = payload.prompt ?? "";
    if (!rawPrompt.trim()) {
      throw new Error("agent_turn payload missing prompt");
    }
    // Frame scheduled prompts so the agent knows this is a reminder it set for the user
    let prompt = `[SCHEDULED REMINDER] You previously scheduled this reminder for the user. Deliver it naturally:\n\n${rawPrompt}`;
    if (payload.quotedMessage) {
      prompt += `\n\n[ORIGINAL USER REQUEST]\n> ${payload.quotedMessage}`;
    }

    // Check contextMode: "isolated" = no context, "session" = load context
    const contextBlock =
      job.contextMode === "isolated" ? null : await loadJobContext(job, options.messageLogger);

    // Load SOUL.md and memory blocks from global root
    const memoryRoot = path.join(options.globalRoot, "memory");
    const fullPrompt = buildPromptFromConfig({
      globalRoot: options.globalRoot,
      memoryRoot,
      userText: prompt,
      contextBlock,
      chatId: job.chatId,
      locale: options.locale,
      timezone: options.timezone,
    });

    const agentResult = await streamAgentReply({
      transport: options.transport,
      chatId: job.chatId,
      threadId: job.threadId ?? undefined,
      currentMessageId: payload.replyToMessageId,
      messageLogger: options.messageLogger,
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
    if (agentResult.responseText) {
      const engineType = options.defaultEngine === "codex" ? "codex" : "claude";
      appendConversation(memoryRoot, engineType, {
        userText: `[SCHEDULED] ${rawPrompt}`,
        assistantText: agentResult.responseText,
        actions: agentResult.actions,
      });
    }
  } else if (job.jobType === "script") {
    const payload = job.payload as ScriptPayload;
    if (!payload.script) {
      throw new Error("script payload missing script path");
    }

    // Resolve script path relative to ~/.bob/scripts/
    const scriptsRoot = path.join(options.globalRoot, "scripts");
    const resolvedScriptsRoot = path.resolve(scriptsRoot);
    const scriptPath = path.resolve(scriptsRoot, payload.script);
    if (
      !scriptPath.startsWith(resolvedScriptsRoot + path.sep) &&
      scriptPath !== resolvedScriptsRoot
    ) {
      throw new Error(`Script path escapes scripts root: ${payload.script}`);
    }

    if (!existsSync(scriptPath)) {
      throw new Error(`Script not found: ${scriptPath}`);
    }

    // Run the script with Bun
    const args = payload.args ?? [];
    const proc = Bun.spawn(["bun", "run", scriptPath, ...args], {
      cwd: scriptsRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        BOB_CHAT_ID: String(job.chatId),
        BOB_THREAD_ID: job.threadId ? String(job.threadId) : "",
      },
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error(`Script ${payload.script} failed (exit ${exitCode}): ${stderr}`);
      if (payload.notify) {
        await sendTelegramMessage(
          options.transport,
          job.chatId,
          `Script failed: ${payload.script}\n${stderr.slice(0, 500)}`,
          { threadId: job.threadId ?? undefined },
        );
      }
    } else if (payload.notify && stdout.trim()) {
      await sendTelegramMessage(options.transport, job.chatId, stdout.slice(0, 4000), {
        threadId: job.threadId ?? undefined,
      });
    }
  } else {
    throw new Error(`Unknown job type: ${job.jobType}`);
  }

  if (job.scheduleKind === "at") {
    return null;
  }
  const next = computeNextRunAt(job.scheduleKind, job.scheduleSpec, new Date());
  return next;
}

async function loadJobContext(job: JobRecord, logger?: MessageLogger): Promise<string | null> {
  if (!logger) {
    return null;
  }
  const history = logger.getRecentMessages({
    chatId: job.chatId,
    threadId: job.threadId ?? undefined,
    limit: DEFAULT_CONTEXT_LIMIT,
  });
  return formatContext(history);
}
