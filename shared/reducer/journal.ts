import { keys } from "../keys.ts";
import type { JournalAccess, JournalBlock, JournalPage, Pin } from "../model.ts";
import type { JournalBlockInput, OpOf } from "../protocol.ts";
import { sortedById } from "./tokens.ts";
import { gone, invalid, type Tx } from "./tx.ts";

/**
 * Journal pages (docs/design-v1-dm-tools.md 3.7), all the DM's. A page is
 * a list of blocks, and a secret is a block with a flag, so the projection
 * drops whole blocks and never parses text.
 *
 * An op says only whether a block is secret. Whether it is revealed is kept
 * from the stored block of the same id, and a new secret starts hidden, so
 * only `journal.reveal` reveals or hides: a draft opened before a reveal
 * cannot hide the block again when it is saved.
 */
export function journalCreate(tx: Tx, op: OpOf<"journal.create">): void {
  const input = op.page;
  if (tx.state.journal[input.id]) throw invalid("page already exists");
  checkAccess(tx, input.access);
  const page: JournalPage = { id: input.id, rev: 0, title: input.title, access: input.access, blocks: input.blocks.map((b) => storedBlock(b, undefined)) };
  if (input.folder !== undefined) page.folder = input.folder;
  tx.write(keys.journal(page.id), page);
}

export function journalUpdate(tx: Tx, op: OpOf<"journal.update">): void {
  const page = tx.state.journal[op.pageId];
  if (!page) throw gone("page");
  const p = op.patch;
  const next: JournalPage = { ...page };
  if (p.title !== undefined) next.title = p.title;
  if (p.folder === null) delete next.folder;
  else if (p.folder !== undefined) next.folder = p.folder;
  if (p.access !== undefined) {
    checkAccess(tx, p.access);
    next.access = p.access;
  }
  if (p.blocks !== undefined) {
    const stored = new Map(page.blocks.map((b) => [b.id, b]));
    next.blocks = p.blocks.map((b) => storedBlock(b, stored.get(b.id)));
  }
  tx.write(keys.journal(page.id), next);
}

/** Reveals a secret block to the page's readers, or hides it again. A block already so changes nothing. */
export function journalReveal(tx: Tx, op: OpOf<"journal.reveal">): void {
  const page = tx.state.journal[op.pageId];
  if (!page) throw gone("page");
  const block = page.blocks.find((b) => b.id === op.blockId);
  if (!block) throw gone("block");
  if (!block.secret) throw invalid("that block is not a secret");
  if (block.secret.revealed === op.revealed) return;
  const blocks = page.blocks.map((b) => (b.id === op.blockId ? { ...b, secret: { revealed: op.revealed } } : b));
  tx.write(keys.journal(page.id), { ...page, blocks });
}

/**
 * Deletes a page, and in the same op makes every pin linked to it DM only
 * and unlinks it (section 3.8). A pin can be public and still withheld
 * because players could not read its page, so merely unlinking it would
 * publish its place and label: a page's deletion never widens who sees its
 * pins, and a pin never names a deleted page. The op's undo puts the page
 * and its pins back as they were.
 */
export function journalDelete(tx: Tx, op: OpOf<"journal.delete">): void {
  if (!tx.state.journal[op.pageId]) throw gone("page");
  for (const pin of sortedById(Object.values(tx.state.pins))) {
    if (pin.pageId !== op.pageId) continue;
    const { pageId: _page, ...rest } = pin;
    const next: Pin = { ...rest, visibility: "dm" };
    tx.write(keys.pin(pin.id), next);
  }
  tx.remove(keys.journal(op.pageId));
}

/** A page private to one player names a member of the room. */
function checkAccess(tx: Tx, access: JournalAccess): void {
  if (typeof access === "object" && !tx.state.members[access.member]) throw gone("member");
}

function storedBlock(input: JournalBlockInput, stored: JournalBlock | undefined): JournalBlock {
  const block: JournalBlock = { id: input.id, text: input.text };
  if (input.secret) block.secret = { revealed: stored?.secret?.revealed ?? false };
  return block;
}
