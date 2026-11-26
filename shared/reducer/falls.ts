import { keys } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import { fallsOnce } from "../migrate.ts";
import { FALL_RIDERS_MOST, type Fall, type FallId, type FallRecord, type FloorLink, type RoomState, type SceneId, type ShownEnds, type Token, type TokenId, type Trap } from "../model.ts";
import type { ActorTarget, Op, OpOf } from "../protocol.ts";
import { inSightOfNonOwners } from "../project.ts";
import { ownEntry } from "../records.ts";
import { isCreature, onHolder } from "../rules/attach.ts";
import { fallDice, fallDrop, isHole, linkHeight, linksOn, spaceOn } from "../rules/floorLinks.ts";
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
 * landing reminders read them all. A drop's or a fall's carries the card
 * that took it (`card`): the card that names it, the one it joined, or a
 * full one that left it off. A later fall in the op reads those marks,
 * never a card's names, so a token left off a full card still counts its
 * first fall (writeCard).
 */
export type Landing = { tokenId: TokenId; sceneId: SceneId; how: "climb" | "flight" | "drop" | "fall"; card?: FallId };

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

/**
 * The fall pass (4.1, 4.3 step 5): each candidate on the ground whose
 * space lies wholly inside an opening's upper end, held up by nothing by
 * 4.1's rule, falls to the floor below (reducer/floorLinks.ts landThrough)
 * with a card. Each landing joins `landings`, and the pass returns one
 * record a root that fell, since the undo crosses each root's floors, with
 * the upper end as it stood before the op, both ends as its player is
 * shown them (`shown`, shownEndsOf), and the card that names its fall
 * (writeCard), which from op version 67 another root's record may name too.
 * Candidates go in id order, each read where the pass so far left it, and
 * one a fall already carried along is not asked again. A creature that
 * falls alone off a holder that does not count leaves its seat as it
 * lands, as the link pass would, so that holder's own fall later in the
 * pass never carries it twice.
 */
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
    const fallId = writeCard(tx, { tokenId: id, sceneId: hole.to, from, ft, riders: ridersSince(tx, id, first) });
    const stood = ownEntry(before.floorLinks, hole.id) ?? hole;
    const below = ownEntry(before.floorLinks, stood.pair) ?? far;
    records.push({ tokenId: id, linkId: hole.id, rev: stood.rev, made: stood.made, from, to: hole.to, fallId, shown: shownEndsOf(stood, below) });
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

/** Every token a card names: the one that fell, then its riders. */
function namesOf(card: Fall): TokenId[] {
  return [card.tokenId, ...(card.riders ?? [])];
}

/** A card naming these tokens, the first as the one that fell, or none where the list is empty. */
function withNames(card: Fall, names: readonly TokenId[]): Fall | undefined {
  const [first, ...riders] = names;
  if (first === undefined) return undefined;
  const { riders: _riders, ...rest } = card;
  return { ...rest, tokenId: first, ...(riders.length > 0 ? { riders } : {}) };
}

/**
 * The key a card counts a creature once by, as a group save's outcome
 * settles it (settleFallOutcome): its character, else its token. Undefined
 * for a token whose character cannot be resolved, which matches no other.
 */
function creatureOf(tx: Tx, target: ActorTarget): string | undefined {
  const resolved = tx.tryResolveActor(target);
  return resolved && `${resolved.holder}:${resolved.id}`;
}

/** Marks a token's latest landing, the one the card being written is for, with the card that took it. */
function markTaken(openings: Openings | undefined, tokenId: TokenId, card: FallId): void {
  const landings = openings?.landings ?? [];
  for (let i = landings.length - 1; i >= 0; i--) {
    if (landings[i]!.tokenId !== tokenId) continue;
    landings[i]!.card = card;
    return;
  }
}

