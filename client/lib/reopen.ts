/**
 * What a reload asked for by a failed load opens again: the panel or the
 * tool whose code did not load. Kept in sessionStorage, which a reload of
 * the same tab keeps, and read once by the room it names.
 */

const KEY = "rvtt.reopen";

export type Reopen = { panel?: string; tool?: string };

export function encodeReopen(roomId: string, what: Reopen): string {
  return JSON.stringify({ roomId, ...what });
}

/** The panel or tool to open in this room, or null for anything else. */
export function decodeReopen(raw: string | null, roomId: string): Reopen | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.roomId !== roomId) return null;
    const out: Reopen = {};
    if (typeof value.panel === "string") out.panel = value.panel;
    if (typeof value.tool === "string") out.tool = value.tool;
    return out.panel || out.tool ? out : null;
  } catch {
    return null;
  }
}

export function rememberReopen(roomId: string, what: Reopen): void {
  try {
    sessionStorage.setItem(KEY, encodeReopen(roomId, what));
  } catch {
    // Storage blocked: the reload still works, it just opens nothing.
  }
}

/** Reads and forgets what to open, so a later reload opens nothing on its own. */
export function takeReopen(roomId: string): Reopen | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return decodeReopen(raw, roomId);
  } catch {
    return null;
  }
}
