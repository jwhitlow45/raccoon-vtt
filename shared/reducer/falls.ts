import { keys } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import { FALL_RIDERS_MOST, type Fall, type FallId, type FallRecord, type FloorLink, type RoomState, type SceneId, type ShownEnds, type Token, type TokenId, type Trap } from "../model.ts";
import type { ActorTarget, Op, OpOf } from "../protocol.ts";
import { inSightOfNonOwners } from "../project.ts";
import { ownEntry } from "../records.ts";
import { isCreature, onHolder } from "../rules/attach.ts";
import { fallDrop, isHole, linkHeight, linksOn, spaceOn } from "../rules/floorLinks.ts";
import { byFallAge } from "../rules/fallCards.ts";
import { footprintGround } from "../rules/heights.ts";
import { landThrough } from "./floorLinks.ts";
import { invalid, type Tx } from "./tx.ts";

/*
 * Falls through openings between floors (docs/design/design-v1-floors.md
 * phase 4, 4): the fall pass that runs from op version 64 (opensOps), the
 * cards it and trapdoors write, and their settling by Dismiss, by a group
 * save's outcome, by the undo of the move that made them, or by the DM's
 * delete of the creature. What an op lands is kept on its transaction
 * (`Openings`), which the reducer's passes after dispatch read in the
 * order of 4.3.
 */

/** A card a second DM device, or a resend, settles after it went: as a trap's (reducer/traps.ts SETTLED_MEANWHILE). */
export const FALL_SETTLED = "It was settled meanwhile.";

/**
 * A creature's landing in the op (4.3 steps 5 to 11): a climb's or a
 * flight's, a trapdoor's drop or a fall's, intermediate ones included.
 * The arrival step reads each creature's last, `markOpened` and the
 * landing reminders read them all.
 */
export type Landing = { tokenId: TokenId; sceneId: SceneId; how: "climb" | "flight" | "drop" | "fall" };

/**
 * What an op from version 64 lands, kept on its transaction while the
 * reducer runs it (shared/reducer.ts): the room before the op, which the
 * support rule reads (4.1), the trapdoors the trap step sprang, whose drops
 * wait for step 4b while it runs (`deferred`, null where a trapdoor drops
 * at once), every landing so far, how many cards the op made, and the
 * creatures a drop landed since the last fall pass. Only the server's
 * state takes one: a projected copy lands nothing (4.1).
 */
export type Openings = { before: RoomState; deferred: Trap[] | null; landings: Landing[]; cards: number; dropped: Set<TokenId> };

const OPENINGS = new WeakMap<Tx, Openings>();

/** Starts the op's openings record (4.3). */
export function beginOpenings(tx: Tx, before: RoomState): Openings {
  const openings: Openings = { before, deferred: null, landings: [], cards: 0, dropped: new Set() };
  OPENINGS.set(tx, openings);
  return openings;
}

/** The op's openings record, or undefined for an op before version 64 or on a projected copy. */
export function openingsOf(tx: Tx): Openings | undefined {
  return OPENINGS.get(tx);
}

/** Adds landings to the op's record: the creature the landing names first, then what rode with it. A drop's first is its victim. */
export function recordLandings(tx: Tx, tokenIds: readonly TokenId[], sceneId: SceneId, how: Landing["how"]): void {
  const openings = OPENINGS.get(tx);
  if (!openings) return;
  for (const tokenId of tokenIds) openings.landings.push({ tokenId, sceneId, how });
  if (how === "drop" && tokenIds[0] !== undefined) openings.dropped.add(tokenIds[0]);
}

/**
 * Whether something holds the creature up where it stands (4.1): a seat on
 * a holder on its floor that counts. Every holder counts for a DM's op,
 * and for a player's only one every player saw before the op, since a fall
 * is a shared write that a holder some player cannot see must not change
 * (10.3). A trapdoor reads the same rule for its victims (4.6).
 */
export function heldUp(tx: Tx, before: RoomState, token: Token): boolean {
  const link = token.attached;
  if (!link || !onHolder(link.kind)) return false;
  const holder = ownEntry(tx.state.tokens, link.to);
  if (!holder || holder.id === token.id || holder.sceneId !== token.sceneId) return false;
  if (tx.actor.role === "dm") return true;
  const was = ownEntry(before.tokens, holder.id);
  return was !== undefined && inSightOfNonOwners(before, was, tx.env);
}