/**
 * A fall's or a drop's card (4.4): a new card's id is the op's seq and its
 * place among the op's cards, `made` the op's seq, its riders where any
 * fell with it, written in the op's undo step, the oldest dropped past
 * LIMITS.fallsPerRoom. No name is stored. Returns the card that names the
 * root's fall after the write.
 *
 * From op version 67 (fallsOnce) a creature falls once a step: each token
 * the card would name, the root then its riders, joins a card the op
 * already wrote and that still stands where one is eligible, so damage and
 * Prone apply once. Eligible means it names another token of the token's
 * creature, no earlier landing of the token in this op went to it (a
 * token's own second fall keeps a card of its own), and its drop deals
 * damage exactly where this one does: a no-damage card has no Apply, so a
 * damaging fall never joins one. The token joins the first eligible card
 * that landed on its floor, else the first. A full card takes no more: the
 * token is left off it and off the new card, its creature still named
 * there by its other tokens. Only what is left goes on a new card, and
 * none is written where nothing is. The root's record names the new card
 * where one is written, else the card the root joined or was left off.
 */
export function writeCard(tx: Tx, fields: Pick<Fall, "tokenId" | "sceneId" | "from" | "ft"> & { riders: readonly TokenId[] }): FallId {
  const openings = OPENINGS.get(tx);
  const named = [fields.tokenId, ...fields.riders];
  let own: TokenId[] = named;
  const took = new Map<TokenId, FallId>();
  if (openings && fallsOnce(tx.env.opVersion)) {
    own = [];
    const damages = (ft: number) => fallDice(ft) > 0;
    const standing = Object.values(tx.state.falls ?? {})
      .filter((card) => card.made === tx.env.seq)
      .sort(byFallAge);
    for (const id of named) {
      const creature = creatureOf(tx, { tokenId: id });
      const earlier = new Set(openings.landings.flatMap((l) => (l.tokenId === id && l.card !== undefined ? [l.card] : [])));
      const eligible =
        creature === undefined
          ? []
          : standing.filter((card) => !earlier.has(card.id) && damages(card.ft) === damages(fields.ft) && namesOf(card).some((other) => other !== id && creatureOf(tx, { tokenId: other }) === creature));
      const target = eligible.find((card) => card.sceneId === fields.sceneId) ?? eligible[0];
      if (target === undefined) {
        own.push(id);
        continue;
      }
      took.set(id, target.id);
      if (namesOf(target).length > FALL_RIDERS_MOST) continue;
      const joined = withNames(target, [...namesOf(target), id])!;
      standing[standing.indexOf(target)] = joined;
      tx.write(keys.fall(joined.id), joined);
    }
  }
  for (const [id, card] of took) markTaken(openings, id, card);
  if (own.length === 0) return took.get(fields.tokenId)!;
  const place = openings ? openings.cards++ : 0;
  const [first, ...riders] = own as [TokenId, ...TokenId[]];
  const card: Fall = { id: `${tx.env.seq}:${place}`, rev: 0, tokenId: first, ...(riders.length > 0 ? { riders } : {}), sceneId: fields.sceneId, from: fields.from, ft: fields.ft, made: tx.env.seq };
  tx.write(keys.fall(card.id), card);
  for (const id of own) markTaken(openings, id, card.id);
  evict(tx);
  return card.id;
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
    const named = namesOf(card);
    if (named.some((id) => ownEntry(before.tokens, id) !== undefined) && named.every((id) => ownEntry(tx.state.tokens, id) === undefined)) tx.remove(keys.fall(card.id));
  }
}

