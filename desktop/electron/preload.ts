import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { BRIDGE_CHANNEL, BridgeCall, RaccoonLocal, STATE_CHANNEL, WindowState } from "../contract.ts";

/**
 * `window.raccoonLocal` (design 6.4): the window's only way out of its
 * sandbox. Each method sends one `BridgeCall`, which the main process parses
 * before acting. The channel names are written out rather than imported, so
 * this file stays a few lines of plain script with none of the contract's
 * zod schemas in it. The types hold them to the contract's values.
 */
const BRIDGE: typeof BRIDGE_CHANNEL = "raccoon-local";
const STATE: typeof STATE_CHANNEL = "raccoon-local-state";

function call<T>(request: BridgeCall): Promise<T> {
  return ipcRenderer.invoke(BRIDGE, request) as Promise<T>;
}

const raccoonLocal: RaccoonLocal = {
  subscribe(listener) {
    // A change pushed while the first getState is on its way is newer than
    // what getState returns, so the late answer is dropped.
    let pushed = false;
    const onState = (_event: IpcRendererEvent, state: WindowState) => {
      pushed = true;
      listener(state);
    };
    ipcRenderer.on(STATE, onState);
    void call<WindowState>({ method: "getState" }).then((state) => {
      if (!pushed) listener(state);
    });
    return () => {
      ipcRenderer.removeListener(STATE, onState);
    };
  },
  setNetworkPlay: (on) => call({ method: "setNetworkPlay", on }),
  setPort: (port) => call({ method: "setPort", port }),
  setSettings: (patch) => call({ method: "setSettings", patch }),
  backupNow: () => call({ method: "backupNow" }),
  listBackups: () => call({ method: "listBackups" }),
  restore: (backup) => call({ method: "restore", backup }),
  listRooms: () => call({ method: "listRooms" }),
  newDmLink: (roomId) => call({ method: "newDmLink", roomId }),
  retry: () => call({ method: "retry" }),
  startWithoutBackup: () => call({ method: "startWithoutBackup" }),
  deleteGuard: () => call({ method: "deleteGuard" }),
  openApp: () => call({ method: "openApp" }),
  openFolder: (folder) => call({ method: "openFolder", folder }),
  openRelease: () => call({ method: "openRelease" }),
  openSource: () => call({ method: "openSource" }),
  installUpdate: () => call({ method: "installUpdate" }),
  copyText: (text) => call({ method: "copyText", text }),
  quit: () => call({ method: "quit" }),
};

contextBridge.exposeInMainWorld("raccoonLocal", raccoonLocal);
