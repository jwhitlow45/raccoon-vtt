import { readFile, rename } from "node:fs/promises";
import { Settings } from "../contract.ts";
import { writeDurable } from "./durable.ts";

/**
 * settings.json (docs/design/design-v1-local-app.md 8.1). A file that is
 * not JSON, or not the schema, is set aside as settings.json.bad and the
 * defaults written in its place, so a hand edit gone wrong never stops the
 * app, and the DM can still read what they wrote.
 */

export const DEFAULT_SETTINGS: Settings = Settings.parse({});

export type SettingsLoad = { settings: Settings; replaced: boolean };

export async function loadSettings(file: string, badFile: string): Promise<SettingsLoad> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: DEFAULT_SETTINGS, replaced: false };
    throw err;
  }
  let parsed: ReturnType<typeof Settings.safeParse> | null = null;
  try {
    parsed = Settings.safeParse(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (parsed?.success) return { settings: parsed.data, replaced: false };
  await rename(file, badFile);
  await saveSettings(file, DEFAULT_SETTINGS);
  return { settings: DEFAULT_SETTINGS, replaced: true };
}

export async function saveSettings(file: string, settings: Settings): Promise<void> {
  await writeDurable(file, `${JSON.stringify(Settings.parse(settings), null, 2)}\n`, { mode: 0o600 });
}
