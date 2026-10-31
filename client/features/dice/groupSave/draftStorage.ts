import { utf8Bytes } from "#shared/limits.ts";
import { SAVE_DRAFT_BYTES } from "#shared/saveOutcomeContract.ts";
import { saveDraftSchema, type SaveDraft } from "./reopenContract.ts";

const draftKey = (roomId: string) => `rvtt.groupSave.${roomId}`;

export function readSaveDraft(roomId: string): SaveDraft | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(draftKey(roomId));
    if (!raw || utf8Bytes(raw) > SAVE_DRAFT_BYTES) return null;
    const value: unknown = JSON.parse(raw);
    // Legacy applied pages have no lifecycle proof. Keep their original phase
    // without manufacturing tracking or choices that could enable Apply again.
    const draft = value && typeof value === "object" && !Array.isArray(value) && !("version" in value)
      ? { version: 2, page: value }
      : value;
    const parsed = saveDraftSchema.safeParse(draft);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A failed write leaves the caller's complete in-memory draft available. */
export function writeSaveDraft(roomId: string, draft: SaveDraft | null): boolean {
  try {
    if (typeof sessionStorage === "undefined") return false;
    if (draft === null) {
      sessionStorage.removeItem(draftKey(roomId));
      return true;
    }
    const parsed = saveDraftSchema.safeParse(draft);
    if (!parsed.success) return false;
    sessionStorage.setItem(draftKey(roomId), JSON.stringify(parsed.data));
    return true;
  } catch {
    return false;
  }
}
