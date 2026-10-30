import { keys, parseKey, readEntity, revOf, type EntityKey, type ParsedKey } from "../keys.ts";
import { oldSrdIdGuards, withOldSrdIds } from "../migrate.ts";
import { MOVE_PLAYERS_FIRST_BACK } from "../permissions.ts";
import type { AreaTemplate, BuildChunk, CompanionBlock, Encounter, FogDraft, Handout, HandoutDoc, Pin, RoomState, Scene, Token, Trap } from "../model.ts";
import type { OpOf, RestoreEntry } from "../protocol.ts";
import { LIMITS } from "../limits.ts";
import { allKeys, gridOfToken } from "../project.ts";
import { holderOf, linkHolds } from "../rules/attach.ts";
import { autoWallsOf } from "../rules/autoWalls.ts";
import { restoreRefusal, restoredHolds, sceneHolds } from "../rules/grid.ts";
import { turnUnderWay } from "../rules/path.ts";
import { ON_ITS_TURN_NOW, actsOnCharacterTurn, rowsForSharedCompanions, syncOwners } from "./companions.ts";
import { rowLeadsMounts } from "./encounter.ts";
import { writeHpUndoLine } from "./hpUndo.ts";
import { forgetExplored } from "./map.ts";
import { gone, guardHash, invalid, type Tx } from "./tx.ts";

export function logChat(tx: Tx, op: OpOf<"log.chat">): void {
  tx.addLog({ kind: "chat", from: tx.actor.memberId, text: op.text });
}

export function logWhisper(tx: Tx, op: OpOf<"log.whisper">): void {
  for (const id of op.to) if (!tx.state.members[id]) throw gone("member");
  tx.addLog({ kind: "whisper", from: tx.actor.memberId, to: op.to, text: op.text });
}

/**
 * Showing a handout again updates it in place, so a re-show is one upsert
 * and one log line. A handout of pages names its first page as `assetId`
 * too, written here so the two never drift, and a re-show as one image
 * drops the pages it had (docs/design-v1-pdf-handouts.md 3.3).
 */
export function handoutShow(tx: Tx, op: OpOf<"handout.show">): void {
  const input = op.handout;
  const existing = tx.state.handouts[input.id];
  const first = "pages" in input ? input.pages[0]?.assetId : input.assetId;
  if (first === undefined) throw invalid("a handout has at least one page");
  const handout: Handout = {
    id: input.id,
    rev: existing?.rev ?? 0,
    assetId: first,
    ...("pages" in input ? { pages: input.pages } : {}),
    title: input.title,
    to: input.to,
    shownAt: tx.env.at,
  };
  tx.write(keys.handout(handout.id), handout);
  tx.addEvent({ type: "handout", handoutId: handout.id });
}

export function handoutClose(tx: Tx, op: OpOf<"handout.close">): void {
  if (!tx.state.handouts[op.handoutId]) throw gone("handout");
  tx.remove(keys.handout(op.handoutId));
}

/**
 * Saves a PDF as a document of pages in the DM's library, under the id the
 * upload chose before it began (docs/design-v1-pdf-handouts.md 3.3). An id in
 * use is refused, so a create sent again after a lost answer never makes a
 * second document. Documents log nothing, as saved encounters do.
 */
export function handoutDocCreate(tx: Tx, op: OpOf<"handoutDoc.create">): void {
  if (tx.state.handoutDocs[op.doc.id]) throw invalid("that handout is already saved");
  const doc: HandoutDoc = { id: op.doc.id, rev: 0, title: op.doc.title, pages: op.doc.pages, createdAt: tx.env.at };
  tx.write(keys.handoutDoc(doc.id), doc);
}

/** Deletes a document. Its images stay until the DM's device deletes them through the library (section 3.5). */
export function handoutDocDelete(tx: Tx, op: OpOf<"handoutDoc.delete">): void {
  if (!tx.state.handoutDocs[op.docId]) throw gone("handout");
  tx.remove(keys.handoutDoc(op.docId));
}

/**
 * The guard refusal. It does not say who: the change may have come from
 * another DM, or from this DM's own other device, which is its own member
 * with its own undo stack.
 */
export const CHANGED_SINCE = "it was changed since";

