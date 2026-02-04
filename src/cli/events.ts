import { readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, getThreadIdFromEnv } from "../config/load";
import { createEventStore } from "../events/store";

/**
 * bob event "task_done" '{"result": "..."}'
 * bob event --chat-id 123 "task_done" '{"result": "..."}'
 */
export async function event(args: string[]): Promise<void> {
  // Parse --chat-id flag
  let chatIdArg: number | null = null;
  const filteredArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chat-id" && args[i + 1]) {
      chatIdArg = Number(args[i + 1]);
      i++; // skip next arg
    } else {
      filteredArgs.push(args[i] ?? "");
    }
  }

  if (filteredArgs.length < 1) {
    console.log(`Usage: bob event [--chat-id <id>] <kind> [payload]

Examples:
  bob event "task_done" '{"result": "completed"}'
  bob event "scrape_failed" '{"error": "timeout"}'
  bob event "deploy_started"
  bob event --chat-id 123456 "task_done" '{"result": "ok"}'
`);
    return;
  }

  const kind = filteredArgs[0] ?? "";
  const payloadRaw = filteredArgs[1] ?? "{}";

  const config = await loadConfig();

  // Get chat ID from flag, env var, or error
  const chatIdFromEnv = process.env.BOB_CHAT_ID ? Number(process.env.BOB_CHAT_ID) : null;
  const chatId = chatIdArg ?? chatIdFromEnv;

  if (!chatId || !Number.isFinite(chatId)) {
    throw new Error("No chat ID. Use --chat-id <id> or run from a bob context.");
  }

  const threadId = getThreadIdFromEnv();

  const store = createEventStore({ dataRoot: config.dataRoot });
  try {
    const eventRecord = store.addEvent({
      chatId,
      threadId,
      kind,
      payload: payloadRaw,
    });

    console.log(`Event #${eventRecord.id} added (kind: ${kind})`);

    // Signal scheduler to wake up
    signalScheduler(config.dataRoot);
  } finally {
    store.close();
  }
}

/**
 * bob events list [--all]
 */
export async function events(args: string[]): Promise<void> {
  const includeProcessed = args.includes("--all");

  const config = await loadConfig();
  const store = createEventStore({ dataRoot: config.dataRoot });

  try {
    const eventsList = store.listEvents({ includeProcessed });
    if (eventsList.length === 0) {
      console.log(includeProcessed ? "No events." : "No pending events.");
      return;
    }

    console.log(includeProcessed ? "All events:\n" : "Pending events:\n");
    for (const evt of eventsList) {
      const status = evt.processedAt ? "processed" : "pending";
      const created = new Date(evt.createdAt).toLocaleString();
      const processed = evt.processedAt ? new Date(evt.processedAt).toLocaleString() : "-";
      const payloadStr =
        typeof evt.payload === "object" ? JSON.stringify(evt.payload) : String(evt.payload);
      const preview = payloadStr.length > 50 ? `${payloadStr.slice(0, 50)}...` : payloadStr;

      console.log(`#${evt.id} [${status}] ${evt.kind}`);
      console.log(`  Chat: ${evt.chatId}${evt.threadId ? ` (thread ${evt.threadId})` : ""}`);
      console.log(`  Created: ${created}`);
      if (evt.processedAt) {
        console.log(`  Processed: ${processed}`);
      }
      console.log(`  Payload: ${preview}`);
      console.log();
    }
  } finally {
    store.close();
  }
}

function signalScheduler(dataRoot: string) {
  const pidPath = path.join(dataRoot, "scheduler.pid");
  try {
    const pid = Number(readFileSync(pidPath, "utf-8").trim());
    if (Number.isFinite(pid)) {
      process.kill(pid, "SIGUSR1");
    }
  } catch {
    // best-effort only
  }
}
