import type { JournalAccess, JournalBlock, JournalPage, Member } from "#shared/model.ts";
import { LIMITS, serializedBytes } from "#shared/limits.ts";
import { clientOpSchema, MAX_NAME, type ClientOp } from "#shared/protocol.ts";
import type { OpAnswer, OpRefusal } from "../../state/types.ts";
import { cleanFolderName } from "../scenes/folders.ts";

/**
 * The journal's rules on this side (docs/design-v1-dm-tools.md 3.7): the
 * editor's draft and the one op its Save sends, who a page is for in
 * words, and how the panel groups pages. Plain functions, so they run
 * under node --test. JournalPanel.tsx and JournalEditor.tsx draw them.
 *
 * The whole page is one draft and Save sends one op, as the monster editor
 * does, so an edit is one undo step. A block in the op says only whether it
 * is secret: the server keeps whether it is revealed, so a draft opened
 * before a reveal can never hide the block again.
 */

export type BlockDraft = { id: string; text: string; secret: boolean };

export type PageDraft = {
  title: string;
  /** Empty for no folder. */
  folder: string;
  access: JournalAccess;
  blocks: BlockDraft[];
};

const BLOCK_ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** A new block's id: 12 random characters, as the protocol asks, so two blocks in a page never share one. */
export function newBlockId(random: (bytes: Uint8Array<ArrayBuffer>) => void = (b) => crypto.getRandomValues(b)): string {
  const bytes = new Uint8Array(12);
  random(bytes);
  let id = "";
  for (const b of bytes) id += BLOCK_ID_CHARS[b % BLOCK_ID_CHARS.length];
  return id;
}

export function emptyDraft(newId: () => string = () => newBlockId()): PageDraft {
  return { title: "", folder: "", access: "dm", blocks: [{ id: newId(), text: "", secret: false }] };
}

export function draftOf(page: JournalPage): PageDraft {
  return {
    title: page.title,
    folder: page.folder ?? "",
    access: page.access,
    blocks: page.blocks.map((b) => ({ id: b.id, text: b.text, secret: b.secret !== undefined })),
  };
}

/** A title as typed, fit to send: a pasted line break or tab becomes a space, and text direction marks go. */
export function cleanTitle(text: string): string {
  return text
    .replace(/[\p{Cc}\u2028\u2029]/gu, " ")
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Block text keeps its line breaks and tabs. Other control characters, which the protocol refuses, go. */
export function cleanBlockText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
}

function sameAccess(a: JournalAccess, b: JournalAccess): boolean {
  return typeof a === "object" && typeof b === "object" ? a.member === b.member : a === b;
}

/** The blocks Save sends: cleaned, and empty ones left out, since a block with nothing in it shows nothing to anyone. */
function sentBlocks(draft: PageDraft): { id: string; text: string; secret?: true }[] {
  return draft.blocks
    .map((b) => ({ id: b.id, text: cleanBlockText(b.text), secret: b.secret }))
    .filter((b) => b.text.trim() !== "")
    .map((b) => (b.secret ? { id: b.id, text: b.text, secret: true as const } : { id: b.id, text: b.text }));
}

export type SaveResult =
  | { kind: "op"; op: Extract<ClientOp, { t: "journal.create" | "journal.update" }> }
  /** Nothing changed, so Save sends nothing and leaves no empty step to undo. */
  | { kind: "unchanged" }
  | { kind: "invalid"; problems: string[] };

/**
 * The page as the server will store it once this draft is saved, built as
 * shared/reducer/journal.ts builds it: each secret block stored with whether
 * it is revealed, kept from the stored block of the same id, and the next
 * rev. The room's limit counts this stored page, not the op, and a secret
 * stored takes more bytes than a secret sent (`"secret":{"revealed":false}`
 * against `"secret":true`), so a draft measured as an op could pass the
 * protocol and still be refused (W5-ASTRA-01). `current` is the page as it
 * stands now, or null for a new one.
 */