/**
 * An absolute restore (design 7.7). Every entry's guard is checked before
 * anything is written, so a restore applies entirely or not at all. A
 * mismatch means someone changed the entity since, and the undo entry is
 * dropped rather than applied on top of their work.
 *
 * New entries are guarded by value (Tx.inverse). A rev guard is still
 * honored, because stored restores from before value guards replay with
 * the rev they were made with. A restore stored before the dragon turtle's
 * SRD id was renamed hashed its values with the old id, so its guard also
 * matches the entity spelled that way (shared/migrate.ts, op step 9 to 10).
 */
export function restore(tx: Tx, op: OpOf<"sys.restore">): void {
  const removed: ParsedKey[] = [];
  const before = new Map<EntityKey, unknown>();
  for (const entry of op.entries) {
    const parsed = parseKey(entry.key);
    if (!parsed) throw invalid(`unknown entity key ${entry.key}`);
    if (parsed.kind === "log" || parsed.kind === "trapLog" || parsed.kind === "trapSeen") throw invalid("log entries are never restored");
    const current = tx.read(entry.key);
    before.set(entry.key, current);
    const matches = guardMatches(entry, current) || (oldSrdIdGuards(tx.env.opVersion) && guardMatches(entry, withOldSrdIds(entry.key, current)));
    if (!matches) throw invalid(CHANGED_SINCE);
    if (entry.key === keys.meta && (entry.value === null || entry.value === undefined)) throw invalid("the room meta cannot be removed");
    if (current !== null && (entry.value === null || entry.value === undefined)) removed.push(parsed);
  }
  // Restored chunks move walls, so their scenes' walls versions move on.
  const wallsMoved = new Set<string>();
  for (const entry of op.entries) {
    const parsed = parseKey(entry.key);
    if (parsed?.kind === "chunk") wallsMoved.add(parsed.sceneId);
  }
  const scenesWritten = new Set<string>();
  for (const entry of op.entries) {
    let value = entry.value === undefined ? null : entry.value;
    const parsed = parseKey(entry.key);
    if (parsed?.kind === "scene" && value !== null) {
      const current = tx.state.scenes[parsed.id];
      value = keepThumb(forwardWalls(value as Scene, current, wallsMoved.has(parsed.id)), current);
      scenesWritten.add(parsed.id);
    }
    tx.write(entry.key, value);
  }
  // A scene a restore takes away takes the party's explored layer with it, as bookkeeping (docs/design-v1-maps-vision.md
  // 4.3.3): it is no one's work, so it never counts as work that depends on the scene.
  for (const p of removed) if (p.kind === "scene" && !tx.state.scenes[p.id]) forgetExplored(tx, p.id);
  shapesHold(tx, op, before);
  // Only a restore the server marked checks references. An older build
  // accepted restores that strand work, and refusing one of those on replay
  // would stop the room's load and leave it read-only.
  if (op.deps) checkReferences(tx, op.entries, before, removed);
  companionsAfterRestore(tx, op.entries);
  if (op.rides) ridesBack(tx, op.rides);
  if (op.undid !== undefined) writeHpUndoLine(tx, op.undid);
  for (const sceneId of [...wallsMoved].sort()) {
    if (!scenesWritten.has(sceneId) && tx.state.scenes[sceneId]) tx.bumpWalls(sceneId);
  }
}

/**
 * The shape's invariant on a restore (docs/design-v1-hex-grids.md HX-D14),
 * refused in the switch's words. Each value written onto a scene passes
 * the stamp check, which runs only when the value holds grid-keyed
 * content, and the phase check, which keeps from a hex scene what its
 * phase leaves out (restoredHolds). A restore that changes a scene's
 * shape, or brings a scene back, must leave that scene as a switch would:
 * nothing on it of another shape, nothing the phase leaves out. So neither
 * two DMs nor a long history brings square data onto hexes, hex data onto
 * squares, or a later phase's things into an earlier one. Stored restores
 * from before hex grids meet only square scenes, whose unstamped data
 * passes both, so they replay as they applied.
 */
