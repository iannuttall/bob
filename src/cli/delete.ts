import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isCancel, text } from "@clack/prompts";

const LABEL = "com.bob.daemon";

export async function deleteCommand(args: string[]): Promise<void> {
  const force = args.includes("--force") || args.includes("-f");
  const keepPackage = args.includes("--keep") || args.includes("--keep-package");
  const globalRoot = path.join(homedir(), ".bob");

  if (!force) {
    const typed = await text({
      message: `Type \"delete\" to remove all bob data at ${globalRoot}${keepPackage ? "" : " and uninstall bob-agent"}`,
      placeholder: "delete",
      validate: (value) =>
        value.trim().toLowerCase() === "delete" ? undefined : 'type "delete" to confirm',
    });
    if (isCancel(typed)) {
      console.log("Aborted.");
      return;
    }
  }

  // Stop daemon on macOS if present
  if (process.platform === "darwin") {
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : null;
      if (uid !== null && uid !== undefined) {
        execFileSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
      }
    } catch {
      // ignore if not loaded
    }

    try {
      const plistFile = path.join(
        homedir(),
        "Library",
        "LaunchAgents",
        `${LABEL}.plist`,
      );
      if (existsSync(plistFile)) {
        rmSync(plistFile);
      }
    } catch {
      // ignore
    }
  }

  // Remove bob root
  if (existsSync(globalRoot)) {
    rmSync(globalRoot, { recursive: true, force: true });
  }

  console.log("bob data deleted.");

  if (!keepPackage) {
    try {
      console.log("uninstalling bob-agent (npm -g)...");
      execFileSync("npm", ["uninstall", "-g", "bob-agent"], { stdio: "inherit" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`npm uninstall failed: ${msg}`);
      console.log("you can run: npm uninstall -g bob-agent");
    }
  }
}