export function storedPage(current: JournalPage | null, draft: PageDraft, pageId: string): JournalPage {
  const before = new Map((current?.blocks ?? []).map((b) => [b.id, b]));
  const blocks: JournalBlock[] = sentBlocks(draft).map((b) =>
    b.secret ? { id: b.id, text: b.text, secret: { revealed: before.get(b.id)?.secret?.revealed ?? false } } : { id: b.id, text: b.text },
  );
  const typedFolder = draft.folder.trim();
  const page: JournalPage = { ...current, id: current?.id ?? pageId, rev: (current?.rev ?? 0) + 1, title: cleanTitle(draft.title), access: draft.access, blocks };
  if (typedFolder === "") delete page.folder;
  else page.folder = cleanFolderName(typedFolder) ?? typedFolder;
  return page;
}

/**
 * What Save sends for a draft: a `journal.create` for a new page (`page`
 * null), or a `journal.update` naming only what changed since the page the
 * editor opened (`page`), the whole block list when any block changed.
 * Checked against the protocol and against the room's page limit as the
 * page will be stored (storedPage, from `current`, the page as it stands
 * now), so the editor refuses before sending what the server would refuse.
 */
export function saveDraft(page: JournalPage | null, draft: PageDraft, pageId: string, current: JournalPage | null = page): SaveResult {
  const problems: string[] = [];
  const title = cleanTitle(draft.title);
  if (title === "") problems.push("The page needs a title.");
  else if (title.length > MAX_NAME) problems.push(`A title is at most ${MAX_NAME} characters.`);
  const typedFolder = draft.folder.trim();
  const folder = typedFolder === "" ? null : cleanFolderName(typedFolder);
  if (typedFolder !== "" && folder === null) problems.push(`A folder name is at most ${LIMITS.folderNameChars} characters, with no control characters.`);
  if (typeof draft.access === "object" && draft.access.member === "") problems.push("Pick the player who can read it.");
  const blocks = sentBlocks(draft);
  if (blocks.length > LIMITS.journalBlocksPerPage) problems.push(`A page holds at most ${LIMITS.journalBlocksPerPage} blocks.`);
  if (blocks.some((b) => b.text.length > LIMITS.journalBlockChars)) problems.push(`A block holds at most ${LIMITS.journalBlockChars.toLocaleString("en-US")} characters.`);
  if (problems.length > 0) return { kind: "invalid", problems };

  let op: Extract<ClientOp, { t: "journal.create" | "journal.update" }>;
  if (page === null) {
    op = { t: "journal.create", page: { id: pageId, title, access: draft.access, blocks, ...(folder !== null ? { folder } : {}) } };
  } else {
    const patch: Extract<ClientOp, { t: "journal.update" }>["patch"] = {};
    if (title !== page.title) patch.title = title;
    if ((folder ?? undefined) !== page.folder) patch.folder = folder;
    if (!sameAccess(draft.access, page.access)) patch.access = draft.access;
    const stored = page.blocks.map((b) => (b.secret ? { id: b.id, text: b.text, secret: true } : { id: b.id, text: b.text }));
    if (JSON.stringify(stored) !== JSON.stringify(blocks)) patch.blocks = blocks;
    if (Object.keys(patch).length === 0) return { kind: "unchanged" };
    op = { t: "journal.update", pageId: page.id, patch };
  }
  const bytes = Math.max(serializedBytes(op), serializedBytes(storedPage(current, draft, pageId)));
  if (bytes > LIMITS.journalPageBytes) return { kind: "invalid", problems: [pageTooBig(bytes)] };
  const checked = clientOpSchema.safeParse(op);
  if (!checked.success) return { kind: "invalid", problems: [checked.error.issues[0]?.message ?? "The page could not be saved."] };
  return { kind: "op", op };
}

/**
 * KiB to one decimal, rounded away from the limit: up when over it, down
 * when under, so a page just past 32 KiB never reads "32.0 KiB, over the
 * 32 KiB" and one just under never reads as full.
 */
function kib(bytes: number, round: "up" | "down"): string {
  const tenths = (bytes / 1024) * 10;
  return ((round === "up" ? Math.ceil(tenths) : Math.floor(tenths)) / 10).toFixed(1);
}