function shapesHold(tx: Tx, op: OpOf<"sys.restore">, before: ReadonlyMap<EntityKey, unknown>): void {
  const reshaped = new Set<string>();
  for (const entry of op.entries) {
    const parsed = parseKey(entry.key);
    if (!parsed || entry.value === null || entry.value === undefined) continue;
    const value = tx.read(entry.key);
    if (parsed.kind === "scene") {
      const was = before.get(entry.key) as Scene | null | undefined;
      if (!was || was.gridShape !== (value as Scene).gridShape) reshaped.add(parsed.id);
      continue;
    }
    const placed = placedOn(parsed, value);
    if (!placed) continue;
    const scene = tx.state.scenes[placed.sceneId];
    if (!scene) continue;
    const found = restoredHolds(tx.state, placed.kind, placed.value, scene);
    if (found) throw invalid(restoreRefusal(op.from, found, scene));
  }
  for (const sceneId of [...reshaped].sort()) {
    const scene = tx.state.scenes[sceneId];
    const found = scene ? sceneHolds(tx.state, scene) : null;
    if (found && scene) throw invalid(restoreRefusal(op.from, found, scene));
  }
}

/** A restored value the shape's checks read, with the scene it stands on. */
function placedOn(
  parsed: ParsedKey,
  value: unknown,
): { kind: "chunk"; value: BuildChunk; sceneId: string } | { kind: "fogDraft"; value: FogDraft; sceneId: string } | { kind: "trap"; value: Trap; sceneId: string } | { kind: "token"; value: Token; sceneId: string } | null {
  switch (parsed.kind) {
    case "chunk":
      return { kind: "chunk", value: value as BuildChunk, sceneId: parsed.sceneId };
    case "fogDraft":
      return { kind: "fogDraft", value: value as FogDraft, sceneId: parsed.sceneId };
    case "trap":
      return { kind: "trap", value: value as Trap, sceneId: (value as Trap).sceneId };
    case "token":
      return { kind: "token", value: value as Token, sceneId: (value as Token).sceneId };
    default:
      return null;
  }
}

/**
 * A restore writes saved values, so it could bring back a row for a
 * companion that now acts on its character's turn, or owners a companion's
 * character no longer has (docs/design-v1-combat-flow.md 3.6.4 and 3.6.8).
 * The row is refused: the undo of the companion's own change puts its row
 * back with its turn, which passes. The owners are reconciled rather than
 * refused, so an undo is never blocked by a companion: each companion of a
 * character the restore wrote, or of a companion token it wrote, takes
 * its character's owners. Stored restores from before companions find
 * none, so they replay as they applied.
 */
function companionsAfterRestore(tx: Tx, entries: RestoreEntry[]): void {
  const s = tx.state;
  // A restore that writes the fight, its history, or a companion that now acts on its character's turn is checked
  // against both: a token-only undo of a turn change can bring back a `shared` companion while another DM added its row.
  const touches = entries.some((e) => {
    if (e.key === keys.encounter || e.key === keys.encounterHistory) return true;
    const parsed = parseKey(e.key);
    return parsed?.kind === "token" && actsOnCharacterTurn(s.tokens[parsed.id]);
  });
  if (touches && (rowsForSharedCompanions(s, s.encounter) || s.encounterHistory.some((step) => rowsForSharedCompanions(s, step.encounter)))) {
    throw invalid(ON_ITS_TURN_NOW);
  }
  const characters = new Set<string>();
  for (const entry of entries) {
    const parsed = parseKey(entry.key);
    if (parsed?.kind === "character") characters.add(parsed.id);
    if (parsed?.kind === "token") {
      const of = s.tokens[parsed.id]?.companion?.of;
      if (of !== undefined) characters.add(of);
    }
  }
  syncOwners(tx, [...characters].sort());
}

/**
 * A player's undo of a Get off, or redo of a mounting, puts the mount back
 * on the turn's list (docs/design-v1-attach.md 8.3): only for the turn the
 * step was made on, the same seq, and only while the restored ride is the
 * one it names, a mount the turn's creature rides by controlled rides that
 * hold, up the whole chain as the turn's start lists them, on an acting row
 * every player sees (rowLeadsMounts). It never adds a mount the turn did
 * not have and never touches `markRound`.
 */
