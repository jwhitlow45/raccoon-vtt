import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * What the shell remembers between launches, in `shell.json` in Electron's
 * own profile folder. It is not a setting the DM changes, so it stays out of
 * the supervisor's settings.json. Unknown keys are kept, as settings.json
 * keeps them, so an older build loses nothing a newer one wrote.
 */
export const ShellPrefs = z.looseObject({
  /** The first close's notification has been shown (design 9: once, not every close). */
  closeNoticeShown: z.boolean().default(false),
});
export type ShellPrefs = z.infer<typeof ShellPrefs>;

export const SHELL_PREFS_FILE = "shell.json";

/** The saved prefs, or the defaults when the file is missing or unreadable. */
export function readPrefs(dir: string): ShellPrefs {
  try {
    const parsed = ShellPrefs.safeParse(JSON.parse(readFileSync(join(dir, SHELL_PREFS_FILE), "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // Missing or not JSON: start from the defaults.
  }
  return ShellPrefs.parse({});
}

/**
 * Saves through a temporary file and a rename, so a crash mid-write leaves
 * the old file rather than half a file. Losing the newest write only shows
 * one notification twice, so the file is not fsynced.
 */
export function writePrefs(dir: string, prefs: ShellPrefs): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, SHELL_PREFS_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(prefs, null, 2)}\n`);
  renameSync(temp, target);
}
