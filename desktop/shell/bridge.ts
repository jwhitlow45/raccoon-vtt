import { BridgeCall, type Command } from "../contract.ts";

/**
 * The window's calls, checked in the main process before anything acts on
 * them (design 6.4). The window is the shell's own page and runs sandboxed,
 * but a page can still be tricked into calling with something it should
 * not, and the supervisor's commands reach the database and the network
 * switch, so nothing crosses unparsed.
 */
export function parseBridgeCall(raw: unknown): BridgeCall {
  const parsed = BridgeCall.safeParse(raw);
  if (!parsed.success) throw new Error("RaccoonVTT refused a call from its window");
  return parsed.data;
}

/** The supervisor command a call becomes, or null for the calls the shell answers itself. */
export function commandFor(call: BridgeCall): Command | null {
  switch (call.method) {
    case "setNetworkPlay":
      return { type: "setNetworkPlay", on: call.on };
    case "setPort":
      return { type: "setPort", port: call.port };
    case "setSettings":
      return { type: "setSettings", patch: call.patch };
    case "backupNow":
    case "listBackups":
    case "listRooms":
    case "retry":
    case "startWithoutBackup":
    case "deleteGuard":
      return { type: call.method };
    case "restore":
      return { type: "restore", backup: call.backup };
    case "newDmLink":
      return { type: "newDmLink", roomId: call.roomId };
    case "getState":
    case "openApp":
    case "openFolder":
    case "openRelease":
    case "openSource":
    case "installUpdate":
    case "copyText":
    case "quit":
      return null;
  }
}
