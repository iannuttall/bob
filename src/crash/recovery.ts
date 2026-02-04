import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type LastExitInfo = {
  exitCode: number;
  timestamp: string;
  stderr?: string;
};

/**
 * Write exit info before shutting down
 */
export function writeExitInfo(dataRoot: string, exitCode: number) {
  const infoPath = path.join(dataRoot, "last_exit.json");
  const info: LastExitInfo = {
    exitCode,
    timestamp: new Date().toISOString(),
  };
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(infoPath, JSON.stringify(info, null, 2));
}

/**
 * Check for crash on startup and return info if crashed
 */
export function checkForCrash(dataRoot: string, logsRoot: string): LastExitInfo | null {
  const infoPath = path.join(dataRoot, "last_exit.json");

  if (!existsSync(infoPath)) {
    return null;
  }

  try {
    const raw = readFileSync(infoPath, "utf-8");
    const info = JSON.parse(raw) as LastExitInfo;

    // clean exit = 0, SIGINT (130), SIGTERM (143) are not crashes
    if (info.exitCode === 0 || info.exitCode === 130 || info.exitCode === 143) {
      return null;
    }

    // try to read last lines of stderr
    const stderrPath = path.join(logsRoot, "stderr.log");
    if (existsSync(stderrPath)) {
      try {
        const stderr = readFileSync(stderrPath, "utf-8");
        const lines = stderr.trim().split("\n");
        info.stderr = lines.slice(-50).join("\n"); // last 50 lines
      } catch {
        // ignore
      }
    }

    return info;
  } catch {
    return null;
  }
}

/**
 * Clear the last exit info (call after handling crash)
 */
export function clearExitInfo(dataRoot: string) {
  // write clean exit
  writeExitInfo(dataRoot, 0);
}
