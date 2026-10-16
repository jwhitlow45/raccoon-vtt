import { keys, parseKey, revOf, type EntityKey, type ParsedKey } from "../keys.ts";
import type { AreaTemplate, Encounter, Handout, Pin, Scene, Token } from "../model.ts";
import type { OpOf, RestoreEntry } from "../protocol.ts";
import { autoWallsOf } from "../rules/autoWalls.ts";
import { ON_ITS_TURN_NOW, rowsForSharedCompanions, syncOwners } from "./companions.ts";
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

/** Showing a handout again updates it in place, so a re-show is one upsert and one log line. */
export function handoutShow(tx: Tx, op: OpOf<"handout.show">): void {
  const input = op.handout;
  const existing = tx.state.handouts[input.id];
  const handout: Handout = {
    id: input.id,
    rev: existing?.rev ?? 0,
    assetId: input.assetId,
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
 * the rev they were made with.
 */
export function restore(tx: Tx, op: OpOf<"sys.restore">): void {
  const removed: ParsedKey[] = [];
  const before = new Map<EntityKey, unknown>();
  for (const entry of op.entries) {
    const parsed = parseKey(entry.key);
    if (!parsed) throw invalid(`unknown entity key ${entry.key}`);
    if (entry.key.startsWith("log:")) throw invalid("log entries are never restored");
    const current = tx.read(entry.key);
    before.set(entry.key, current);
    if (!guardMatches(entry, current)) throw invalid(CHANGED_SINCE);
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
  // Only a restore the server marked checks references. An older build
  // accepted restores that strand work, and refusing one of those on replay
  // would stop the room's load and leave it read-only.
  if (op.deps) checkReferences(tx, op.entries, before, removed);
  companionsAfterRestore(tx, op.entries);
  if (op.undid !== undefined) writeHpUndoLine(tx, op.undid);
  for (const sceneId of [...wallsMoved].sort()) {
    if (!scenesWritten.has(sceneId) && tx.state.scenes[sceneId]) tx.bumpWalls(sceneId);
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
  const written = new Set(entries.map((e) => e.key));
  if (written.has(keys.encounter) && rowsForSharedCompanions(s, s.encounter)) throw invalid(ON_ITS_TURN_NOW);
  if (written.has(keys.encounterHistory) && s.encounterHistory.some((step) => rowsForSharedCompanions(s, step.encounter))) throw invalid(ON_ITS_TURN_NOW);
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

/** The refusal when a restore would take away a scene, character or token that other work still uses. */
export const DEPENDED_ON = "other work depends on it";
/** The refusal when a restore would put back something whose scene, character or token was deleted since. */
export const PARENT_GONE = "what it belongs to was deleted since";

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
    const named = (x: { sceneId: string }) => scenes.has(x.sceneId);
    if (
      (s.meta.playerSceneId !== null && scenes.has(s.meta.playerSceneId)) ||
      Object.values(s.buildChunks).some(named) ||
      Object.values(s.labels).some(named) ||
      Object.values(s.tokens).some(named) ||
      Object.values(s.templates).some(named) ||
      Object.values(s.drawings).some(named) ||
      Object.values(s.fogTiles).some(named) ||
      Object.values(s.fogDrafts).some(named) ||
      Object.values(s.stamps).some(named) ||
      Object.values(s.lights).some(named) ||
      Object.values(s.pins).some(named)
    ) {
      throw invalid(DEPENDED_ON);
    }
  }
  // A pin never names a page that is gone (docs/design-v1-dm-tools.md 3.8).
  const pages = new Set(removed.flatMap((p) => (p.kind === "journal" ? [p.id] : [])));
  if (pages.size > 0 && Object.values(s.pins).some((pin) => pin.pageId !== undefined && pages.has(pin.pageId))) throw invalid(DEPENDED_ON);
  if (characters.size > 0) {
    // A companion uses its character as a character token does (docs/design-v1-combat-flow.md 3.6.4).
    const tokenUses = Object.values(s.tokens).some((t) => ("ref" in t.actor && characters.has(t.actor.ref)) || (t.companion !== undefined && characters.has(t.companion.of)));
    const entryUses = s.encounter?.entries.some((e) => e.characterId !== undefined && characters.has(e.characterId)) ?? false;
    if (tokenUses || entryUses) throw invalid(DEPENDED_ON);
  }
  if (tokens.size > 0) {
    const named = (id: string | undefined) => id !== undefined && tokens.has(id);
    const entryUses = s.encounter?.entries.some((e) => named(e.tokenId)) ?? false;
    const templateUses = Object.values(s.templates).some((t) => named(t.attachedTo) || named(t.casterId));
    if (entryUses || templateUses) throw invalid(DEPENDED_ON);
  }
}

/**
 * The entity keys of the scenes, characters, tokens and journal pages an
 * entity refers to. The scans in checkReferences look for the same
 * references, so the two change together.
 */
function referencesOf(parsed: ParsedKey, value: unknown): EntityKey[] {
  if (value === null || typeof value !== "object") return [];
  const refs: EntityKey[] = [];
  const sceneId = sceneIdOf(parsed, value as Record<string, unknown>);
  if (sceneId !== undefined) refs.push(keys.scene(sceneId));
  if (parsed.kind === "token") {
    const { actor: ref, companion } = value as Partial<Token>;
    if (ref && "ref" in ref) refs.push(keys.character(ref.ref));
    if (companion) refs.push(keys.character(companion.of));
  }
  if (parsed.kind === "pin") {
    const { pageId } = value as Partial<Pin>;
    if (pageId !== undefined) refs.push(keys.journal(pageId));
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