/** The opening's upper end the creature stands over (4.1): on the ground, its space wholly inside the hole, or undefined. */
function holeUnder(state: RoomState, token: Token): FloorLink | undefined {
  if (!isCreature(token)) return undefined;
  const hole = linksOn(state, token.sceneId).find((link) => isHole(state, link) && ownEntry(state.floorLinks, link.pair) !== undefined && spaceOn(state, token, link));
  // The ground under its space last: the hole's squares are one height, but its space reads its own.
  return hole && token.elevation === footprintGround(state.buildChunks, token) ? hole : undefined;
}

/** Whether an op's write placed a token anew: its floor, place, height, size or squeeze, or a seat it left (4.1). */
function placed(was: Token, now: Token): boolean {
  const seated = (t: Token) => t.attached !== undefined && onHolder(t.attached.kind);
  return (
    was.sceneId !== now.sceneId ||
    was.x !== now.x ||
    was.y !== now.y ||
    was.elevation !== now.elevation ||
    was.size !== now.size ||
    was.w !== now.w ||
    was.h !== now.h ||
    (was.squeeze === true) !== (now.squeeze === true) ||
    (seated(was) && !seated(now))
  );
}

/** Whether the op places an opening's squares (4.1): a new pair, or new squares for one. A copied scene's ends are neither. */
function placesEnds(op: Op): boolean {
  return op.t === "floorLink.put" || (op.t === "floorLink.update" && (op.patch.rect !== undefined || op.patch.pairRect !== undefined));
}

/**
 * The fall pass's candidates (4.1): every token the op placed anew and
 * that stood in the room before it, and every token standing on the upper
 * end of an opening whose squares a `floorLink.put` or a `floorLink.update`
 * wrote. None for a create, a copied scene, a floor reorder, an undo, a
 * redo or a restore, which never fall (4.1, D-261119-007, D-261120-008):
 * a creature placed on a hole stands there until it moves. The creatures
 * trapdoors dropped join them from the op's record.
 */
export function fallCandidates(tx: Tx, before: RoomState, op: Op): Set<TokenId> {
  const out = new Set<TokenId>();
  // A room without an opening has nothing to fall through, so most ops read no further.
  if (op.t === "sys.restore" || !Object.values(tx.state.floorLinks ?? {}).some((link) => link.kind === "opening")) return out;
  const ends = placesEnds(op);
  for (const key of tx.touched()) {
    if (key.startsWith("token:")) {
      const id = key.slice("token:".length);
      const was = ownEntry(before.tokens, id);
      const now = ownEntry(tx.state.tokens, id);
      if (was && now && placed(was, now)) out.add(id);
    } else if (ends && key.startsWith("floorLink:")) {
      const id = key.slice("floorLink:".length);
      const end = ownEntry(tx.state.floorLinks, id);
      const was = ownEntry(before.floorLinks, id);
      if (!end || !isHole(tx.state, end)) continue;
      if (was && was.sceneId === end.sceneId && was.rect.x === end.rect.x && was.rect.y === end.rect.y && was.rect.w === end.rect.w && was.rect.h === end.rect.h) continue;
      for (const token of Object.values(tx.state.tokens)) if (spaceOn(tx.state, token, end)) out.add(token.id);
    }
  }
  return out;
}

/**
 * The fall pass (4.1, 4.3 step 5): each candidate on the ground whose
 * space lies wholly inside an opening's upper end, held up by nothing by
 * 4.1's rule, falls to the floor below (reducer/floorLinks.ts landThrough)
 * with a card. Each landing joins `landings`, and the pass returns one
 * record a root that fell, with the upper end as it stood before the op
 * and both ends as its player is shown them (`shown`, shownEndsOf).
 * Candidates go in id order, each read where the pass so far left it, and
 * one a fall already carried along is not asked again. A creature that
 * falls alone off a holder that does not count leaves its seat as it
 * lands, as the link pass would, so that holder's own fall later in the
 * pass never carries it twice.
 */
/**
 * Both ends of a pair as a climb or a fall takes `taken` (model.ts
 * ShownEnds): the fields a player who holds both ends is shown of them,
 * which an undo or redo of the step finds again (permissions.ts
 * climbBackCheck).
 */
