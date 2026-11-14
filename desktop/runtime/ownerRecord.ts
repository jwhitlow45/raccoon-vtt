import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeDurable } from "./durable.ts";
import type { ProcessIdentity } from "./processInfo.ts";

/**
 * supervisor.json, the owner record (docs/design/design-v1-local-app.md 8.1):
 * the pid, start time and boot of the supervisor that holds the lock, and
 * the lock's path. A starting supervisor that got the lock but finds a
 * record whose process still runs stops as "already running": that covers
 * two locks that differ, when the folder's canonical path changed between
 * two starts. It also decides whether a PostgreSQL left running may be
 * stopped (D-261113-093).
 */

const OwnerRecord = z.object({
  pid: z.number().int().positive(),
  start: z.number().int().nonnegative(),
  boot: z.string(),
  lock: z.string(),
});
export type OwnerRecord = z.infer<typeof OwnerRecord>;

/** The record, null when there is none, or "unreadable" for a damaged file. */
export async function readOwner(file: string): Promise<OwnerRecord | null | "unreadable"> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed = OwnerRecord.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : "unreadable";
  } catch {
    return "unreadable";
  }
}

export async function writeOwner(file: string, self: ProcessIdentity, lock: string): Promise<void> {
  const record: OwnerRecord = { pid: self.pid, start: self.start, boot: self.boot, lock };
  await writeDurable(file, `${JSON.stringify(record)}\n`);
}
