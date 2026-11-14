import { readFile } from "node:fs/promises";
import { RestoreJournal } from "../contract.ts";
import { removeDurable, writeDurable } from "./durable.ts";

/**
 * restore.json, the restore journal (docs/design/design-v1-local-app.md 8.3):
 * the only file a restore depends on. A journal that cannot be read counts
 * as none. The next start never takes its word over the databases', so the
 * worst a damaged journal does is choose undo over finish.
 */

export async function readJournal(file: string): Promise<RestoreJournal | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed = RestoreJournal.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeJournal(file: string, journal: RestoreJournal): Promise<void> {
  await writeDurable(file, `${JSON.stringify(RestoreJournal.parse(journal))}\n`);
}

export async function deleteJournal(file: string): Promise<void> {
  await removeDurable(file);
}
