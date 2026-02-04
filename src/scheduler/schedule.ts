import { parseExpression } from "cron-parser";
import type { ScheduleKind } from "./types";

const DURATION_RE = /^(\d+)(s|m|h|d)$/i;
const EVERY_DURATION_RE = /^every\s+(\d+)(s|m|h|d)$/i;

// Natural language patterns
const RELATIVE_TIME_RE = /^(?:in\s+)?(\d+)\s*(second|minute|hour|day|week)s?$/i;
const EVERY_NATURAL_RE = /^every\s+(day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+(\d{1,2})(:\d{2})?\s*(am|pm)?$/i;
const TOMORROW_RE = /^tomorrow\s+(?:at\s+)?(\d{1,2})(:\d{2})?\s*(am|pm)?$/i;
const TODAY_RE = /^today\s+(?:at\s+)?(\d{1,2})(:\d{2})?\s*(am|pm)?$/i;
const EXACT_TIME_RE = /^(?:at\s+)?(\d{1,2})(:\d{2})?\s*(am|pm)$/i;
const CRON_PREFIX_RE = /^cron\s+(.+)$/i;

export type ParsedSchedule = {
  kind: ScheduleKind;
  spec: string;
};

/**
 * Parse a schedule string into kind and spec.
 * Supports:
 * - "3m", "1h", "30s" - one-time delay
 * - "in 3 minutes", "in 1 hour" - natural language delay
 * - "8:05am", "3pm", "at 5:30pm" - exact time (today or tomorrow if passed)
 * - "today at 9am", "today 5:30pm" - explicit today
 * - "tomorrow at 9am", "tomorrow 8pm" - explicit tomorrow
 * - "every 3m", "every 1h" - recurring interval
 * - "every day at 9am" - recurring daily
 * - "every monday at 10am" - recurring weekly
 * - "cron 0 9 * * *" - cron expression
 * - ISO date string - one-time at specific time
 */
export function parseSchedule(input: string): ParsedSchedule | null {
  const trimmed = input.trim();

  // Check for cron prefix
  const cronMatch = trimmed.match(CRON_PREFIX_RE);
  if (cronMatch?.[1]) {
    return { kind: "cron", spec: cronMatch[1].trim() };
  }

  // Check for "every 3m" - recurring
  const everyDurationMatch = trimmed.match(EVERY_DURATION_RE);
  if (everyDurationMatch?.[1] && everyDurationMatch[2]) {
    return { kind: "every", spec: `${everyDurationMatch[1]}${everyDurationMatch[2].toLowerCase()}` };
  }

  // Check for bare duration "3m", "1h" - one-time delay
  const durationMatch = trimmed.match(DURATION_RE);
  if (durationMatch?.[1] && durationMatch[2]) {
    const ms = parseDurationToMs(trimmed);
    const runAt = new Date(Date.now() + ms);
    return { kind: "at", spec: runAt.toISOString() };
  }

  // Check for natural relative time "in 3 minutes", "1 hour" - one-time delay
  const relativeMatch = trimmed.match(RELATIVE_TIME_RE);
  if (relativeMatch?.[1] && relativeMatch[2]) {
    const value = Number(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    const shortUnit = unit.startsWith("second")
      ? "s"
      : unit.startsWith("minute")
        ? "m"
        : unit.startsWith("hour")
          ? "h"
          : unit.startsWith("day")
            ? "d"
            : unit.startsWith("week")
              ? "d"
              : null;

    if (shortUnit) {
      const multiplier = unit.startsWith("week") ? value * 7 : value;
      const ms = parseDurationToMs(`${multiplier}${shortUnit}`);
      const runAt = new Date(Date.now() + ms);
      return { kind: "at", spec: runAt.toISOString() };
    }
  }

  // Check for "every day/week/monday at time"
  const everyNaturalMatch = trimmed.match(EVERY_NATURAL_RE);
  if (everyNaturalMatch?.[1] && everyNaturalMatch[2]) {
    const frequency = everyNaturalMatch[1].toLowerCase();
    let hour = Number(everyNaturalMatch[2]);
    const minuteStr = everyNaturalMatch[3];
    const minute = minuteStr ? Number(minuteStr.slice(1)) : 0;
    const ampm = everyNaturalMatch[4]?.toLowerCase();

    // Handle AM/PM
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;

    // Build cron expression
    let cronSpec: string;
    switch (frequency) {
      case "day":
        cronSpec = `${minute} ${hour} * * *`;
        break;
      case "week":
      case "monday":
        cronSpec = `${minute} ${hour} * * 1`;
        break;
      case "tuesday":
        cronSpec = `${minute} ${hour} * * 2`;
        break;
      case "wednesday":
        cronSpec = `${minute} ${hour} * * 3`;
        break;
      case "thursday":
        cronSpec = `${minute} ${hour} * * 4`;
        break;
      case "friday":
        cronSpec = `${minute} ${hour} * * 5`;
        break;
      case "saturday":
        cronSpec = `${minute} ${hour} * * 6`;
        break;
      case "sunday":
        cronSpec = `${minute} ${hour} * * 0`;
        break;
      case "month":
        cronSpec = `${minute} ${hour} 1 * *`;
        break;
      default:
        return null;
    }

    return { kind: "cron", spec: cronSpec };
  }

  // Check for "tomorrow at time"
  const tomorrowMatch = trimmed.match(TOMORROW_RE);
  if (tomorrowMatch) {
    let hour = Number(tomorrowMatch[1]);
    const minuteStr = tomorrowMatch[2];
    const minute = minuteStr ? Number(minuteStr.slice(1)) : 0;
    const ampm = tomorrowMatch[3]?.toLowerCase();

    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(hour, minute, 0, 0);

    return { kind: "at", spec: tomorrow.toISOString() };
  }

  // Check for "today at time"
  const todayMatch = trimmed.match(TODAY_RE);
  if (todayMatch) {
    let hour = Number(todayMatch[1]);
    const minuteStr = todayMatch[2];
    const minute = minuteStr ? Number(minuteStr.slice(1)) : 0;
    const ampm = todayMatch[3]?.toLowerCase();

    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;

    const today = new Date();
    today.setHours(hour, minute, 0, 0);

    // If the time has already passed today, schedule for tomorrow
    if (today.getTime() <= Date.now()) {
      today.setDate(today.getDate() + 1);
    }

    return { kind: "at", spec: today.toISOString() };
  }

  // Check for exact time "8:05am", "3pm", "at 5:30pm"
  const exactTimeMatch = trimmed.match(EXACT_TIME_RE);
  if (exactTimeMatch) {
    let hour = Number(exactTimeMatch[1]);
    const minuteStr = exactTimeMatch[2];
    const minute = minuteStr ? Number(minuteStr.slice(1)) : 0;
    const ampm = exactTimeMatch[3]?.toLowerCase();

    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;

    const target = new Date();
    target.setHours(hour, minute, 0, 0);

    // If the time has already passed today, schedule for tomorrow
    if (target.getTime() <= Date.now()) {
      target.setDate(target.getDate() + 1);
    }

    return { kind: "at", spec: target.toISOString() };
  }

  // Try parsing as ISO date
  const date = new Date(trimmed);
  if (!Number.isNaN(date.getTime())) {
    return { kind: "at", spec: date.toISOString() };
  }

  return null;
}

function parseDurationToMs(spec: string): number {
  const match = spec.trim().match(DURATION_RE);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid duration: ${spec}`);
  }
  const value = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    case "d":
      return value * 86_400_000;
    default:
      throw new Error(`Invalid duration unit: ${unit}`);
  }
}

export function parseEvery(spec: string): number {
  const match = spec.trim().match(DURATION_RE);
  if (!match) {
    throw new Error(`Invalid every spec: ${spec}`);
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  const unit = match[2]?.toLowerCase();
  if (!Number.isFinite(value) || value <= 0 || !unit) {
    throw new Error(`Invalid every spec: ${spec}`);
  }
  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    case "d":
      return value * 86_400_000;
    default:
      throw new Error(`Invalid every spec: ${spec}`);
  }
}

export function parseAt(spec: string): Date {
  const date = new Date(spec);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid at spec: ${spec}`);
  }
  return date;
}

export function computeNextRunAt(kind: ScheduleKind, spec: string, from: Date): Date | null {
  switch (kind) {
    case "at": {
      const date = parseAt(spec);
      if (date.getTime() <= from.getTime()) {
        return new Date(from.getTime());
      }
      return date;
    }
    case "every": {
      const interval = parseEvery(spec);
      return new Date(from.getTime() + interval);
    }
    case "cron": {
      const iterator = parseExpression(spec, { currentDate: from });
      return iterator.next().toDate();
    }
    default:
      return null;
  }
}
