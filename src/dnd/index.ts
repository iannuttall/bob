/**
 * Do Not Disturb module.
 * Manages scheduled quiet hours and adhoc DND periods.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DndConfig = {
  enabled: boolean;
  start: string; // "22:00"
  end: string;   // "08:00"
};

export type AdhocDnd = {
  until: number; // Unix timestamp
  reason?: string;
};

export type DndState = {
  adhoc: AdhocDnd | null;
};

export type DndStatus = {
  active: boolean;
  reason: "scheduled" | "adhoc" | null;
  endsAt: Date | null;
  adhocReason?: string;
};

/**
 * Check if current time is within DND window.
 */
export function isDndActive(
  config: DndConfig,
  dataRoot: string,
  timezone: string,
  now: Date = new Date(),
): DndStatus {
  // Check adhoc first (takes priority)
  const state = loadDndState(dataRoot);
  if (state.adhoc && state.adhoc.until > now.getTime()) {
    return {
      active: true,
      reason: "adhoc",
      endsAt: new Date(state.adhoc.until),
      adhocReason: state.adhoc.reason,
    };
  }

  // Clear expired adhoc
  if (state.adhoc && state.adhoc.until <= now.getTime()) {
    clearAdhocDnd(dataRoot);
  }

  // Check scheduled window
  if (!config.enabled) {
    return { active: false, reason: null, endsAt: null };
  }

  const inWindow = isInTimeWindow(config.start, config.end, now, timezone);
  if (inWindow) {
    const endsAt = getNextWindowEnd(config.end, now, timezone);
    return { active: true, reason: "scheduled", endsAt };
  }

  return { active: false, reason: null, endsAt: null };
}

/**
 * Set adhoc DND for a duration.
 */
export function setAdhocDnd(
  dataRoot: string,
  durationMs: number,
  reason?: string,
): AdhocDnd {
  const until = Date.now() + durationMs;
  const adhoc: AdhocDnd = { until, reason };
  const state: DndState = { adhoc };
  saveDndState(dataRoot, state);
  return adhoc;
}

/**
 * Clear adhoc DND.
 */
export function clearAdhocDnd(dataRoot: string): void {
  saveDndState(dataRoot, { adhoc: null });
}

/**
 * Get current DND state.
 */
export function getDndState(dataRoot: string): DndState {
  return loadDndState(dataRoot);
}

/**
 * Parse duration string like "1h", "30m", "2h30m" to milliseconds.
 */
export function parseDuration(input: string): number | null {
  const normalized = input.toLowerCase().trim();

  // Try "Xh", "Xm", "XhYm" patterns
  const match = normalized.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  if (match && (match[1] || match[2])) {
    const hours = parseInt(match[1] ?? "0", 10);
    const minutes = parseInt(match[2] ?? "0", 10);
    return (hours * 60 + minutes) * 60 * 1000;
  }

  // Try plain number (assume minutes)
  const num = parseInt(normalized, 10);
  if (!Number.isNaN(num) && num > 0) {
    return num * 60 * 1000;
  }

  return null;
}

/**
 * Format duration for display.
 */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
}

// --- Internal helpers ---

function getStatePath(dataRoot: string): string {
  return join(dataRoot, "dnd-state.json");
}

function loadDndState(dataRoot: string): DndState {
  const path = getStatePath(dataRoot);
  if (!existsSync(path)) {
    return { adhoc: null };
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DndState;
  } catch {
    return { adhoc: null };
  }
}

function saveDndState(dataRoot: string, state: DndState): void {
  const path = getStatePath(dataRoot);
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function parseTime(timeStr: string): { hours: number; minutes: number } {
  const [h, m] = timeStr.split(":").map((n) => parseInt(n, 10));
  return { hours: h ?? 0, minutes: m ?? 0 };
}

function isInTimeWindow(
  start: string,
  end: string,
  now: Date,
  timezone: string,
): boolean {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const currentHour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const currentMinute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const currentMinutes = currentHour * 60 + currentMinute;

  const startTime = parseTime(start);
  const endTime = parseTime(end);
  const startMinutes = startTime.hours * 60 + startTime.minutes;
  const endMinutes = endTime.hours * 60 + endTime.minutes;

  // Handle overnight windows (e.g., 22:00 to 08:00)
  if (startMinutes > endMinutes) {
    // Window crosses midnight
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  } else {
    // Window within same day
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
}

function getNextWindowEnd(end: string, now: Date, timezone: string): Date {
  const endTime = parseTime(end);

  const nowParts = getTimeZoneParts(now, timezone);
  const todayEnd = makeDateInTimeZone({
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour: endTime.hours,
    minute: endTime.minutes,
    second: 0,
  }, timezone);

  if (todayEnd.getTime() > now.getTime()) {
    return todayEnd;
  }

  // Build end time for the next day in the target timezone
  const nextDayBase = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 12, 0, 0));
  const nextParts = getTimeZoneParts(nextDayBase, timezone);
  return makeDateInTimeZone({
    year: nextParts.year,
    month: nextParts.month,
    day: nextParts.day,
    hour: endTime.hours,
    minute: endTime.minutes,
    second: 0,
  }, timezone);
}

type TimeZoneParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function getTimeZoneParts(date: Date, timeZone: string): TimeZoneParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: "year" | "month" | "day" | "hour" | "minute" | "second") =>
    parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getTimeZoneParts(date, timeZone);
  const utcTime = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return utcTime - date.getTime();
}

function makeDateInTimeZone(parts: TimeZoneParts, timeZone: string): Date {
  const guess = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ));
  const offset = getTimeZoneOffsetMs(guess, timeZone);
  const adjusted = new Date(guess.getTime() - offset);
  const adjustedOffset = getTimeZoneOffsetMs(adjusted, timeZone);
  if (adjustedOffset !== offset) {
    return new Date(guess.getTime() - adjustedOffset);
  }
  return adjusted;
}
