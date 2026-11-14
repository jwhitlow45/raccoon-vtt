import { WORDS, type SupervisorStatus } from "../contract.ts";

/** The tray's menu (design 9), as data, so its rules are tested without Electron. */
export type TrayItemId = "openWindow" | "openBrowser" | "networkPlay" | "quit";

export type TrayItem =
  | { id: TrayItemId; type: "normal"; label: string; enabled: boolean }
  | { id: "networkPlay"; type: "checkbox"; label: string; enabled: boolean; checked: boolean }
  | { type: "separator" };

/**
 * Open window, Open RaccoonVTT in the browser, Players on this network can
 * join, then Quit RaccoonVTT. The browser item works only while the server
 * runs. The switch shows the saved setting, and is open to change only
 * while the server runs, since the change restarts it. During the restart
 * the window's own switch shows it as busy.
 */
export function trayItems(status: SupervisorStatus | null, quitting: boolean): TrayItem[] {
  const running = !quitting && status?.state === "running" && status.port !== null;
  return [
    { id: "openWindow", type: "normal", label: WORDS.tray.openWindow, enabled: true },
    { id: "openBrowser", type: "normal", label: WORDS.tray.openBrowser, enabled: running },
    {
      id: "networkPlay",
      type: "checkbox",
      label: WORDS.tray.networkPlay,
      enabled: running,
      checked: status?.settings.networkPlay ?? false,
    },
    { type: "separator" },
    { id: "quit", type: "normal", label: WORDS.tray.quit, enabled: !quitting },
  ];
}
