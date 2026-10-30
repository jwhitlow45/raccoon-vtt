import { compareLogIds } from "#shared/keys.ts";
import type { LogEntry } from "#shared/model.ts";
import type { CorrectionLogEvent } from "#shared/undoContract.ts";

export function correctionText(data: CorrectionLogEvent, dm = false): string {
  const verb = data.from === "undo" ? "undid" : "redid";
  if (dm && data.label) return `The DM ${verb}${data.scope === "setup" ? " setup:" : ""} ${data.label}.`;
  return `The DM ${verb} a ${data.scope} change${data.name ? ` to ${data.name}` : ""}.`;
}

/** Snapshots seed the cursor silently, so reconnect and archive reads never repeat a notice. */
export class CorrectionAnnouncements {
  private seen: string | null = null;
  private loaded = false;

  snapshot(log: readonly LogEntry[]): void {
    this.loaded = true;
    this.advance(log);
  }

  take(log: readonly LogEntry[], dm: boolean): { id: string; text: string }[] {
    if (!this.loaded) return [];
    const fresh = log.filter((line) => this.seen === null || compareLogIds(line.id, this.seen) > 0);
    this.advance(log);
    return fresh.flatMap((line) => {
      const data = line.data as LogEntry["data"] | CorrectionLogEvent;
      return data?.type === "correction" ? [{ id: line.id, text: correctionText(data, dm) }] : [];
    });
  }

  private advance(log: readonly LogEntry[]): void {
    for (const line of log) if (this.seen === null || compareLogIds(line.id, this.seen) > 0) this.seen = line.id;
  }
}