function ridesBack(tx: Tx, rides: NonNullable<OpOf<"sys.restore">["rides"]>): void {
  for (const ride of rides) {
    const encounter = tx.state.encounter;
    const turn = turnUnderWay(encounter);
    if (!encounter || !turn || turn.seq !== ride.seq || turn.tokenId !== ride.rider) continue;
    if (!rowLeadsMounts(tx, encounter, encounter.entries.find((e) => e.id === turn.entryId))) continue;
    const mount = tx.state.tokens[ride.mount];
    if (!mount || !ridesUpTo(tx.state, ride.rider, mount.id)) continue;
    const mounts = turn.mounts ?? [];
    if (mounts.includes(mount.id) || mounts.length >= LIMITS.turnMounts) continue;
    tx.write(keys.encounter, { ...encounter, turnStart: { ...encounter.turnStart!, mounts: [...mounts, mount.id] } });
  }
}

/** Whether `mountId` is up `riderId`'s chain of controlled rides, each of which holds (7.1). */
function ridesUpTo(state: RoomState, riderId: string, mountId: string): boolean {
  const seen = new Set<string>();
  for (let rider = state.tokens[riderId]; rider && !seen.has(rider.id); ) {
    seen.add(rider.id);
    const link = rider.attached;
    const holder = link?.kind === "ride" && link.steer === true ? (holderOf(state.tokens, rider) as Token | undefined) : undefined;
    if (!holder || !linkHolds(gridOfToken(state, rider), state.meta.settings, "ride", rider, holder)) return false;
    if (holder.id === mountId) return true;
    rider = holder;
  }
  return false;
}

/** The refusal when a restore would take away a scene, character or token that other work still uses. */
export const DEPENDED_ON = "other work depends on it";
/** The refusal when a restore would put back something whose scene, character or token was deleted since. */
export const PARENT_GONE = "what it belongs to was deleted since";

/** The current entities behind a reference refusal, for value-based attribution without applying any restore. */
export function restoreReferenceConflicts(state: RoomState, entries: readonly RestoreEntry[]): EntityKey[] {
  const restored = new Map(entries.map((entry) => [entry.key, entry.value ?? null]));
  const after = (key: string) => restored.has(key) ? restored.get(key) : readEntity(state, key);
  const removed = new Set(entries.filter((entry) => entry.value == null && readEntity(state, entry.key) !== null).map((entry) => entry.key));
  const conflicts = new Set<string>();
  for (const entry of entries) {
    const parsed = parseKey(entry.key);
    if (!parsed) continue;
    const held = new Set(referencesOf(parsed, readEntity(state, entry.key)));
    for (const ref of referencesOf(parsed, entry.value ?? null)) if (!held.has(ref) && after(ref) == null) conflicts.add(ref);
  }
  if (removed.size > 0) {
    for (const key of new Set([...allKeys(state), ...restored.keys()])) {
      const parsed = parseKey(key);
      if (parsed && referencesOf(parsed, after(key)).some((ref) => removed.has(ref))) conflicts.add(key);
    }
  }
  return [...conflicts];
}

/**
 * A restore never leaves anything pointing at a scene, a character or a
 * token that is gone (design 7.7). Guards compare only what the step itself
 * touched, so they miss work that merely refers to it: another DM painting
 * the scene this DM is undoing the creation of, placing a token of the
 * character being taken back, or rolling initiative for the token being
 * taken back. Removing it would strand that work, so the undo is refused
 * instead. The other way round, a token, an initiative row, an area or
 * anything on a scene put back after what it refers to was deleted would
 * be stranded the same way.
 *
 * Runs on the state after the restore's writes, so a step that takes a
 * scene back together with everything on it (undoing a scene delete's redo)
 * passes. Removing a scene or a token scans the room, which only an undo
 * ever asks for.
 *
 * A reference the entity already held before the restore is not checked
 * again. In a room with nothing stranded it still exists, or this restore
 * removes it and the scan refuses that. Only a room where a restore stored
 * by an older build stranded work holds one that is gone, and refusing every
 * later undo of that entity would not bring it back.
 *
 * Effect durations anchored to a token are not checked. Deleting a token
 * keeps them, paused (removeEntries and unbindDurations), so a restore that
 * takes a token away leaves them just as a delete would. A token that no
 * initiative row names has no running duration left to strand.
 *
 * A player's undo and redo of a move pass these checks too, since every
 * restore the server builds sets `deps`, and never trip them on a link
 * (docs/design-v1-attach.md 8.0 and 8.3). Such a restore writes only poses
 * and takes no token away, so the scans for work that depends on it never
 * run, and it puts a link back only to a holder that still exists
 * (server/rooms/undo.ts putBack) or keeps the one the token has now. So a
 * hidden holder, there or deleted since, never changes its answer.
 */
