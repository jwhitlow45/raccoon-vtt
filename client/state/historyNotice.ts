export const UNDO_NOTICE = "Undo now separates play from setup. Earlier undo history was cleared. Setup history is in the menu.";
export const UNDO_NOTICE_KEY = "rvtt.undo-scopes-notice.v1";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** The memory flag also prevents repeats while site storage is unavailable. */
export class UndoNotice {
  private seen = false;
  private storage: () => Storage | null;

  constructor(storage = (): Storage | null => typeof localStorage === "undefined" ? null : localStorage) {
    this.storage = storage;
  }

  claim(): boolean {
    if (this.seen) return false;
    this.seen = true;
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
