import { compareLogIds } from "#shared/keys.ts";
import { describeEvent, type LogNames } from "#shared/logText.ts";
import type { LogEntry } from "#shared/model.ts";

/** Snapshots seed the cursor silently, so reconnect and archive reads never repeat a notice. */
export class CorrectionAnnouncements {
  private seen: string | null = null;
  private loaded = false;

  snapshot(log: readonly LogEntry[]): void {
    this.loaded = true;
    this.advance(log);
  }

  take(log: readonly LogEntry[], dm: boolean, names: LogNames): { id: string; text: string }[] {
    if (!this.loaded) return [];
    const fresh = log.filter((line) => this.seen === null || compareLogIds(line.id, this.seen) > 0);
    this.advance(log);
    return fresh.flatMap((line) => {
      const data = line.data;
      return data?.type === "correction" ? [{ id: line.id, text: describeEvent(data, names, dm) }] : [];
    });
  }

  private advance(log: readonly LogEntry[]): void {
    for (const line of log) if (this.seen === null || compareLogIds(line.id, this.seen) > 0) this.seen = line.id;
  }
}
