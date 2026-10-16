/**
 * The device's record of a PDF upload's own pages (docs/design-v1-pdf-handouts.md
 * 4.1.2), in localStorage per room and member. Each page the upload made is
 * written here before the next upload starts, so an upload that never
 * finished, after a reload, a crash or a closed tab, can be cleaned up
 * exactly: these ids, and never every loose handout image the DM kept.
 */

/** A page whose upload never answered: it may be in the library, with no id to delete it by (4.1.6). */
export type UncertainPage = { page: number; width: number; height: number; thumb: string | null };

export type Ledger = { docId: string; title: string; ids: string[]; uncertain: UncertainPage | null };

export type LedgerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function ledgerKey(roomId: string, memberId: string): string {
  return `rvtt.pdfUpload.${roomId}.${memberId}`;
}

/** A small picture's data URL, kept bounded: a few KB is what the job writes. */
const MAX_THUMB = 32 * 1024;
const MAX_IDS = 1_000;

const str = (value: unknown, max: number): string | null => (typeof value === "string" && value.length > 0 && value.length <= max ? value : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 100_000 ? value : null);

/** The ledger as stored, or null when there is none or it cannot be read. Anything malformed counts as none. */
export function readLedger(storage: LedgerStorage | null, key: string): Ledger | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const docId = str(value.docId, 64);
    const title = str(value.title, 200);
    if (!docId || !title || !Array.isArray(value.ids)) return null;
    const ids = value.ids.filter((id): id is string => str(id, 64) !== null).slice(0, MAX_IDS);
    const u = value.uncertain as Record<string, unknown> | null | undefined;
    let uncertain: UncertainPage | null = null;
    if (u && typeof u === "object") {
      const page = count(u.page);
      const width = count(u.width);
      const height = count(u.height);
      const thumb = typeof u.thumb === "string" && u.thumb.startsWith("data:image/") && u.thumb.length <= MAX_THUMB ? u.thumb : null;
      if (page && width && height) uncertain = { page, width, height, thumb };
    }
    return { docId, title, ids, uncertain };
  } catch {
    return null;
  }
}

/** Writes the ledger. Storage that refuses costs only the recovery. */
export function writeLedger(storage: LedgerStorage | null, key: string, ledger: Ledger): void {
  try {
    storage?.setItem(key, JSON.stringify(ledger));
  } catch {
    // No recovery for this upload, which goes on all the same.
  }
}

export function clearLedger(storage: LedgerStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // As above.
  }
}

/**
 * What this device does with a ledger it finds when it opens the room with
 * no upload running: nothing to offer when the save it records happened,
 * which the room's documents say, and otherwise the recovery line.
 */
export function recoveryOf(ledger: Ledger | null, docs: Readonly<Record<string, unknown>> | undefined): "none" | "saved" | "offer" {
  if (!ledger) return "none";
  if (docs && docs[ledger.docId] !== undefined) return "saved";
  return ledger.ids.length > 0 || ledger.uncertain ? "offer" : "saved";
}

/** The browser's storage for the ledger, or null where it is blocked. */
export function localLedgerStorage(): LedgerStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
