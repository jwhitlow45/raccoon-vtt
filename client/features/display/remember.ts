import { useLayoutEffect } from "react";
import { formatRoomId } from "../../lib/roomId.ts";
import { applyUiScale, parseUiScale, restoreUiScale, type UiScale } from "../device/settings.ts";

/** A display's own page for its room, `/display/K7QH-2MXA`. */
export function displayPath(roomId: string): string {
  return `/display/${formatRoomId(roomId)}`;
}

/**
 * The room this device shows as a table display, so Home can offer it again
 * after the TV's browser is closed. Only a convenience: the display's
 * session cookie is what lets it in, and Leave forgets both.
 */
const KEY = "rvtt.display.room";

export function rememberDisplayRoom(roomId: string): void {
  try {
    localStorage.setItem(KEY, roomId);
  } catch {
    // Storage blocked: Home simply does not offer it.
  }
}

export function rememberedDisplayRoom(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Forgets this room, and only this one: another tab or window may have paired this device with another room since. */
export function forgetDisplayRoom(roomId: string): void {
  try {
    if (localStorage.getItem(KEY) === roomId) localStorage.removeItem(KEY);
  } catch {
    // As above.
  }
}

/** The display's own choices on this device: its camera mode and whether it shows whose turn it is. */
const MODE_KEY = "rvtt.display.mode";
const TURN_KEY = "rvtt.display.turn";

export function readDisplayMode(): "follow" | "fit" {
  try {
    return localStorage.getItem(MODE_KEY) === "follow" ? "follow" : "fit";
  } catch {
    return "fit";
  }
}

export function readDisplayTurn(): boolean {
  try {
    return localStorage.getItem(TURN_KEY) === "on";
  } catch {
    return false;
  }
}

/**
 * The display's text size, apart from the device's interface size
 * (`rvtt.uiScale`): with "Open on this device" the display is a window of
 * the DM's own browser, and the two must not resize each other.
 */
const SCALE_KEY = "rvtt.displayUiScale";

export function readDisplayUiScale(): UiScale {
  try {
    return parseUiScale(localStorage.getItem(SCALE_KEY));
  } catch {
    return 1;
  }
}

/** The display menu's Text size: kept under the display's own key, and shown on this page only. */
export function chooseDisplayUiScale(scale: UiScale): void {
  try {
    localStorage.setItem(SCALE_KEY, String(scale));
  } catch {
    // The size lasts until the page closes.
  }
  applyUiScale(scale);
}

/**
 * The display's own text size, never the device's interface size, for this
 * page only (device/settings.ts applyUiScale). The stored size goes back when
 * the display closes, should the same window open a room next.
 *
 * It is taken in a layout effect rather than during render, since a render
 * must not change a store other components read. The map still mounts at
 * this size: the display room draws a black screen until its socket store
 * exists, which a later effect makes, and a layout effect runs before the
 * first paint.
 */
export function useDisplayTextSize(): void {
  useLayoutEffect(() => {
    applyUiScale(readDisplayUiScale());
    return () => restoreUiScale();
  }, []);
}

export function saveDisplayChoices(choices: { mode: "follow" | "fit"; turn: boolean }): void {
  try {
    localStorage.setItem(MODE_KEY, choices.mode);
    localStorage.setItem(TURN_KEY, choices.turn ? "on" : "off");
  } catch {
    // The choices last until the page closes.
  }
}
