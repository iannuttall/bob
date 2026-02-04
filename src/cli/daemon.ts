import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadConfig } from "../config/load";

const LABEL = "com.bob.daemon";

/**
 * Daemon management commands
 */
export const daemon = {
  /**
   * bob start - Install and start daemon
   */
  async start(_args: string[]): Promise<void> {
    ensureDarwin();
    if (!hasLaunchctl()) {
      throw new Error("launchctl not found. this command requires macOS.");
    }

    const config = await loadConfig();

    if (!config.telegram.token) {
      throw new Error("no telegram token found. run 'bob setup' first.");
    }

    const plist = buildPlist(config.globalRoot);
    const plistFile = plistPath();

    mkdirSync(path.dirname(plistFile), { recursive: true });
    writeFileSync(plistFile, plist, "utf-8");

    const target = launchTarget();

    // stop if already running
    try {
      execFileSync("launchctl", ["bootout", `${target}/${LABEL}`], { stdio: "ignore" });
    } catch {
      // ignore if not loaded
    }

    // install and start
    execFileSync("launchctl", ["bootstrap", target, plistFile], { stdio: "inherit" });
    execFileSync("launchctl", ["enable", `${target}/${LABEL}`], { stdio: "ignore" });
    execFileSync("launchctl", ["kickstart", "-k", `${target}/${LABEL}`], { stdio: "ignore" });

    // get bot username for friendly message
    const botName = await getBotUsername(config.telegram.token);

    console.log();
    if (botName) {
      console.log(`bob is running. message @${botName} on telegram.`);
    } else {
      console.log(`bob is running. message your bot on telegram.`);
    }
    console.log();
  },

  /**
   * bob stop - Stop daemon
   */
  async stop(_args: string[]): Promise<void> {
    ensureDarwin();
    if (!hasLaunchctl()) {
      throw new Error("launchctl not found. This command requires macOS.");
    }

    const target = launchTarget();
    const plistFile = plistPath();

    try {
      execFileSync("launchctl", ["bootout", `${target}/${LABEL}`], { stdio: "ignore" });
    } catch {
      // ignore if already stopped
    }

    if (existsSync(plistFile)) {
      rmSync(plistFile);
    }

    console.log(`bob daemon stopped`);
  },

  /**
   * bob restart - Restart daemon
   */
  async restart(_args: string[]): Promise<void> {
    await daemon.stop(_args);
    await daemon.start(_args);
  },

  /**
   * bob logs - Tail daemon logs
   */
  async logs(_args: string[]): Promise<void> {
    const config = await loadConfig();
    const logsDir = config.paths.logsRoot;

    const stdoutLog = path.join(logsDir, "stdout.log");
    const stderrLog = path.join(logsDir, "stderr.log");

    if (!existsSync(stdoutLog) && !existsSync(stderrLog)) {
      console.log("No log files found. Daemon may not have started yet.");
      console.log(`Expected logs at: ${logsDir}`);
      return;
    }

    // Use tail -f to follow logs
    const logFile = existsSync(stderrLog) ? stderrLog : stdoutLog;
    console.log(`Tailing ${logFile} (Ctrl+C to exit)\n`);

    const tail = spawn("tail", ["-f", "-n", "50", logFile], {
      stdio: "inherit",
    });

    await new Promise<void>((resolve) => {
      tail.on("close", () => resolve());
    });
  },
};

function ensureDarwin() {
  if (process.platform !== "darwin") {
    throw new Error("launchd is only available on macOS.");
  }
}

function hasLaunchctl(): boolean {
  try {
    execFileSync("which", ["launchctl"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function launchTarget(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null || uid === undefined) {
    throw new Error("Unable to resolve uid for launchd target.");
  }
  return `gui/${uid}`;
}

function plistPath(): string {
  return path.join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function buildPlist(globalRoot: string): string {
  const bunPath = process.execPath;
  // Find the bob source directory - this script is in src/cli/daemon.ts
  // so go up to find the project root
  const thisFile = new URL(import.meta.url).pathname;
  const projectRoot = path.resolve(path.dirname(thisFile), "..", "..");
  const mainScript = path.join(projectRoot, "src", "index.ts");
  const logsDir = path.join(globalRoot, "logs");
  const stdoutPath = path.join(logsDir, "stdout.log");
  const stderrPath = path.join(logsDir, "stderr.log");

  mkdirSync(logsDir, { recursive: true });

  // The plist runs the main bob process
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(bunPath)}</string>
    <string>run</string>
    <string>${escapeXml(mainScript)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(path.dirname(mainScript))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function getBotUsername(token: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await resp.json()) as { ok: boolean; result?: { username: string } };
    if (data.ok && data.result?.username) {
      return data.result.username;
    }
  } catch {
    // ignore
  }
  return null;
}
