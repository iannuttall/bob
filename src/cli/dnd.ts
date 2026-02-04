/**
 * bob dnd - manage do not disturb
 *
 * Usage:
 *   bob dnd "1h"              Set adhoc DND for 1 hour
 *   bob dnd "30m" "meeting"   Set DND with reason
 *   bob dnd off               Clear adhoc DND
 *   bob dnd status            Show current DND status
 */

import { loadConfig } from "../config/load";
import {
  isDndActive,
  setAdhocDnd,
  clearAdhocDnd,
  parseDuration,
  formatDuration,
} from "../dnd";

export async function dnd(args: string[]): Promise<void> {
  const config = await loadConfig();
  const subcommand = args[0];

  if (!subcommand || subcommand === "status" || subcommand === "help" || subcommand === "--help") {
    await showStatus(config);
    return;
  }

  if (subcommand === "off" || subcommand === "clear") {
    clearAdhocDnd(config.dataRoot);
    console.log("dnd cleared");
    return;
  }

  // Try to parse as duration
  const duration = parseDuration(subcommand);
  if (!duration) {
    console.error(`invalid duration: ${subcommand}`);
    console.error('examples: "1h", "30m", "2h30m"');
    process.exit(1);
  }

  const reason = args.slice(1).join(" ") || undefined;
  const adhoc = setAdhocDnd(config.dataRoot, duration, reason);
  const until = new Date(adhoc.until);

  console.log(`dnd on for ${formatDuration(duration)}`);
  console.log(`until ${until.toLocaleTimeString()}`);
  if (reason) {
    console.log(`reason: ${reason}`);
  }
}

async function showStatus(config: Awaited<ReturnType<typeof loadConfig>>) {
  const status = isDndActive(config.dnd, config.dataRoot, config.timezone);

  if (!status.active) {
    console.log("dnd: off");

    if (config.dnd.enabled) {
      console.log(`\nscheduled window: ${config.dnd.start} - ${config.dnd.end}`);
    } else {
      console.log("\nno scheduled window configured");
    }
    return;
  }

  console.log("dnd: ON");
  console.log(`type: ${status.reason}`);

  if (status.endsAt) {
    console.log(`ends: ${status.endsAt.toLocaleTimeString()}`);
  }

  if (status.adhocReason) {
    console.log(`reason: ${status.adhocReason}`);
  }
}
