export const UNDO_NOTICE = "Undo now separates play from setup. Earlier undo history was cleared. Setup history is in the menu.";
export const UNDO_NOTICE_KEY = "rvtt.undo-scopes-notice.v1";
/** Inclusive UTC date. Set for the batch A deploy's 14-day rollout window. */
export const UNDO_NOTICE_LAST_DAY = "2026-11-13";
const NOTICE_END = Date.parse(`${UNDO_NOTICE_LAST_DAY}T00:00:00Z`) + 24 * 60 * 60 * 1000;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** The memory flag also prevents repeats while site storage is unavailable. */
export class UndoNotice {
  private seen = false;
  private storage: () => Storage | null;

  constructor(storage = (): Storage | null => typeof localStorage === "undefined" ? null : localStorage) {
    this.storage = storage;
  }

  claim(now = Date.now()): boolean {
    if (this.seen) return false;
    this.seen = true;
    if (now >= NOTICE_END) return false;
    try {
      const storage = this.storage();
      if (storage?.getItem(UNDO_NOTICE_KEY) === "1") return false;
      storage?.setItem(UNDO_NOTICE_KEY, "1");
    } catch {
      // The notice still works when private mode or site settings deny storage.
    }
    return true;
  }
}

/** Shared by this device's room pages, including navigation without a reload. */
export const undoNotice = new UndoNotice();
