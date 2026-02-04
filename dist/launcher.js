#!/usr/bin/env node

// src/launcher.ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
var args = process.argv.slice(2);
var bunExecutable = process.platform === "win32" ? "bun.exe" : "bun";
var scriptDir = path.dirname(fileURLToPath(import.meta.url));
var cliPath = path.join(scriptDir, "..", "bin", "bob.ts");
async function main() {
  let bunPath = resolveBunPath();
  if (!bunPath) {
    const installed = await installBun();
    if (installed) {
      bunPath = resolveBunPath(true);
    }
  }
  if (!bunPath) {
    printInstallHelp();
    process.exit(1);
  }
  const result = spawnSync(bunPath, [cliPath, ...args], {
    stdio: "inherit",
    env: process.env
  });
  if (typeof result.status === "number") {
    process.exit(result.status);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  process.exit(1);
}
function resolveBunPath(skipPathCheck = false) {
  const envPath = process.env.BOB_BUN_PATH || process.env.BUN_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }
  if (!skipPathCheck && canRun("bun")) {
    return "bun";
  }
  const candidates = [];
  if (process.env.BUN_INSTALL) {
    candidates.push(path.join(process.env.BUN_INSTALL, "bin", bunExecutable));
  }
  candidates.push(path.join(homedir(), ".bun", "bin", bunExecutable));
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  if (skipPathCheck && canRun("bun")) {
    return "bun";
  }
  return null;
}
function canRun(cmd) {
  try {
    const result = spawnSync(cmd, ["--version"], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}
async function installBun() {
  if (process.platform === "win32") {
    const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://bun.sh/install.ps1 | iex"], { stdio: "inherit" });
    return result.status === 0;
  }
  const script = await download("https://bun.sh/install");
  if (!script) {
    return false;
  }
  for (const shell of ["bash", "sh"]) {
    const result = spawnSync(shell, ["-s"], {
      input: script,
      stdio: ["pipe", "inherit", "inherit"],
      env: process.env
    });
    if (result.status === 0) {
      return true;
    }
  }
  return false;
}
async function download(url) {
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
}
function printInstallHelp() {
  if (process.platform === "win32") {
    console.error("Bun is required to run bob.");
    console.error('Install Bun with: powershell -c "irm https://bun.sh/install.ps1 | iex"');
    console.error("Then re-run: bob <command>");
    return;
  }
  console.error("Bun is required to run bob.");
  console.error("Install Bun with: curl -fsSL https://bun.sh/install | bash");
  console.error("Then re-run: bob <command>");
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