/**
 * A player's undo or redo of a fall (4.5, `sys.restore` falls), which
 * never refuses for a card. The undo takes off each record's card, while
 * it is there, the creatures this restore moved back: a token whose floor
 * or square `before` (the room before the restore) and now differ, or
 * that is gone from the room, and only where every token of its creature
 * the card names is one. A creature with a token the restore left in
 * place stays on the card whole, such as a rider the DM hid or took off
 * its mount after the fall, or another token of a creature folded onto
 * the card, so an undo never splits a creature and never loses a fall
 * still owed. The card goes once it names none, as where everything went
 * back up. The redo writes back only the part a record carries, the part
 * its undo took off (server/rooms/undo.ts fallsRestored): its names after
 * those of the card where it still stands and lacks them, else as the
 * card where one of its tokens is still in the room. So damage already
 * applied is never asked for twice. Ops before
 * version 67 (fallsOnce) removed the card whole and wrote the record's
 * card over any standing, and replay so. Any restore then evicts as a new
 * card does, since a DM's undo of a delete or a Dismiss puts back cards
 * the room may since have filled the place of, and no room holds more
 * than LIMITS.fallsPerRoom.
 */
export function restoreFallCards(tx: Tx, op: OpOf<"sys.restore">, before: RoomState): void {
  const once = fallsOnce(tx.env.opVersion);
  for (const record of op.falls ?? []) {
    if (op.from === "undo") {
      const card = ownEntry(tx.state.falls, record.fallId);
      if (card === undefined) continue;
      if (!once) {
        tx.remove(keys.fall(card.id));
        continue;
      }
      const left = namesLeftAfterUndo(tx, before, card);
      if (left.length === namesOf(card).length) continue;
      const trimmed = withNames(card, left);
      if (trimmed) tx.write(keys.fall(card.id), trimmed);
      else tx.remove(keys.fall(card.id));
    } else if (record.card !== undefined) {
      const standing = once ? ownEntry(tx.state.falls, record.card.id) : undefined;
      if (standing === undefined) {
        // A part whose every token has left the room since names no fall left to take, so no card comes back for it.
        if (!once || namesOf(record.card).some((id) => ownEntry(tx.state.tokens, id) !== undefined)) tx.write(keys.fall(record.card.id), record.card);
        continue;
      }
      const lacking = namesOf(record.card).filter((id) => !namesOf(standing).includes(id));
      if (lacking.length > 0) tx.write(keys.fall(standing.id), withNames(standing, [...namesOf(standing), ...lacking])!);
    }
  }
  evict(tx);
}

/** The tokens an undo leaves on a card (restoreFallCards): every one but those of a creature it moved back whole. */
function namesLeftAfterUndo(tx: Tx, before: RoomState, card: Fall): TokenId[] {
  const named = namesOf(card);
  const moved = (id: TokenId) => {
    const was = ownEntry(before.tokens, id);
    const now = ownEntry(tx.state.tokens, id);
    return !was || !now || was.sceneId !== now.sceneId || was.x !== now.x || was.y !== now.y;
  };
  // A token whose creature cannot be resolved, one gone from the room among them, is a creature of its own.
  const creature = (id: TokenId) => creatureOf(tx, { tokenId: id }) ?? `alone:${id}`;
  const stays = new Set(named.filter((id) => !moved(id)).map(creature));
  return named.filter((id) => stays.has(creature(id)));
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
  const named = card ? namesOf(card) : [];
  if (!card || fall.tokenIds.some((id) => !named.includes(id))) throw invalid(FALL_SETTLED);
  // The key actorOutcome counts a creature once by: its character, else its token.
  const creature = (target: ActorTarget): string | undefined => creatureOf(tx, target);
  const settledCreatures = new Set([...fall.tokenIds.map((tokenId) => creature({ tokenId })), ...targets.map((t) => creature(t.target))]);
  settledCreatures.delete(undefined);
  const settled = (id: TokenId) => fall.tokenIds.includes(id) || settledCreatures.has(creature({ tokenId: id }));
  const left = named.filter((id) => !settled(id) && ownEntry(tx.state.tokens, id) !== undefined);
  if (left.length === named.length) return;
  const rest = withNames(card, left);
  if (rest) tx.write(keys.fall(card.id), rest);
  else tx.remove(keys.fall(card.id));
}