export function shownEndsOf(taken: FloorLink, pair: FloorLink): ShownEnds {
  const shown: ShownEnds = { kind: taken.kind, rect: { ...taken.rect }, pairRect: { ...pair.rect } };
  if (taken.grid !== undefined) shown.grid = taken.grid;
  return shown;
}

export function fallPass(tx: Tx, before: RoomState, candidates: ReadonlySet<TokenId>, landings: Landing[]): FallRecord[] {
  const records: FallRecord[] = [];
  const landed = new Set<TokenId>();
  for (const id of [...candidates].sort()) {
    if (landed.has(id)) continue;
    const token = ownEntry(tx.state.tokens, id);
    if (!token) continue;
    const hole = holeUnder(tx.state, token);
    if (!hole || heldUp(tx, before, token)) continue;
    const far = ownEntry(tx.state.floorLinks, hole.pair)!;
    const from = token.sceneId;
    const ft = fallDrop(linkHeight(tx.state, hole), hole.ground, far.ground);
    const first = landings.length;
    landThrough(tx, token, hole, "fall");
    for (const landing of landings.slice(first)) landed.add(landing.tokenId);
    leaveSeat(tx, token);
    const card = writeCard(tx, { tokenId: id, sceneId: hole.to, from, ft, riders: ridersSince(tx, id, first) });
    const stood = ownEntry(before.floorLinks, hole.id) ?? hole;
    const below = ownEntry(before.floorLinks, stood.pair) ?? far;
    records.push({ tokenId: id, linkId: hole.id, rev: stood.rev, made: stood.made, from, to: hole.to, fallId: card.id, shown: shownEndsOf(stood, below) });
  }
  return records;
}

/**
 * The creatures that landed with `root` since the op's landing `first`
 * (D-261120-007): what rode on it and what they carried, in the order they
 * landed, at most FALL_RIDERS_MOST. Its card names them, so its Apply asks
 * each the fall's damage and Prone, as a rider whose holder does not count
 * falls alone with a card of its own.
 */
export function ridersSince(tx: Tx, root: TokenId, first: number): TokenId[] {
  const out: TokenId[] = [];
  for (const { tokenId } of OPENINGS.get(tx)?.landings.slice(first) ?? []) {
    const token = ownEntry(tx.state.tokens, tokenId);
    if (tokenId !== root && token !== undefined && isCreature(token) && !out.includes(tokenId)) out.push(tokenId);
  }
  return out.slice(0, FALL_RIDERS_MOST);
}

/** A creature that fell or dropped alone off a holder still seats it on the holder it left behind: that seat goes (4.1). */
export function leaveSeat(tx: Tx, was: Token): void {
  const now = ownEntry(tx.state.tokens, was.id);
  if (!now?.attached || !onHolder(now.attached.kind)) return;
  const { attached: _left, ...loose } = now;
  tx.write(keys.token(now.id), loose);
}

/** Drops the oldest cards past LIMITS.fallsPerRoom (4.4). */
function evict(tx: Tx): void {
  const all = Object.values(tx.state.falls ?? {});
  if (all.length <= LIMITS.fallsPerRoom) return;
  all.sort(byFallAge);
  for (const old of all.slice(0, all.length - LIMITS.fallsPerRoom)) tx.remove(keys.fall(old.id));
}

/**
 * A new card (4.4): its id the op's seq and its place among the op's
 * cards, `made` the op's seq, its riders where any fell with it, written
 * in the op's undo step, the oldest dropped past LIMITS.fallsPerRoom. No name
 * is stored.
 */
export function writeCard(tx: Tx, fields: Pick<Fall, "tokenId" | "sceneId" | "from" | "ft"> & { riders: readonly TokenId[] }): Fall {
  const openings = OPENINGS.get(tx);
  const place = openings ? openings.cards++ : 0;
  const card: Fall = { id: `${tx.env.seq}:${place}`, rev: 0, tokenId: fields.tokenId, ...(fields.riders.length > 0 ? { riders: [...fields.riders] } : {}), sceneId: fields.sceneId, from: fields.from, ft: fields.ft, made: tx.env.seq };
  tx.write(keys.fall(card.id), card);
  evict(tx);
  return card;
}

