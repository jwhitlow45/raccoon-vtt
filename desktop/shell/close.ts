import { WORDS, type Platform } from "../contract.ts";

/**
 * What closing the window does while RaccoonVTT keeps running (design 9).
 * Windows and macOS hide it to the notification area or the menu bar. Linux
 * minimizes it, because GNOME shows no tray icon without an extension, and
 * a hidden window would leave no way back to it or to Quit (D-261113-063).
 */
export type CloseAction = "hide" | "minimize";

export type ClosePlan = {
  action: CloseAction;
  /** The one notification the first close shows, or null for none. */
  notice: string | null;
};

export function planClose(platform: Platform, noticeShown: boolean): ClosePlan {
  if (platform === "linux") return { action: "minimize", notice: null };
  return { action: "hide", notice: noticeShown ? null : WORDS.stillRunning[platform] };
}
