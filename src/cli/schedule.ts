import { loadConfig, getThreadIdFromEnv } from "../config/load";
import { createJobStore } from "../scheduler/store";
import { parseSchedule } from "../scheduler/schedule";

/**
 * bob schedule "1h" "check deployment"
 * bob schedule --chat-id 123 "1h" "check deployment"
 * bob schedule --chat-id 123 --quote "original msg" --reply-to 456 "1h" "reminder"
 */
export async function schedule(args: string[]): Promise<void> {
  // Parse flags
  let chatIdArg: number | null = null;
  let quotedMessage: string | null = null;
  let replyToMessageId: number | null = null;
  let urgent = false;
  const filteredArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chat-id" && args[i + 1]) {
      chatIdArg = Number(args[i + 1]);
      i++; // skip next arg
    } else if (args[i] === "--quote" && args[i + 1]) {
      quotedMessage = args[i + 1] ?? null;
      i++;
    } else if (args[i] === "--reply-to" && args[i + 1]) {
      replyToMessageId = Number(args[i + 1]);
      i++;
    } else if (args[i] === "--urgent") {
      urgent = true;
    } else {
      filteredArgs.push(args[i] ?? "");
    }
  }

  if (filteredArgs.length < 2) {
    console.log(`Usage: bob schedule [options] <time> <prompt>

Options:
  --chat-id <id>     Target chat ID (or use BOB_CHAT_ID env var)
  --quote <text>     Original user message to quote when delivering
  --reply-to <id>    Message ID to reply to when delivering
  --urgent           Bypass DND for critical alerts

Examples:
  bob schedule "1h" "check deployment status"
  bob schedule "30m" "follow up on build"
  bob schedule "tomorrow at 9am" "morning review"
  bob schedule "every day at 9am" "daily standup"
  bob schedule "every monday at 10am" "weekly planning"
  bob schedule --quote "user's request" --reply-to 789 "1h" "reminder"
`);
    return;
  }

  const timeSpec = filteredArgs[0] ?? "";
  const prompt = filteredArgs.slice(1).join(" ");

  const config = await loadConfig();

  // Get chat ID from flag, env var, or error
  const chatIdFromEnv = process.env.BOB_CHAT_ID ? Number(process.env.BOB_CHAT_ID) : null;
  const chatId = chatIdArg ?? chatIdFromEnv;

  if (!chatId || !Number.isFinite(chatId)) {
    throw new Error("No chat ID. Use --chat-id <id> or run from a bob context.");
  }

  const threadId = getThreadIdFromEnv();

  const parsed = parseSchedule(timeSpec);
  if (!parsed) {
    throw new Error(`Unable to parse schedule: "${timeSpec}"`);
  }

  const store = createJobStore({ dataRoot: config.dataRoot });
  try {
    const payload: { prompt: string; quotedMessage?: string; replyToMessageId?: number; urgent?: boolean } = { prompt };
    if (quotedMessage) {
      payload.quotedMessage = quotedMessage;
    }
    if (replyToMessageId && Number.isFinite(replyToMessageId)) {
      payload.replyToMessageId = replyToMessageId;
    }
    if (urgent) {
      payload.urgent = true;
    }

    const job = store.addJob({
      chatId,
      threadId,
      scheduleKind: parsed.kind,
      scheduleSpec: parsed.spec,
      jobType: "agent_turn",
      payload,
    });

    console.log(`Scheduled job #${job.id} (${parsed.kind}: ${parsed.spec})`);
    console.log(`Next run: ${job.nextRunAt}`);
  } finally {
    store.close();
  }
}
