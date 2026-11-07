import { action, setting, type Place } from "../search/catalog/write.ts";
import type { CatalogEntry } from "../search/catalog/types.ts";

/*
 * The Log in the room search (designs/qol/search.md 4 and 5.10), for both
 * roles, so it ships in the room's chunk through catalog/everyone.ts: its
 * Chat only filter and the message field at its foot. Each anchor is the
 * `search=` id on its control in panels/LogPanel.tsx. The log's lines are
 * never indexed.
 */

const LOG: Place = { panel: "log", where: "Log", icon: "log" };

export const LOG_ENTRIES: readonly CatalogEntry[] = [
  setting(LOG, "log.chat-only", "Chat only", { names: ["only messages"] }),
  // A field to type in, so the search goes there and sends nothing.
  action(LOG, "log.message", "Send a message", { names: ["chat", "message everyone"], press: false }),
  action(LOG, "log.send-to", "Whisper to someone", { names: ["whisper", "private message", "send to"], press: false }),
];