/**
 * The cards whose creatures a DM's op deleted (4.4): a card goes once the
 * op leaves none of the creatures it names, the one that fell and its
 * riders, where one stood before, in the op's undo step, so the undo of
 * the delete brings it back. While a rider stands, its card stays for it
 * (D-261120-007). A player's op leaves every card, so a dismissed
 * companion's card stays for the DM (4.7).
 */
export function dropGoneCards(tx: Tx, before: RoomState): void {
  if (tx.actor.role !== "dm") return;
  const falls = tx.state.falls;
  if (falls === undefined) return;
  for (const card of Object.values(falls).sort(byFallAge)) {
    const named = [card.tokenId, ...(card.riders ?? [])];
    if (named.some((id) => ownEntry(before.tokens, id) !== undefined) && named.every((id) => ownEntry(tx.state.tokens, id) === undefined)) tx.remove(keys.fall(card.id));
  }
}

/**
 * A player's undo or redo of a fall (4.5, `sys.restore` falls): the undo
 * removes each record's card if it is still there, and never refuses for
 * one, and the redo writes back only the card a record carries, the one
 * its undo removed. So damage already applied is never asked for twice.
 * Any restore then evicts as a new card does, since a DM's undo of a
 * delete or a Dismiss puts back cards the room may since have filled the
 * place of, and no room holds more than LIMITS.fallsPerRoom.
 */
export function restoreFallCards(tx: Tx, op: OpOf<"sys.restore">): void {
  for (const record of op.falls ?? []) {
    if (op.from === "undo") {
      if (ownEntry(tx.state.falls, record.fallId) !== undefined) tx.remove(keys.fall(record.fallId));
    } else if (record.card !== undefined) {
      tx.write(keys.fall(record.card.id), record.card);
    }
  }
  evict(tx);
}

/** `fall.settle` (4.4): the DM's Dismiss of a fall card, the whole card, refused once it went. */
export function fallSettle(tx: Tx, op: OpOf<"fall.settle">): void {
  if (ownEntry(tx.state.falls, op.fallId) === undefined) throw invalid(FALL_SETTLED);
  tx.remove(keys.fall(op.fallId));
}

/**
 * What a group save's outcome settles of a card (`actor.outcome`'s `fall`,
 * 4.4, FLR4INT-ASTRA-05): the creatures it names, applied or skipped,
 * leave the card in the same op, and with each one every other token the
 * card names of the same creature, as two riders that show one character,
 * on whatever scene, as do the tokens of a creature the outcome targets
 * (FLR4-SOL-22). One creature takes its fall once, whichever token took
 * it. Any other the card still names and the room still holds stays on
 * it, such as a rider the DM's page could not reach on another scene, so
 * no damage the card holds is lost. The card goes once none is left. An
 * outcome naming a creature the card no longer names is refused, so
 * another device's Apply never applies it twice.
 */
export function settleFallOutcome(tx: Tx, fall: { fallId: FallId; tokenIds: readonly TokenId[] }, targets: readonly { target: ActorTarget }[] = []): void {
  const card = ownEntry(tx.state.falls, fall.fallId);
  const named = card ? [card.tokenId, ...(card.riders ?? [])] : [];
  if (!card || fall.tokenIds.some((id) => !named.includes(id))) throw invalid(FALL_SETTLED);
  // The key actorOutcome counts a creature once by: its character, else its token.
  const creature = (target: ActorTarget): string | undefined => {
    const resolved = tx.tryResolveActor(target);
    return resolved && `${resolved.holder}:${resolved.id}`;
  };
  const settledCreatures = new Set([...fall.tokenIds.map((tokenId) => creature({ tokenId })), ...targets.map((t) => creature(t.target))]);
  settledCreatures.delete(undefined);
  const settled = (id: TokenId) => fall.tokenIds.includes(id) || settledCreatures.has(creature({ tokenId: id }));
  const left = named.filter((id) => !settled(id) && ownEntry(tx.state.tokens, id) !== undefined);
  if (left.length === named.length) return;
  const [first, ...riders] = left;
  if (first === undefined) {
    tx.remove(keys.fall(card.id));
    return;
  }
  const { riders: _riders, ...rest } = card;
  tx.write(keys.fall(card.id), { ...rest, tokenId: first, ...(riders.length > 0 ? { riders } : {}) });
}
