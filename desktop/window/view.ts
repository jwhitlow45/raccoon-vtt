import { DEFAULT_PORT, ERROR_ACTIONS, WORDS, errorText, type AppError, type BackupSummary, type CommandFailure, type ErrorAction, type RestoreStep, type SupervisorStatus, type WindowState } from "../contract.ts";
import { formatSize } from "./format.ts";

/**
 * What the page shows for a state, as plain data, so the words and the
 * rules (which section shows when, which control refuses) are unit tested
 * without a browser. The components only draw these.
 */

/** The stop the window explains: the shell's own first, since it knows what the supervisor cannot. */
export function currentError(state: WindowState): AppError | null {
  return state.shell.error ?? state.supervisor?.error ?? null;
}

export type StatusView = {
  /** What the status line says. Empty while a stop's own panel speaks instead. */
  text: string;
  /** True while something is under way, so the shared indicator shows after its delay. */
  working: boolean;
};

/**
 * The status line. `stopped` shows "Stopping" because the shell quits the
 * app on it, so a window that is still open there is closing.
 */
export function statusView(state: WindowState): StatusView {
  const sup = state.supervisor;
  if (currentError(state)) return { text: "", working: false };
  if (!sup) return { text: WORDS.steps.startServer, working: true };
  switch (sup.state) {
    case "running":
      return { text: WORDS.steps.running, working: false };
    case "restoring":
      return { text: sup.restore ? WORDS.backups.steps[sup.restore] : WORDS.steps.finishRestore, working: true };
    case "stopping":
    case "stopped":
      return { text: WORDS.steps.stopping, working: true };
    case "recovering":
      return { text: WORDS.steps.finishRestore, working: true };
    case "restarting":
    case "starting":
    case "error":
      return { text: WORDS.steps[sup.step ?? "startServer"], working: true };
  }
}

/** Whether a restore is under way, which refuses every control that changes data. */
export function restoring(sup: SupervisorStatus | null): boolean {
  return sup?.state === "restoring";
}

/** Whether the app server answers, so Open RaccoonVTT and the rooms list can work. */
export function serverUp(sup: SupervisorStatus | null): boolean {
  return sup?.state === "running" && sup.port !== null;
}

/** Whether the switch, the port and the like may change now: only while running, and never over another restart. */
export function canReconfigure(sup: SupervisorStatus | null): boolean {
  return sup?.state === "running";
}

/** Whether a step is a restart the switch caused, so its own control shows busy. */
export function switchBusy(sup: SupervisorStatus | null): boolean {
  return sup?.state === "restarting" && (sup.step === "openToNetwork" || sup.step === "closeToNetwork");
}

export function portBusy(sup: SupervisorStatus | null): boolean {
  return sup?.state === "restarting" && sup.step === "changePort";
}

export type PlayersView = {
  /** The address players type, when players can join. */
  address: string | null;
  /** Why they cannot, in the window's words, or null. */
  note: string | null;
  devices: string;
  awake: boolean;
};

export function playersView(sup: SupervisorStatus): PlayersView {
  const open = sup.network === "open" && sup.shareOrigin !== null;
  const note = sup.network === "open" ? null : WORDS.players.reach[sup.network];
  return {
    address: open ? sup.shareOrigin : null,
    note,
    devices: WORDS.players.devices(sup.remoteDevices),
    awake: sup.sockets > 0,
  };
}

/** The lines under Not working?, in the order the design lists them. */
export function notWorkingLines(sup: SupervisorStatus, platform: "win32" | "darwin" | "linux"): string[] {
  const lines: string[] = [WORDS.notWorking.sameNetwork, WORDS.notWorking.vpn];
  if (sup.otherAddresses.length > 0) lines.push(WORDS.notWorking.alsoAt(sup.otherAddresses));
  if (platform === "linux") lines.push(WORDS.notWorking.ufw(sup.port ?? DEFAULT_PORT));
  if (platform === "win32" && sup.firewallRule === "missing") lines.push(WORDS.notWorking.firewallRuleMissing);
  return lines;
}

/** A refused or failed command, in the window's words. `restore` and `backup` choose the sentence a bare reason sits in. */
export function failureText(failure: CommandFailure, what: "restore" | "backup" | "rooms" | "other"): string {
  switch (failure.error) {
    case "restoring":
      return WORDS.notDuringRestore;
    case "busy":
      return what === "backup" ? WORDS.backups.backingUp : WORDS.steps.stopping;
    case "notRunning":
      return WORDS.rooms.notRunning;
    case "noSpace":
      return WORDS.backups.noSpace(formatSize(failure.bytes));
    case "failed":
      if (what === "restore") return WORDS.backups.restoreFailed(failure.reason);
      if (what === "backup") return WORDS.backups.failed(failure.reason);
      return failure.reason;
  }
}

export type ActionView = { action: ErrorAction; label: string };

/** The buttons a stop offers, with the label each carries (`usePort` names the port). */
export function errorActions(error: AppError): ActionView[] {
  return ERROR_ACTIONS[error.kind].map((action) => {
    if (action === "usePort" && error.kind === "portInUse") return { action, label: WORDS.actions.usePort(error.next) };
    return { action, label: WORDS.actions[action] as string };
  });
}

export function errorSentence(state: WindowState, error: AppError): string {
  return errorText(error, state.shell.version, state.shell.platform);
}

/** The backups worth a Restore button: ones this build can read. */
export function restorable(backups: readonly BackupSummary[]): BackupSummary[] {
  return backups.filter((b) => b.readable);
}

export function backupKindLabel(backup: BackupSummary): string {
  if (backup.kind === "before-update") return backup.forVersion ? WORDS.backups.kinds["before-update"](backup.forVersion) : "Before an update";
  return backup.kind === "daily" ? WORDS.backups.kinds.daily() : WORDS.backups.kinds.manual();
}

export type PortCheck = { ok: true; port: number } | { ok: false };

/** A typed port: digits only, 1024 to 65535. The contract's `Port` is the same range. */
export function checkPort(text: string): PortCheck {
  if (!/^\d{1,5}$/.test(text.trim())) return { ok: false };
  const port = Number(text.trim());
  return port >= 1024 && port <= 65535 ? { ok: true, port } : { ok: false };
}

export const RESTORE_STEP_ORDER: readonly RestoreStep[] = ["stopping", "images", "database", "starting"];
