import { WORDS, type SupervisorStatus } from "../contract.ts";

/**
 * Where a quit came from. The window asks for itself before it calls `quit`
 * (contract `RaccoonLocal.quit`). The tray and the app menu have no page to
 * ask on, so the shell asks with a message box. An installer's `--quit` and
 * the system shutting down never ask: nobody is there to answer.
 */
export type QuitSource = "window" | "tray" | "menu" | "secondInstance" | "system" | "smoke";

/** How long a quit waits for the supervisor's stopped report before leaving anyway. */
export const STOP_TIMEOUT_MS = 60_000;

/** The question to ask before quitting, or null to quit at once (design 9: only while other devices are connected). */
export function quitQuestion(source: QuitSource, status: SupervisorStatus | null): string | null {
  if (source !== "tray" && source !== "menu") return null;
  const devices = status?.remoteDevices ?? 0;
  return devices > 0 ? WORDS.quit.confirm(devices) : null;
}