function checkReferences(tx: Tx, entries: RestoreEntry[], before: Map<EntityKey, unknown>, removed: ParsedKey[]): void {
  const s = tx.state;
  for (const entry of entries) {
    const parsed = parseKey(entry.key)!;
    const held = new Set(referencesOf(parsed, before.get(entry.key) ?? null));
    for (const ref of referencesOf(parsed, entry.value ?? null)) {
      if (!held.has(ref) && tx.read(ref) === null) throw invalid(PARENT_GONE);
    }
  }
  const scenes = new Set(removed.flatMap((p) => (p.kind === "scene" ? [p.id] : [])));
  const characters = new Set(removed.flatMap((p) => (p.kind === "character" ? [p.id] : [])));
  const tokens = new Set(removed.flatMap((p) => (p.kind === "token" ? [p.id] : [])));
  if (scenes.size > 0) {
    // The players' scene says what a delete of it says. Once they move, other work on the scene still refuses it below.
    if (s.meta.playerSceneId !== null && scenes.has(s.meta.playerSceneId)) throw invalid(MOVE_PLAYERS_FIRST_BACK);
    const named = (x: { sceneId: string }) => scenes.has(x.sceneId);
    if (
      Object.values(s.buildChunks).some(named) ||
      Object.values(s.labels).some(named) ||
      Object.values(s.tokens).some(named) ||
      Object.values(s.templates).some(named) ||
      Object.values(s.drawings).some(named) ||
      Object.values(s.fogTiles).some(named) ||
      Object.values(s.fogDrafts).some(named) ||
      Object.values(s.stamps).some(named) ||
      Object.values(s.lights).some(named) ||
      Object.values(s.pins).some(named) ||
      Object.values(s.traps ?? {}).some(named)
    ) {
      throw invalid(DEPENDED_ON);
    }
  }
  // A pin never names a page that is gone (docs/design-v1-dm-tools.md 3.8).
  const pages = new Set(removed.flatMap((p) => (p.kind === "journal" ? [p.id] : [])));
  if (pages.size > 0 && Object.values(s.pins).some((pin) => pin.pageId !== undefined && pages.has(pin.pageId))) throw invalid(DEPENDED_ON);
  if (characters.size > 0) {
    // A companion uses its character as a character token does (docs/design-v1-combat-flow.md 3.6.4), and so does a stat
    // block the character keeps (docs/design-v1-companion-stat-blocks.md 3.3).
    const tokenUses = Object.values(s.tokens).some((t) => ("ref" in t.actor && characters.has(t.actor.ref)) || (t.companion !== undefined && characters.has(t.companion.of)));
    const entryUses = s.encounter?.entries.some((e) => e.characterId !== undefined && characters.has(e.characterId)) ?? false;
    const blockUses = Object.values(s.companionBlocks).some((b) => characters.has(b.characterId));
    if (tokenUses || entryUses || blockUses) throw invalid(DEPENDED_ON);
  }
  if (tokens.size > 0) {
    const named = (id: string | undefined) => id !== undefined && tokens.has(id);
    const entryUses = s.encounter?.entries.some((e) => named(e.tokenId)) ?? false;
    const templateUses = Object.values(s.templates).some((t) => named(t.attachedTo) || named(t.casterId));
    // A token another one is attached to holds it (docs/design-v1-attach.md 8.3).
    const tokenUses = Object.values(s.tokens).some((t) => named(t.attached?.to));
    if (entryUses || templateUses || tokenUses) throw invalid(DEPENDED_ON);
  }
}

/**
 * The entity keys of the scenes, characters, tokens and journal pages an
 * entity refers to, a companion block's character among them. The scans in
 * checkReferences look for the same references, so the two change together.
 */
