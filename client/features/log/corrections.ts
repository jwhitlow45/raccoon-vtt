import { compareLogIds } from "#shared/keys.ts";
import { describeEvent, type LogNames } from "#shared/logText.ts";
import type { LogEntry } from "#shared/model.ts";
import { SAVE_CANNOT_REOPEN } from "#shared/saveOutcomeContract.ts";
import type { CorrectionLogEvent } from "#shared/undoContract.ts";

/** `cut` marks a label the server may have shortened to fit a note after it, so it matches as the start of the correction's label. */
export type OwnCorrection = Pick<CorrectionLogEvent, "from" | "scope" | "label"> & { cut?: true };

/** The correction an own Undo or Redo result names: its label without the note that its save can no longer reopen. */
export function ownCorrection(from: OwnCorrection["from"], scope: OwnCorrection["scope"], what: string): OwnCorrection {
  return what.endsWith(SAVE_CANNOT_REOPEN) ? { from, scope, label: what.slice(0, -SAVE_CANNOT_REOPEN.length), cut: true } : { from, scope, label: what };
}

/** Snapshots seed the cursor silently, so reconnect and archive reads never repeat a notice. */
export class CorrectionAnnouncements {
  private seen: string | null = null;
  private loaded = false;

  snapshot(log: readonly LogEntry[]): void {
    this.loaded = true;
    this.advance(log);
  }

  take(log: readonly LogEntry[], dm: boolean, names: LogNames, own: readonly OwnCorrection[] = []): { id: string; text: string }[] {
    if (!this.loaded) return [];
    const fresh = log.filter((line) => this.seen === null || compareLogIds(line.id, this.seen) > 0);
    this.advance(log);
    const remaining = [...own];
    return fresh.flatMap((line) => {
      const data = line.data;
      if (data?.type !== "correction") return [];
      const index = remaining.findIndex((match) => match.from === data.from && match.scope === data.scope && (match.label === data.label || match.cut === true && match.label !== undefined && data.label?.startsWith(match.label) === true));
      if (index >= 0) {
        remaining.splice(index, 1);
        return [];
      }
      return [{ id: line.id, text: describeEvent(data, names, dm) }];
    });
  }

  private advance(log: readonly LogEntry[]): void {
    for (const line of log) if (this.seen === null || compareLogIds(line.id, this.seen) > 0) this.seen = line.id;
  }
}
