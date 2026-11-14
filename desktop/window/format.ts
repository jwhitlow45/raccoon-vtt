/**
 * Dates, times and sizes as the window words them (design 9, Exact words):
 * "today at 7:42 PM", "Last played 2 days ago", "Free at least 1.4 GB".
 * Each takes the clock as an argument, so a test fixes it.
 */

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function startOfDay(t: Date): number {
  return new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
}

/** Whole calendar days from `then` to `now`, by the computer's own calendar. */
export function calendarDaysBetween(then: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
}

/** "today at 7:42 PM", "yesterday at 7:42 PM", "Nov 9 at 7:42 PM", with the year once it is not this one's. */
export function formatWhen(iso: string, now: Date): string {
  const then = new Date(iso);
  const days = calendarDaysBetween(then, now);
  const time = TIME.format(then);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  const day = then.getFullYear() === now.getFullYear() ? DAY.format(then) : DAY_YEAR.format(then);
  return `${day} at ${time}`;
}

/** A backup's date inside a sentence: "Nov 9 at 7:42 PM", never "today", since the sentence may be read later. */
export function formatDate(iso: string, now: Date): string {
  const then = new Date(iso);
  const day = then.getFullYear() === now.getFullYear() ? DAY.format(then) : DAY_YEAR.format(then);
  return `${day} at ${TIME.format(then)}`;
}

/** "just now", "5 minutes ago", "2 hours ago", "yesterday", "3 days ago", then a date. */
export function formatRelative(iso: string, now: Date): string {
  const then = new Date(iso);
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const days = calendarDaysBetween(then, now);
  if (days === 0) {
    const hours = Math.floor(minutes / 60);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return then.getFullYear() === now.getFullYear() ? DAY.format(then) : DAY_YEAR.format(then);
}

/** Bytes as the biggest unit that keeps one to three digits before the point, rounded up so "free at least" holds. */
export function formatSize(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  if (unit === 0) return `${Math.ceil(value)} bytes`;
  const rounded = value < 10 ? Math.ceil(value * 10) / 10 : Math.ceil(value);
  return `${rounded} ${units[unit]}`;
}
