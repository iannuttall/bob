import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loadConfig } from "../config/load";

type CheckStatus = "ok" | "warn" | "fail";

type CheckResult = {
  status: CheckStatus;
  label: string;
  detail?: string;
};

export async function doctor(_args: string[]): Promise<void> {
  const results: CheckResult[] = [];

  // Basic config presence
  const config = await loadConfig();
  const configPath = config.paths.configPath;
  if (existsSync(configPath)) {
    results.push({ status: "ok", label: "config", detail: configPath });
  } else {
    results.push({
      status: "fail",
      label: "config",
      detail: "missing ~/.bob/config.toml (run: bob setup)",
    });
  }

  // Token checks
  const token = config.telegram.token ?? process.env.BOB_TELEGRAM_TOKEN;
  if (!token) {
    results.push({
      status: "fail",
      label: "telegram token",
      detail: "missing telegram.token (run: bob setup)",
    });
  } else {
    const info = await getTelegramMe(token);
    if (info.ok) {
      const username = info.username ? `@${info.username}` : "unknown";
      results.push({ status: "ok", label: "telegram token", detail: username });
    } else {
      results.push({
        status: "fail",
        label: "telegram token",
        detail: info.error ?? "invalid token",
      });
    }
  }

  // Allowlist checks
  if (config.telegram.allowlist.length === 0) {
    results.push({
      status: "warn",
      label: "allowlist",
      detail: "empty (anyone can message the bot)",
    });
  } else {
    results.push({
      status: "ok",
      label: "allowlist",
      detail: `${config.telegram.allowlist.length} user(s)`,
    });
  }

  // Logs directory
  if (existsSync(config.paths.logsRoot)) {
    results.push({ status: "ok", label: "logs", detail: config.paths.logsRoot });
  } else {
    results.push({ status: "warn", label: "logs", detail: "logs directory missing" });
  }

  // LaunchAgent status (macOS only)
  if (process.platform === "darwin") {
    const launchStatus = getLaunchdStatus();
    if (launchStatus === "running") {
      results.push({ status: "ok", label: "launchd", detail: "running" });
    } else if (launchStatus === "loaded") {
      results.push({ status: "warn", label: "launchd", detail: "loaded (not running)" });
    } else if (launchStatus === "missing") {
      results.push({ status: "warn", label: "launchd", detail: "not loaded (run: bob start)" });
    } else {
      results.push({ status: "warn", label: "launchd", detail: "unknown status" });
    }
  }

  // Output
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const result of results) {
    counts[result.status]++;
    const tag = result.status === "ok" ? "[ok]" : result.status === "warn" ? "[warn]" : "[fail]";
    const detail = result.detail ? ` - ${result.detail}` : "";
    console.log(`${tag} ${result.label}${detail}`);
  }

  console.log("");
  console.log(`Summary: ${counts.ok} ok, ${counts.warn} warn, ${counts.fail} fail`);

  if (counts.fail > 0) {
    process.exit(1);
  }
}

async function getTelegramMe(
  token: string,
): Promise<{ ok: true; username?: string } | { ok: false; error?: string }> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await resp.json()) as { ok: boolean; result?: { username?: string }; description?: string };
    if (!data.ok) {
      return { ok: false, error: data.description ?? "telegram api error" };
    }
    return { ok: true, username: data.result?.username };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: msg };
  }
}

type LaunchStatus = "running" | "loaded" | "missing" | "unknown";

function getLaunchdStatus(): LaunchStatus {
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid === null) return "unknown";
    const label = "com.bob.daemon";
    const target = `gui/${uid}`;
    try {
      const output = execFileSync("launchctl", ["print", `${target}/${label}`], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (/state = running/.test(output)) return "running";
      return "loaded";
    } catch {
      // fallback to launchctl list
    }

    const list = execFileSync("launchctl", ["list"], { encoding: "utf-8" });
    if (list.includes(label)) return "loaded";
    return "missing";
  } catch {
    return "unknown";
  }
}
