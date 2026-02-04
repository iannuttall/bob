import { writeFileSync, renameSync } from "node:fs";

/**
 * Write JSON data atomically using temp file + rename.
 * Prevents corruption if process crashes mid-write.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tempPath, filePath);
}

/**
 * Write text data atomically using temp file + rename.
 */
export function atomicWriteText(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, content, "utf-8");
  renameSync(tempPath, filePath);
}