function pageTooBig(bytes: number): string {
  return `This page is ${kib(bytes, "up")} KiB, over the ${LIMITS.journalPageBytes / 1024} KiB a page may hold. Move some of it to a page of its own.`;
}

/**
 * A note on the page's size once it nears its limit, or null well below it.
 * It measures what Save checks: the page as it will be stored, or the op
 * that carries a new page, whichever is larger.
 */
export function sizeNote(current: JournalPage | null, draft: PageDraft, pageId: string): { text: string; over: boolean } | null {
  const stored = storedPage(current, draft, pageId);
  const { rev: _rev, ...sent } = stored;
  const asSent = sent.blocks.map((b) => (b.secret ? { id: b.id, text: b.text, secret: true } : b));
  const bytes = Math.max(serializedBytes(stored), serializedBytes({ t: "journal.create", page: { ...sent, blocks: asSent } }));
  if (bytes <= LIMITS.journalPageBytes * 0.75) return null;
  const over = bytes > LIMITS.journalPageBytes;
  return { text: over ? pageTooBig(bytes) : `This page is ${kib(bytes, "down")} KiB of the ${LIMITS.journalPageBytes / 1024} KiB a page may hold.`, over };
}

/** What the editor does once the server has answered its Save. */
export type SaveAnswer = { kind: "saved" } | { kind: "kept"; problem: string };

/**
 * The editor closes only once the server has taken the page. A refusal, or
 * an answer lost with the connection, keeps the draft open with the reason,
 * so nothing typed is lost to the snap back of a refused page.
 */
export function saveAnswer(answer: OpAnswer, refusal?: OpRefusal): SaveAnswer {
  if (answer === "taken") return { kind: "saved" };
  if (answer === "unknown") {
    return { kind: "kept", problem: "The connection dropped before the server answered, so this page may not be saved. Your text is still here. Save again to make sure." };
  }
  if (refusal?.code === "gone") return { kind: "kept", problem: "Not saved. The page was deleted, or the player it is for left the room, while you edited. Your text is still here." };
  return { kind: "kept", problem: refusal?.text ?? "Not saved. The server refused the page. Your text is still here." };
}

/** Whether the draft differs from what it was opened with, so leaving asks first. */
export function draftDirty(initial: PageDraft, draft: PageDraft): boolean {
  const norm = (d: PageDraft) => JSON.stringify({ ...d, blocks: d.blocks.filter((b) => b.text.trim() !== "" || b.secret) });
  return norm(initial) !== norm(draft);
}

/** The draft with one block moved up (-1) or down (+1). The ends stay put. */
export function moveBlock(draft: PageDraft, index: number, delta: -1 | 1): PageDraft {
  const j = index + delta;
  if (index < 0 || j < 0 || index >= draft.blocks.length || j >= draft.blocks.length) return draft;
  const blocks = [...draft.blocks];
  [blocks[index], blocks[j]] = [blocks[j]!, blocks[index]!];
  return { ...draft, blocks };
}

/** Who reads a page, in the DM's words: "Only the DM", "Everyone", or "Thorn and the DM". */
export function accessText(access: JournalAccess, members: Readonly<Record<string, Pick<Member, "name">>>): string {
  if (access === "dm") return "Only the DM";
  if (access === "all") return "Everyone";
  return `${members[access.member]?.name ?? "A player"} and the DM`;
}

export type PageGroup<P> = { folder: string | null; pages: P[] };

const byTitle = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Pages in no folder first, then each folder by name, the pages in each by title. */
export function groupPages<P extends Pick<JournalPage, "id" | "title" | "folder">>(pages: readonly P[]): PageGroup<P>[] {
  const sorted = [...pages].sort((a, b) => byTitle.compare(a.title, b.title) || a.id.localeCompare(b.id));
  const loose = sorted.filter((p) => p.folder === undefined);
  const folders = [...new Set(sorted.flatMap((p) => (p.folder === undefined ? [] : [p.folder])))].sort((a, b) => byTitle.compare(a, b));
  const groups: PageGroup<P>[] = loose.length > 0 ? [{ folder: null, pages: loose }] : [];
  for (const folder of folders) groups.push({ folder, pages: sorted.filter((p) => p.folder === folder) });
  return groups;
}
