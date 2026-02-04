import { loadConfig } from "../config/load";
import { SessionStore, extractResumeToken } from "../sessions/store";
import type { EngineId } from "../config/types";

/**
 * bob run --chat-id <id> [--resume <token>] [--engine <engine>] "prompt"
 *
 * Internal command used by the daemon to run agent turns.
 */
export async function run(args: string[]): Promise<void> {
  let chatId: number | null = null;
  let threadId: number | null = null;
  let engine: EngineId | null = null;
  let resumeToken: string | null = null;
  let prompt: string | null = null;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--chat-id" && args[i + 1]) {
      chatId = Number(args[++i]);
    } else if (arg === "--thread-id" && args[i + 1]) {
      threadId = Number(args[++i]);
    } else if (arg === "--engine" && args[i + 1]) {
      engine = args[++i] as EngineId;
    } else if (arg === "--resume" && args[i + 1]) {
      resumeToken = args[++i] ?? null;
    } else if (!arg.startsWith("--")) {
      prompt = args.slice(i).join(" ");
      break;
    }
  }

  if (!chatId || !Number.isFinite(chatId)) {
    throw new Error("--chat-id is required");
  }
  if (!prompt) {
    throw new Error("prompt is required");
  }

  const config = await loadConfig();
  engine = engine ?? config.engine;

  // Get resume token from session store if not provided
  const store = new SessionStore(config.paths.sessionsPath);
  if (!resumeToken) {
    const savedToken = store.getResume(chatId, engine);
    if (savedToken) {
      resumeToken = savedToken.value;
    }
  }

  // Build command based on engine
  const { cmd, args: cmdArgs } = buildEngineCommand({
    engine,
    prompt,
    resumeToken,
    skipPermissions: config.engines.claude.skipPermissions,
    yolo: config.engines.codex.yolo,
  });

  console.log(`Running: ${cmd} ${cmdArgs.join(" ").slice(0, 50)}...`);

  // Run the command and capture output
  const proc = Bun.spawn([cmd, ...cmdArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      BOB_CHAT_ID: String(chatId),
      BOB_THREAD_ID: threadId ? String(threadId) : "",
    },
  });

  const decoder = new TextDecoder();
  let fullOutput = "";

  // Stream stdout
  const stdout = proc.stdout;
  if (stdout && typeof stdout !== "number") {
    const reader = stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      fullOutput += text;
      process.stdout.write(text);
    }
  }

  // Get stderr
  const stderrText = await new Response(proc.stderr).text();
  if (stderrText) {
    process.stderr.write(stderrText);
  }

  const exitCode = await proc.exited;

  // Extract and save new resume token
  const newToken = extractResumeToken(fullOutput, engine);
  if (newToken) {
    store.setResume(chatId, { engine, value: newToken });
    console.log(`\nSession saved: ${newToken.slice(0, 16)}...`);
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

type BuildCommandOptions = {
  engine: EngineId;
  prompt: string;
  resumeToken: string | null;
  skipPermissions: boolean;
  yolo: boolean;
};

function buildEngineCommand(options: BuildCommandOptions): { cmd: string; args: string[] } {
  const { engine, prompt, resumeToken, skipPermissions, yolo } = options;

  switch (engine) {
    case "claude": {
      const args = ["-p", "--output-format", "stream-json", "--verbose"];
      if (skipPermissions) {
        args.unshift("--dangerously-skip-permissions");
      }
      if (resumeToken) {
        args.push("--resume", resumeToken);
      }
      args.push("--", prompt);
      return { cmd: "claude", args };
    }

    case "codex": {
      if (resumeToken) {
        // Resume existing session
        return { cmd: "codex", args: ["resume", resumeToken, prompt] };
      }
      const args = ["exec"];
      if (yolo) {
        args.push("--yolo");
      }
      args.push(prompt);
      return { cmd: "codex", args };
    }

    case "opencode": {
      const args = ["-p"];
      if (resumeToken) {
        args.push("--resume", resumeToken);
      }
      args.push(prompt);
      return { cmd: "opencode", args };
    }

    case "pi": {
      const args = ["-p"];
      if (resumeToken) {
        args.push("--resume", resumeToken);
      }
      args.push(prompt);
      return { cmd: "pi", args };
    }

    default:
      throw new Error(`Unknown engine: ${engine}`);
  }
}
