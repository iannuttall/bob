import { existsSync, mkdirSync, readdirSync, symlinkSync, unlinkSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const BOB_SKILLS = path.join(homedir(), ".bob", "skills");
const SDK_SKILL_DIRS = [
  path.join(homedir(), ".claude", "skills"),
  path.join(homedir(), ".agents", "skills"),
];

/**
 * bob sync-skills - symlink bob skills to SDK directories
 */
export async function syncSkills(_args: string[]): Promise<void> {
  if (!existsSync(BOB_SKILLS)) {
    console.error("~/.bob/skills/ not found. run 'bob setup' first.");
    process.exit(1);
  }

  const skills = readdirSync(BOB_SKILLS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  if (skills.length === 0) {
    console.log("no skills found in ~/.bob/skills/");
    return;
  }

  console.log(`syncing ${skills.length} skills to SDK directories...\n`);

  for (const sdkDir of SDK_SKILL_DIRS) {
    // Create SDK skills dir if missing
    if (!existsSync(sdkDir)) {
      mkdirSync(sdkDir, { recursive: true });
    }

    const dirName = sdkDir.replace(homedir(), "~");

    for (const skill of skills) {
      const source = path.join(BOB_SKILLS, skill);
      const target = path.join(sdkDir, skill);
      const relativeSource = path.relative(sdkDir, source);

      try {
        // Remove existing symlink or directory
        if (existsSync(target) || lstatSync(target).isSymbolicLink()) {
          const stat = lstatSync(target);
          if (stat.isSymbolicLink()) {
            unlinkSync(target);
          } else {
            console.log(`  ${dirName}/${skill} - skipped (not a symlink)`);
            continue;
          }
        }
      } catch {
        // Target doesn't exist, that's fine
      }

      try {
        symlinkSync(relativeSource, target);
        console.log(`  ${dirName}/${skill} -> ~/.bob/skills/${skill}`);
      } catch (err) {
        console.error(`  ${dirName}/${skill} - failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  console.log("\ndone.");
}
