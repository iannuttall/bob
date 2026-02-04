/**
 * Version checking utilities.
 * Checks npm registry for updates, with fallback for unpublished packages.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_NAME = "bob-agent"; // npm package name
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type VersionInfo = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  lastChecked: number;
};

/**
 * Get current version from package.json
 */
export function getCurrentVersion(): string {
  try {
    // Try to find package.json relative to this file or cwd
    const candidates = [
      join(import.meta.dir, "../../package.json"),
      join(process.cwd(), "package.json"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf-8")) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    }
  } catch {
    // Fall through
  }
  return "0.0.0";
}

/**
 * Fetch latest version from npm registry.
 * Returns null if package not found or network error.
 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = await response.json() as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Compare semver versions. Returns true if b > a.
 */
function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const a = parse(current);
  const b = parse(latest);
  for (let i = 0; i < 3; i++) {
    if ((b[i] ?? 0) > (a[i] ?? 0)) return true;
    if ((b[i] ?? 0) < (a[i] ?? 0)) return false;
  }
  return false;
}

/**
 * Get cached version info from data directory.
 */
function getCachedVersionInfo(dataRoot: string): VersionInfo | null {
  const cachePath = join(dataRoot, "version-check.json");
  if (!existsSync(cachePath)) return null;
  try {
    return JSON.parse(readFileSync(cachePath, "utf-8")) as VersionInfo;
  } catch {
    return null;
  }
}

/**
 * Save version info to cache.
 */
function setCachedVersionInfo(dataRoot: string, info: VersionInfo): void {
  const cachePath = join(dataRoot, "version-check.json");
  try {
    writeFileSync(cachePath, JSON.stringify(info, null, 2));
  } catch {
    // Ignore cache write errors
  }
}

/**
 * Check for updates. Uses cached result if checked recently.
 */
export async function checkForUpdates(dataRoot: string): Promise<VersionInfo> {
  const current = getCurrentVersion();
  const cached = getCachedVersionInfo(dataRoot);
  const now = Date.now();

  // Return cached if recent enough
  if (cached && cached.current === current && now - cached.lastChecked < CHECK_INTERVAL_MS) {
    return cached;
  }

  // Fetch latest
  const latest = await fetchLatestVersion();
  const updateAvailable = latest !== null && isNewer(current, latest);

  const info: VersionInfo = {
    current,
    latest,
    updateAvailable,
    lastChecked: now,
  };

  setCachedVersionInfo(dataRoot, info);
  return info;
}

/**
 * Format version info for display in session context.
 */
export function formatVersionContext(info: VersionInfo): string | null {
  if (!info.updateAvailable || !info.latest) return null;
  return `UPDATE AVAILABLE: bob ${info.current} → ${info.latest}. Offer to upgrade with: npm update -g ${PACKAGE_NAME}`;
}
