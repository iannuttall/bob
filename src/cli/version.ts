/**
 * bob version - show version and check for updates
 */

import { loadConfig } from "../config/load";
import { checkForUpdates, getCurrentVersion } from "../utils/version";

export async function version(_args: string[]): Promise<void> {
  const current = getCurrentVersion();
  console.log(`bob v${current}`);

  try {
    const config = await loadConfig();
    const info = await checkForUpdates(config.dataRoot);

    if (info.latest) {
      if (info.updateAvailable) {
        console.log(`\nupdate available: ${info.current} → ${info.latest}`);
        console.log(`run: npm update -g bob-agent`);
      } else {
        console.log(`\nyou're up to date`);
      }
    } else {
      console.log(`\n(package not published yet)`);
    }
  } catch {
    // Version check failed, just show current
  }
}