function referencesOf(parsed: ParsedKey, value: unknown): EntityKey[] {
  if (value === null || typeof value !== "object") return [];
  const refs: EntityKey[] = [];
  const sceneId = sceneIdOf(parsed, value as Record<string, unknown>);
  if (sceneId !== undefined) refs.push(keys.scene(sceneId));
  if (parsed.kind === "token") {
    const { actor: ref, companion, attached } = value as Partial<Token>;
    if (ref && "ref" in ref) refs.push(keys.character(ref.ref));
    if (companion) refs.push(keys.character(companion.of));
    if (attached) refs.push(keys.token(attached.to));
  }
  if (parsed.kind === "pin") {
    const { pageId } = value as Partial<Pin>;
    if (pageId !== undefined) refs.push(keys.journal(pageId));
  }
  // A token's `blockId` is no reference: a link to a deleted block stays, and reads as deleted (section 3.2, rule 4).
  if (parsed.kind === "companionBlock") {
    const { characterId } = value as Partial<CompanionBlock>;
    if (characterId !== undefined) refs.push(keys.character(characterId));
  }
  if (parsed.kind === "template") {
    const { attachedTo, casterId } = value as Partial<AreaTemplate>;
    if (attachedTo !== undefined) refs.push(keys.token(attachedTo));
    if (casterId !== undefined) refs.push(keys.token(casterId));
  }
  if (parsed.kind === "encounter") {
    for (const row of (value as Partial<Encounter>).entries ?? []) {
      if (row.characterId !== undefined) refs.push(keys.character(row.characterId));
      if (row.tokenId !== undefined) refs.push(keys.token(row.tokenId));
    }
  }
  return refs;
}

/** The scene an entity belongs to, from its key or its value, for those that belong to one. */
function sceneIdOf(parsed: ParsedKey, value: Record<string, unknown>): string | undefined {
  switch (parsed.kind) {
    case "chunk":
    case "fog":
    case "fogDraft":
      return parsed.sceneId;
    case "label":
    case "token":
    case "template":
    case "drawing":
    case "stamp":
    case "light":
    case "pin":
    case "trap":
      return typeof value.sceneId === "string" ? value.sceneId : undefined;
    case "meta": {
      const id = value.playerSceneId;
      return typeof id === "string" ? id : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Whether an entity's current value (null when absent) is what a restore
 * entry's guard expects. An entry with no guard at all, a stored restore
 * from before guards, always matches.
 */
export function guardMatches(entry: RestoreEntry, current: unknown): boolean {
  if (entry.expectRev === null) return current === null;
  if (entry.expectRev !== undefined) return revOf(current) === entry.expectRev;
  if (entry.expectHash !== undefined) return guardHash(entry.key, current) === entry.expectHash;
  return true;
}

/**
 * A restored scene never takes its walls version back (design 7.7): the
 * rules caches are keyed on it, and a version they saw before with other
 * walls would serve those. So it keeps the higher of the restored and the
 * current version, one more when the same restore moves walls, a change of
 * the scene's automatic walls included (docs/design-v1-maps-vision.md 2.1).
 * The scene is written once either way, so its rev moves exactly as it did
 * when stored restores were first applied.
 */
function forwardWalls(restored: Scene, current: Scene | undefined, wallsMoved: boolean): Scene {
  const was = typeof restored.wallsVersion === "number" ? restored.wallsVersion : 0;
  const moved = wallsMoved || (current !== undefined && autoWallsOf(current) !== autoWallsOf(restored));
  const version = Math.max(was, current?.wallsVersion ?? 0) + (moved ? 1 : 0);
  return version === restored.wallsVersion ? restored : { ...restored, wallsVersion: version };
}

/**
 * A restored scene keeps the thumbnail it has now (section 3.3): a
 * thumbnail is bookkeeping like the walls version, so an undo never puts
 * back a stale picture. A scene a restore brings back from nothing keeps
 * the one it had.
 */
function keepThumb(restored: Scene, current: Scene | undefined): Scene {
  if (current === undefined || restored.thumb === current.thumb) return restored;
  const { thumb: _stale, ...rest } = restored;
  return current.thumb === undefined ? rest : { ...rest, thumb: current.thumb };
}
