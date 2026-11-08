import { uuidv7 } from "#shared/ids.ts";
import { chunkKey, compareLogIds, holderChunkKey, holderTileKey, tileKey, parseKey } from "#shared/keys.ts";
import { tilesAcross } from "#shared/rules/fog.ts";
import { isPlainId } from "#shared/rules/traps.ts";
import { cutLine, DM_LINE_BASE, lineAudience, partyIndex, rosterRanks } from "#shared/logRings.ts";
import type {
  Actor,
  AreaTemplate,
  Character,
  CompanionBlock,
  CustomMonster,
  Drawing,
  Effect,
  EffectChange,
  Encounter,
  EncounterSnapshot,
  Handout,
  HandoutDoc,
  HandoutPage,
  ImageRef,
  InitEntry,
  JournalPage,
  Label,
  LineParts,
  LogEntry,
  LogEvent,
  Member,
  MemoryChunk,
  MemoryEntries,
  RoomState,
  SavedEncounter,
  SavedEncounterMonster,
  Scene,
  SceneMark,
  ShareMark,
  SrdImage,
  Stamp,
  Light,
  MapPhase,
  MapVideo,
  Pin,
  Trap,
  TrapAction,
  TrapDue,
  TrapRig,
  SoundFacts,
  Token,
  TurnUses,
  VideoFacts,
} from "#shared/model.ts";
import type { Playlist, SceneSound, Sound } from "#shared/sound.ts";
import { normalizeCompanionState } from "#shared/reducer/companions.ts";
import { keepsMemory } from "#shared/reducer/memory.ts";
import { pausedAnchorForEntry } from "#shared/rules/durations.ts";
import { linkOf, relinked } from "#shared/reducer/uses.ts";
import { withPcActors, withShapeRules } from "#shared/rules/pcStats.ts";
import { phaseMap, withPhaseLight } from "#shared/reducer/phases.ts";
import { normalWeather } from "#shared/weather.ts";
import { soundUseFits, stillFitsVideo } from "#shared/limits.ts";
import { onPlayersScene } from "#shared/rules/floors.ts";
import { checkedVideoFacts } from "#shared/protocol.ts";
import type { AssetKind } from "../assets/kinds.ts";
import { SOUND_MEDIA, soundFactsOfRow } from "../assets/store.ts";

/**
 * Gives every entity of an imported room a fresh id and rewrites every
 * reference (design 16.4), so an import can never collide with or point
 * into another room, and an export file's ids say nothing about the new
 * room. Assets are mapped through the ids the image pipeline assigned; a
 * reference to an asset that did not make it through is dropped rather
 * than left pointing at nothing.
 *
 * So is a reference to an asset of another kind than it takes, which only a
 * hand-made file holds, since every op checks the kind (shared/permissions.ts):
 * a stamp or a token wearing a scene's thumbnail or another phase's image
 * would put that DM-only image in the players' visible set, which is all
 * the asset route asks of a player's read.
 *
 * Members keep their rows but lose their `dm` label: the new room has no
 * grants yet, and only the importer's new DM member holds one.
 */
/** An asset the import's image pipeline made: its new id, and the kind it was made as. */
export type ImportedAsset = { id: string; kind: AssetKind };

export type RemapOptions = {
  /** Old asset id to the asset it became. An asset missing here is dropped from every reference. */
  assets: ReadonlyMap<string, ImportedAsset>;
  /** Old member id to new member id, when the caller already assigned them (asset uploaders need them before the remap). */
  memberIds?: ReadonlyMap<string, string>;
  newId?: () => string;
};

class Ids {
  readonly map: Map<string, string>;
  #newId: () => string;

  constructor(newId: () => string, preset?: ReadonlyMap<string, string>) {
    this.#newId = newId;
    this.map = new Map(preset ?? []);
  }

  assign(oldIds: Iterable<string>): void {
    for (const id of oldIds) if (!this.map.has(id)) this.map.set(id, this.#newId());
  }

  /** The new id, or the old one for a reference nothing in the room resolves. */
  of(id: string): string {
    return this.map.get(id) ?? id;
  }

  has(id: string): boolean {
    return this.map.has(id);
  }
}

export function remapState(state: RoomState, opts: RemapOptions): RoomState {
  const newId = opts.newId ?? (() => uuidv7());
  const members = new Ids(newId, opts.memberIds);
  const scenes = new Ids(newId);
  const tokens = new Ids(newId);
  const characters = new Ids(newId);
  const templates = new Ids(newId);
  const drawings = new Ids(newId);
  const labels = new Ids(newId);
  const handouts = new Ids(newId);
  const entries = new Ids(newId);
  const monsters = new Ids(newId);
  const pages = new Ids(newId);
  const blocks = new Ids(newId);
  const sounds = new Ids(newId);
  const playlists = new Ids(newId);
  members.assign(Object.keys(state.members));
  // Before the scenes, whose sound names both (docs/design/design-v1-music.md 6.7).
  sounds.assign(Object.keys(state.sounds ?? {}));
  playlists.assign(Object.keys(state.playlists ?? {}));
  // Before the actors, which name the room monster a token was placed from (Actor.monsterId).
  monsters.assign(Object.keys(state.monsters));
  pages.assign(Object.keys(state.journal));
  scenes.assign(Object.keys(state.scenes));
  characters.assign(Object.keys(state.characters));
  // Before the actors, which name a companion's block (Actor.blockId). A block goes with its character, so one whose
  // character did not come through is dropped.
  blocks.assign(Object.values(state.companionBlocks).filter((b) => characters.has(b.characterId)).map((b) => b.id));
  // A token whose character is gone would be a dangling actor, which only a live room may hold.
  const liveTokens = Object.values(state.tokens).filter((t) => scenes.has(t.sceneId) && ("inline" in t.actor || characters.has(t.actor.ref)));
  tokens.assign(liveTokens.map((t) => t.id));
  templates.assign(Object.values(state.templates).filter((t) => scenes.has(t.sceneId)).map((t) => t.id));
  // A kept ruler measures from the tokens it is on, so it goes when one of them did not come through.
  const liveDrawing = (d: Drawing) => scenes.has(d.sceneId) && (d.anchors ?? []).every((id) => id === null || tokens.has(id));
  drawings.assign(Object.values(state.drawings).filter(liveDrawing).map((d) => d.id));
  // The new id of an asset, only where its reference takes that kind.
  const asset = (id: string, kind: AssetKind | "sound"): string | undefined => {
    const imported = opts.assets.get(id);
    return imported?.kind === kind ? imported.id : undefined;
  };
  labels.assign(Object.values(state.labels).filter((l) => scenes.has(l.sceneId)).map((l) => l.id));
  /*
   * A handout's or a document's pages in order, each page that came through
   * as a handout image under its new id and the rest dropped
   * (docs/design/design-v1-pdf-handouts.md 3.6). One image is the list of its one page.
   */
  const handoutPagesOf = (list: readonly HandoutPage[]): HandoutPage[] =>
    list.flatMap((page) => {
      const mapped = asset(page.assetId, "handout");
      return mapped ? [{ ...page, assetId: mapped }] : [];
    });
  // A handout's images under their new ids, `assetId` its first page as the reducer writes it, or null with none left.
  const handoutImages = (h: Handout): Pick<Handout, "assetId" | "pages"> | null => {
    if (!h.pages) {
      const assetId = asset(h.assetId, "handout");
      return assetId ? { assetId } : null;
    }
    const pages = handoutPagesOf(h.pages);
    return pages[0] ? { assetId: pages[0].assetId, pages } : null;
  };
  handouts.assign(Object.values(state.handouts).filter((h) => handoutImages(h) !== null).map((h) => h.id));
  // Every row the fight or a saved step holds, so a step keeps the rows removed since: Previous walks past the turn of
  // one, and an ended effect it puts back pauses on its creature (design 9.4, review FU26-ASTRA-1).
  const knownRows = new Map<string, InitEntry>();
  for (const e of [...(state.encounter?.entries ?? []), ...state.encounterHistory.flatMap((snap) => snap.encounter.entries)]) if (!knownRows.has(e.id)) knownRows.set(e.id, e);
  const cameThrough = (e: InitEntry) => (e.tokenId === undefined || tokens.has(e.tokenId)) && (e.characterId === undefined || characters.has(e.characterId));
  entries.assign([...knownRows.values()].filter(cameThrough).map((e) => e.id));

  const memberList = (ids: string[]): string[] => ids.filter((id) => members.has(id)).map((id) => members.of(id));
  const effect = (withDue: Effect): Effect => {
    // An occurrence names a line of the old room's log, and the requests that answer it do not come through, so a save ends waits for the next turn end.
    const { due: _due, ...e } = withDue;
    if (!e.duration) return e;
    // One counting a row that did not come through pauses on its creature, as a removal pauses it, so none counts a row
    // the new room never holds.
    const row = "entryId" in e.duration.anchor && !entries.has(e.duration.anchor.entryId) ? knownRows.get(e.duration.anchor.entryId) : undefined;
    const a = row ? pausedAnchorForEntry(row) : e.duration.anchor;
    const anchor =
      "entryId" in a ? { entryId: entries.of(a.entryId) } : "tokenId" in a ? { tokenId: tokens.of(a.tokenId) } : { characterId: characters.of(a.characterId) };
    return { ...e, duration: { ...e.duration, anchor } };
  };
  // A link to a room monster follows its new id, and one to a monster that did not come through is dropped (wave 5). So does
  // a link to a companion block (docs/design/design-v1-companion-stat-blocks.md 3.6).
  //
  // A turn record is named by the seq of the op that started its turn, a seq of the old room, and the new room counts from
  // its snapshot again (gateway.ts), so a later turn could take the same number. The record goes, and the damage types
  // taken with it, which only a record's start reads (docs/design/design-v1-combat-controls.md 3.6).
  //
  // A block link (linkOf) as the remapped actor's own reads: a room monster or companion block by its new id, or none
  // when it did not come through, as the actor's link goes then. A link renamed keeps the marks keyed by its block, and
  // one dropped takes them (relinked), so they never come back under no block at all.
  const savedLink = (link: string | undefined): string | undefined => {
    if (link === undefined) return undefined;
    const colon = link.indexOf(":");
    const kind = link.slice(0, colon);
    const id = link.slice(colon + 1);
    if (kind === "monster") return monsters.has(id) ? `monster:${monsters.of(id)}` : undefined;
    if (kind === "block") return blocks.has(id) ? `block:${blocks.of(id)}` : undefined;
    return link;
  };
  const actor = <A extends Pick<Actor, "effects" | "srdId" | "wildShape" | "monsterId" | "blockId" | "uses" | "turnRecord" | "hurt">>(a: A): A => {
    const next: A = { ...a, effects: a.effects.map(effect) };
    delete next.turnRecord;
    delete next.hurt;
    if (a.monsterId !== undefined) {
      if (monsters.has(a.monsterId)) next.monsterId = monsters.of(a.monsterId);
      else delete next.monsterId;
    }
    if (a.blockId !== undefined) {
      if (blocks.has(a.blockId)) next.blockId = blocks.of(a.blockId);
      else delete next.blockId;
    }
    const was = linkOf(a);
    return relinked(next, savedLink(was) ?? was);
  };
  // An upload follows its new id where its place takes a token image, and goes when it did not come through. A shipped
  // icon's key means the same in every room (docs/design/design-v1-dm-tools.md 2.5).
  const image = (ref: ImageRef): ImageRef | undefined => {
    if ("icon" in ref) return ref;
    const mapped = asset(ref.assetId, "token");
    return mapped ? { ...ref, assetId: mapped } : undefined;
  };

  const out: RoomState = {
    meta: { ...state.meta, playerSceneId: null },
    members: {},
    scenes: {},
    buildChunks: {},
    labels: {},
    fogTiles: {},
    fogDrafts: {},
    tokens: {},
    characters: {},
    templates: {},
    drawings: {},
    encounter: null,
    encounterHistory: [],
    handouts: {},
    log: [],
    monsters: {},
    srdImages: {},
    savedEncounters: {},
    stamps: {},
    lights: {},
    exploredTiles: {},
    holders: {},
    exploredBy: {},
    journal: {},
    pins: {},
    // Open roll requests belong to a moment of play, and their targets' players have new member ids anyway (section 2.5).
    rolls: {},
    handoutDocs: {},
    companionBlocks: {},
    // Open asks for saves belong to a moment of play too, and the import keeps their lines (docs/design/design-v1-player-save-spell.md 5.7).
    casts: {},
    traps: {},
    trapLog: [],
    trapSeen: [],
    // No record of the running turn's reminders (RoomState.reminded): it belongs to that turn, and names old member ids.
  };
  // The clock holds no id but its own, and each character's stamp names that one, so both come through as they are
  // (docs/design/design-v1-calendar.md 6.6). No clock stays no field.
  if (state.clock) out.clock = state.clock;
  /*
   * The library and the playlists come under new ids, each sound's file under
   * its new row's id (docs/design/design-v1-music.md 6.7). A sound whose file
   * did not come through as a sound stays, with an id no row has, so
   * refillSoundFacts leaves it out with its places and counts it in the
   * import's answer, and no sound ever names the old room's file. What played
   * belongs to a moment of play: an imported room starts silent
   * (D-261102-475). A room from before sound stays without the fields.
   */
  if (state.sounds) {
    out.sounds = {};
    for (const s of Object.values(state.sounds)) {
      const next: Sound = { ...s, id: sounds.of(s.id), assetId: asset(s.assetId, "sound") ?? newId() };
      out.sounds[next.id] = next;
    }
  }
  if (state.playlists) {
    out.playlists = {};
    for (const p of Object.values(state.playlists)) {
      const next: Playlist = { ...p, id: playlists.of(p.id), sounds: p.sounds.filter((id) => sounds.has(id)).map((id) => sounds.of(id)) };
      out.playlists[next.id] = next;
    }
  }
  if (state.playing !== undefined) out.playing = null;

  const moveAny = state.meta.settings.playersMoveAny;
  if (Array.isArray(moveAny)) out.meta = { ...out.meta, settings: { ...out.meta.settings, playersMoveAny: memberList(moveAny) } };
  const draw = state.meta.settings.playersDraw;
  if (Array.isArray(draw)) out.meta = { ...out.meta, settings: { ...out.meta.settings, playersDraw: memberList(draw) } };
  for (const m of Object.values(state.members)) {
    const next: Member = { ...m, id: members.of(m.id), kind: "player" };
    out.members[next.id] = next;
  }
  for (const s of Object.values(state.scenes)) {
    const next: Scene = { ...s, id: scenes.of(s.id) };
    // A floor names its main floor by its new id (docs/design/design-v1-floors.md 7.8). A main floor the file lacks keeps
    // the old id, which no scene has, so the import's floor check refuses the room.
    if (s.floor) next.floor = { ...s.floor, ...(s.floor.of !== undefined ? { of: scenes.of(s.floor.of) } : {}) };
    // A hand-made backup may spell a weather longhand, and the room keeps one stored form (docs/design/design-v1-weather.md 9.3).
    if (s.weather !== undefined) next.weather = normalWeather(s.weather);
    if (s.sound) next.sound = sceneSoundUnder(s.sound, sounds, playlists);
    if (s.map) {
      const mapped = asset(s.map.assetId, "map");
      if (mapped) next.map = withVideo({ ...s.map, assetId: mapped }, videoUnder(s.map.video, (id) => asset(id, "video")));
      else delete next.map;
    }
    if (s.thumb !== undefined) {
      const mapped = asset(s.thumb, "thumb");
      if (mapped) next.thumb = mapped;
      else delete next.thumb;
    }
    if (s.phases) out.scenes[next.id] = withPhaseImages(next, s.phases, (id) => asset(id, "map"), (id) => asset(id, "video"));
    else out.scenes[next.id] = next;
  }
  // New ids for stamps and lights, as for labels. A stamp of an image that did not come through goes with it.
  const stampIds = new Map<string, string>();
  const lightIds = new Map<string, string>();
  for (const st of Object.values(state.stamps)) {
    if (!scenes.has(st.sceneId)) continue;
    let art = st.art;
    if ("assetId" in art) {
      const mapped = asset(art.assetId, "token");
      if (!mapped) continue;
      art = { assetId: mapped };
    }
    const next: Stamp = { ...st, id: newId(), sceneId: scenes.of(st.sceneId), art };
    stampIds.set(st.id, next.id);
    out.stamps[next.id] = next;
  }
  for (const l of Object.values(state.lights)) {
    if (!scenes.has(l.sceneId)) continue;
    const next: Light = { ...l, id: newId(), sceneId: scenes.of(l.sceneId) };
    lightIds.set(l.id, next.id);
    out.lights[next.id] = next;
  }
  if (state.meta.playerSceneId !== null && scenes.has(state.meta.playerSceneId)) {
    out.meta.playerSceneId = scenes.of(state.meta.playerSceneId);
  } else {
    // A main floor, as Delete leaves the players (docs/design/design-v1-floors.md 8.3): the scene's place in the order is its main floor's.
    const first = Object.values(out.scenes)
      .filter((scene) => scene.floor === undefined || scene.floor.of === scene.id)
      .sort((a, b) => a.order - b.order)[0];
    out.meta.playerSceneId = first?.id ?? null;
  }
  // The floors players reached follow their floors (docs/design/design-v1-floors.md 9). A mark is bookkeeping of the room,
  // as a played mark is, so it comes through as it stands.
  if (state.openFloors) {
    const opened: Record<string, SceneMark> = {};
    for (const mark of Object.values(state.openFloors)) {
      if (!scenes.has(mark.sceneId)) continue;
      const sceneId = scenes.of(mark.sceneId);
      opened[sceneId] = { ...mark, sceneId };
    }
    if (Object.keys(opened).length > 0) out.openFloors = opened;
  }
  for (const c of Object.values(state.buildChunks)) {
    if (!scenes.has(c.sceneId)) continue;
    const sceneId = scenes.of(c.sceneId);
    out.buildChunks[chunkKey(sceneId, c.cx, c.cy)] = { ...c, sceneId };
  }
  for (const l of Object.values(state.labels)) {
    if (!labels.has(l.id)) continue;
    const next = { ...l, id: labels.of(l.id), sceneId: scenes.of(l.sceneId) };
    out.labels[next.id] = next;
  }
  for (const t of Object.values(state.fogTiles)) {
    if (!scenes.has(t.sceneId)) continue;
    const sceneId = scenes.of(t.sceneId);
    out.fogTiles[tileKey(sceneId, t.tx, t.ty)] = { ...t, sceneId };
  }
  // On a per-player scene no layer keeps a tile past the bounds, which the size guard counts at their widest and never
  // past them, so an import drops what the fold would have (review PV3-ASTRA-1).
  const pastBounds = (sceneId: string, t: { tx: number; ty: number }) => {
    const scene = out.scenes[sceneId];
    return scene?.vision?.perPlayer === true && (t.tx >= tilesAcross(scene.bounds.w) || t.ty >= tilesAcross(scene.bounds.h));
  };
  // The party's explored layer follows its scene, as the fog does (docs/design/design-v1-maps-vision.md 4.3.3).
  for (const t of Object.values(state.exploredTiles)) {
    if (!scenes.has(t.sceneId)) continue;
    const sceneId = scenes.of(t.sceneId);
    if (pastBounds(sceneId, t)) continue;
    out.exploredTiles[tileKey(sceneId, t.tx, t.ty)] = { ...t, sceneId };
  }
  // Who sees for themselves on a per-player scene, and each one's own explored layer, follow their scene and their
  // player (docs/design/design-v1-per-player-vision.md 6.3). An entry for a member who did not come through goes, and so does
  // a layer whose entry is gone or off, which holds nothing any player reads.
  for (const list of Object.values(state.holders ?? {})) {
    if (!scenes.has(list.sceneId) || out.scenes[scenes.of(list.sceneId)]?.vision?.perPlayer !== true) continue;
    const entries = list.entries.filter((e) => members.has(e.memberId)).map((e) => ({ ...e, memberId: members.of(e.memberId) }));
    if (entries.length > 0) out.holders[scenes.of(list.sceneId)] = { ...list, sceneId: scenes.of(list.sceneId), entries };
  }
  for (const t of Object.values(state.exploredBy ?? {})) {
    if (!scenes.has(t.sceneId) || !members.has(t.memberId)) continue;
    const sceneId = scenes.of(t.sceneId);
    const memberId = members.of(t.memberId);
    if (!out.holders[sceneId]?.entries.some((e) => e.on && e.memberId === memberId) || pastBounds(sceneId, t)) continue;
    out.exploredBy[holderTileKey(sceneId, memberId, t.tx, t.ty)] = { ...t, sceneId, memberId };
  }
  remapMemory(state, out, { scenes, members, labels, stampIds, newId, tokenArt: (id) => asset(id, "token") });
  for (const d of Object.values(state.fogDrafts)) {
    if (!scenes.has(d.sceneId)) continue;
    const sceneId = scenes.of(d.sceneId);
    out.fogDrafts[sceneId] = { ...d, sceneId };
  }
  for (const c of Object.values(state.characters)) {
    const next: Character = { ...c, id: characters.of(c.id), ownerIds: memberList(c.ownerIds), actor: actor(c.actor) };
    if (c.defaultImage) {
      const mapped = image(c.defaultImage);
      if (mapped) next.defaultImage = mapped;
      else delete next.defaultImage;
    }
    // Known forms are SRD ids, which no room renames. A hand-made file's empty list is stored as none, the one state the reducer keeps (docs/design/design-v1-known-forms.md 3.1).
    if (c.knownForms?.length === 0) delete next.knownForms;
    out.characters[next.id] = next;
  }
  for (const t of liveTokens) {
    // A path is tagged with the seq of its turn, which counts ops of the old room, so it goes with that seq (see `encounter` below).
    const { path: _path, ...rest } = t;
    const next: Token = {
      ...rest,
      id: tokens.of(t.id),
      sceneId: scenes.of(t.sceneId),
      ownerIds: memberList(t.ownerIds),
      actor: "ref" in t.actor ? { ref: characters.of(t.actor.ref) } : { inline: actor(t.actor.inline) },
    };
    // A companion follows its character's new id, and is a plain token once its character did not come through.
    if (t.companion) {
      if (characters.has(t.companion.of)) next.companion = { ...t.companion, of: characters.of(t.companion.of) };
      else delete next.companion;
    }
    // A link follows its holder's new id, and goes when the holder did not come through (docs/design/design-v1-attach.md 5.2).
    if (t.attached) {
      if (tokens.has(t.attached.to)) next.attached = { ...t.attached, to: tokens.of(t.attached.to) };
      else delete next.attached;
    }
    if (t.image) {
      const mapped = image(t.image);
      if (mapped) next.image = mapped;
      else delete next.image;
    }
    if (t.altImages) {
      const kept = t.altImages.flatMap((alt) => {
        const mapped = image(alt);
        return mapped ? [mapped] : [];
      });
      if (kept.length > 0) next.altImages = kept;
      else delete next.altImages;
    }
    out.tokens[next.id] = next;
  }
  for (const t of Object.values(state.templates)) {
    if (!templates.has(t.id)) continue;
    const next: AreaTemplate = { ...t, id: templates.of(t.id), sceneId: scenes.of(t.sceneId), ownerId: members.of(t.ownerId) };
    if (t.attachedTo !== undefined) {
      if (tokens.has(t.attachedTo)) next.attachedTo = tokens.of(t.attachedTo);
      else delete next.attachedTo;
    }
    if (t.casterId !== undefined) {
      if (tokens.has(t.casterId)) next.casterId = tokens.of(t.casterId);
      else delete next.casterId;
    }
    out.templates[next.id] = next;
  }
  for (const d of Object.values(state.drawings)) {
    if (!drawings.has(d.id)) continue;
    const next: Drawing = { ...d, id: drawings.of(d.id), sceneId: scenes.of(d.sceneId), ownerId: members.of(d.ownerId) };
    if (d.anchors) next.anchors = d.anchors.map((id) => (id === null ? null : tokens.of(id)));
    out.drawings[next.id] = next;
  }
  const entry = (e: InitEntry): InitEntry => {
    const next: InitEntry = { ...e, id: entries.of(e.id) };
    if (e.tokenId !== undefined) next.tokenId = tokens.of(e.tokenId);
    if (e.characterId !== undefined) next.characterId = characters.of(e.characterId);
    return next;
  };
  const encounter = (enc: Encounter): Encounter => {
    const kept = enc.entries.filter((e) => entries.has(e.id)).map(entry);
    const active = enc.activeEntryId !== null && entries.has(enc.activeEntryId) ? entries.of(enc.activeEntryId) : null;
    // The seqs that name the fight and its turn count ops of the old room, so they go as the turn's own does below.
    const { turnStart, startSeq: _startSeq, ...rest } = enc;
    const next: Encounter = { ...rest, activeEntryId: active, entries: kept };
    // The spot belongs to its row and token, so it goes with either of them.
    if (turnStart && entries.has(turnStart.entryId) && tokens.has(turnStart.tokenId) && scenes.has(turnStart.sceneId)) {
      // The seq that names the turn counts ops of the old room. The new room counts on from the newest seq the file's
      // lines name (lastLineSeq), which need not be this turn's, so a later turn could still get the same number and take
      // up an old path. The turn records no path until the next.
      // Without its seq the turn shares nothing with a mount either (docs/design/design-v1-attach.md 7.1).
      const { seq: _seq, mounts: _mounts, ...spot } = turnStart;
      next.turnStart = { ...spot, entryId: entries.of(turnStart.entryId), tokenId: tokens.of(turnStart.tokenId), sceneId: scenes.of(turnStart.sceneId) };
      // Who saw the start, on a per-player scene, names players of the new roster only, so lists stay within it (review SEC-PV1-5).
      if (turnStart.seenBy) next.turnStart.seenBy = memberList(turnStart.seenBy).sort();
    }
    return next;
  };
  if (state.encounter) out.encounter = encounter(state.encounter);
  const holder = (id: string): string | null => (tokens.has(id) ? tokens.of(id) : characters.has(id) ? characters.of(id) : null);
  out.encounterHistory = state.encounterHistory.map((snap): EncounterSnapshot => {
    const effects: Record<string, Effect[]> = {};
    for (const [holderId, list] of Object.entries(snap.effects)) {
      const mapped = holder(holderId);
      if (mapped) effects[mapped] = list.map(effect);
    }
    const saved = encounter(snap.encounter);
    const next: EncounterSnapshot = {
      encounter: saved,
      effects,
      revealed: snap.revealed.filter((r) => tokens.has(r.tokenId)).map((r) => ({ ...r, tokenId: tokens.of(r.tokenId) })),
      at: snap.at,
    };
    const legendaryHolder = snap.legendary ? holder(snap.legendary.holderId) : null;
    if (snap.legendary && legendaryHolder) next.legendary = { holderId: legendaryHolder, actionsUsed: snap.legendary.actionsUsed };
    const reactions = (snap.companionReactions ?? []).filter((id) => tokens.has(id)).map((id) => tokens.of(id));
    if (reactions.length > 0) next.companionReactions = reactions;
    const turnUses = (snap.turnUses ?? []).flatMap((saved): TurnUses[] => {
      const holderId = holder(saved.holderId);
      // The record each start replaced goes as the actors' records do, so Previous leaves a record as it is (3.6).
      const { record: _record, link, marks, ...kept } = saved;
      const mappedLink = savedLink(link);
      // Marks keyed by a block that did not come through stay off, as the actor's own go.
      const keptMarks = link !== undefined && mappedLink === undefined ? undefined : marks;
      // The landing creature's entry stays for its link alone, which Previous reads before it gives back its pips.
      const landing = saved.holderId === snap.legendary?.holderId;
      if (holderId === null || (keptMarks === undefined && kept.actionsUsed === undefined && !landing)) return [];
      return [{ ...kept, holderId, ...(keptMarks ? { marks: keptMarks } : {}), ...(mappedLink !== undefined ? { link: mappedLink } : {}) }];
    });
    if (turnUses.length > 0) next.turnUses = turnUses;
    // Kept even when empty: a step without them is one from before op version 21, whose Previous puts back the whole encounter.
    if (snap.turnFlags) next.turnFlags = snap.turnFlags.filter((f) => entries.has(f.entryId)).map((f) => ({ ...f, entryId: entries.of(f.entryId) }));
    // A turn whose row did not come through has left the fight, which the step's encounter, passing it to no row, cannot say.
    if (snap.resumesGone || (snap.encounter.activeEntryId !== null && saved.activeEntryId === null)) next.resumesGone = true;
    // The occurrences a save opened name lines of the old room's log, which go as the effects' own do.
    const changes = (snap.effectChanges ?? []).flatMap((change): EffectChange[] => {
      const holderId = holder(change.holderId);
      if (holderId === null) return [];
      const { asked: _asked, ended, ...kept } = change;
      const out: EffectChange = { ...kept, holderId };
      if (ended) out.ended = ended.map((e) => ({ at: e.at, effect: effect(e.effect) }));
      return out.ended || out.counted ? [out] : [];
    });
    if (changes.length > 0) next.effectChanges = changes;
    return next;
  });
  for (const h of Object.values(state.handouts)) {
    if (!handouts.has(h.id)) continue;
    const to = h.to === "all" ? "all" : memberList(h.to);
    if (to !== "all" && to.length === 0) continue;
    const images = handoutImages(h);
    if (!images) continue;
    const next: Handout = { ...h, ...images, id: handouts.of(h.id), to };
    out.handouts[next.id] = next;
  }
  // Tokens made from a custom monster are copies, linked back only by their actor's `monsterId`, remapped above.
  for (const m of Object.values(state.monsters)) {
    const next: CustomMonster = { ...m, id: monsters.of(m.id) };
    if (m.defaultImage) {
      const mapped = image(m.defaultImage);
      if (mapped) next.defaultImage = mapped;
      else delete next.defaultImage;
    }
    out.monsters[next.id] = next;
  }
  // Keyed by the SRD's own ids, which mean the same in every room. A choice whose image did not come through is no choice.
  for (const e of Object.values(state.srdImages)) {
    const mapped = image(e.image);
    if (!mapped) continue;
    const next: SrdImage = { ...e, image: mapped };
    out.srdImages[next.id] = next;
  }
  // Journal pages with new ids (wave 5, section 2.5). A page private to a member follows its new id, and one whose member
  // did not come through becomes the DM's, as removing the member would make it.
  for (const page of Object.values(state.journal)) {
    const access = typeof page.access === "object" ? (members.has(page.access.member) ? { member: members.of(page.access.member) } : "dm") : page.access;
    const next: JournalPage = { ...page, id: pages.of(page.id), access };
    out.journal[next.id] = next;
  }
  // Pins follow their scene and their page. A pin whose page did not come through is made DM only, as deleting the page
  // would make it, so it never reaches more people than before.
  for (const pin of Object.values(state.pins)) {
    if (!scenes.has(pin.sceneId)) continue;
    const next: Pin = { ...pin, id: newId(), sceneId: scenes.of(pin.sceneId) };
    if (pin.pageId !== undefined) {
      if (pages.has(pin.pageId)) next.pageId = pages.of(pin.pageId);
      else {
        delete next.pageId;
        next.visibility = "dm";
      }
    }
    out.pins[next.id] = next;
  }
  // A document gets a new id, as a handout does, and one left with no page is dropped (docs/design/design-v1-pdf-handouts.md 3.6).
  for (const d of Object.values(state.handoutDocs)) {
    const pages = handoutPagesOf(d.pages);
    if (pages.length === 0) continue;
    const next: HandoutDoc = { ...d, id: newId(), pages };
    out.handoutDocs[next.id] = next;
  }
  // A companion block follows its character's new id, and its picture follows its image or goes (docs/design/design-v1-companion-stat-blocks.md 3.6).
  for (const b of Object.values(state.companionBlocks)) {
    if (!blocks.has(b.id)) continue;
    const next: CompanionBlock = { ...b, id: blocks.of(b.id), characterId: characters.of(b.characterId) };
    if (b.defaultImage) {
      const mapped = image(b.defaultImage);
      if (mapped) next.defaultImage = mapped;
      else delete next.defaultImage;
    }
    out.companionBlocks[next.id] = next;
  }
  // SRD monsters keep their ids. A room monster follows its new id, and one that is not in the backup was deleted before it.
  for (const e of Object.values(state.savedEncounters)) {
    const kinds = e.monsters.flatMap((m): SavedEncounterMonster[] => {
      if ("srdId" in m) return [m];
      return monsters.has(m.monsterId) ? [{ ...m, monsterId: monsters.of(m.monsterId) }] : [];
    });
    const next: SavedEncounter = { ...e, id: newId(), monsters: kinds };
    out.savedEncounters[next.id] = next;
  }
  const event = (data: LogEvent): LogEvent | null => {
    switch (data.type) {
      case "hp": {
        // What a change replaced names effects and rows of the old room, and
        // an imported line is history: it can no longer be taken back, so it
        // keeps only what it says.
        const { revert: _revert, of: _of, ...next } = data;
        if (data.tokenId !== undefined) next.tokenId = tokens.of(data.tokenId);
        if (data.characterId !== undefined) next.characterId = characters.of(data.characterId);
        return next;
      }
      case "life":
      case "effect":
      case "concentration":
      case "deathSave":
      case "rest":
      case "saveEnds":
      case "use": {
        const next = { ...data };
        if (data.tokenId !== undefined) next.tokenId = tokens.of(data.tokenId);
        if (data.characterId !== undefined) next.characterId = characters.of(data.characterId);
        return next;
      }
      case "turn":
        return { ...data, entryId: entries.of(data.entryId), ...(data.to !== undefined ? { to: entries.of(data.to) } : {}) };
      case "area":
        return { ...data, templateId: templates.of(data.templateId), tokenId: tokens.of(data.tokenId) };
      case "handout":
        return handouts.has(data.handoutId) ? { ...data, handoutId: handouts.of(data.handoutId) } : null;
      case "member":
        return { ...data, memberId: members.of(data.memberId) };
      case "encounter":
      case "correction":
      // A clock line names nothing an import remaps (docs/design/design-v1-calendar.md 6.6): its claim is a device's own id.
      case "clock":
        return data;
      case "teleport":
        return { ...data, tokenId: tokens.of(data.tokenId) };
      case "companion":
        return { ...data, tokenId: tokens.of(data.tokenId), characterId: characters.of(data.characterId), memberId: members.of(data.memberId) };
      case "characterDeleted":
        return { ...data, characterId: characters.of(data.characterId), memberId: members.of(data.memberId) };
      case "roll": {
        const next = { ...data };
        if (data.tokenId !== undefined) next.tokenId = tokens.of(data.tokenId);
        if (data.characterId !== undefined) next.characterId = characters.of(data.characterId);
        return next;
      }
      // The roller and each roll's creature follow their new ids (docs/design/design-v1-dice.md 5.3).
      case "dice":
        return {
          ...data,
          by: members.of(data.by),
          rolls: data.rolls.map((roll) => {
            const next = { ...roll };
            if (roll.tokenId !== undefined) next.tokenId = tokens.of(roll.tokenId);
            if (roll.characterId !== undefined) next.characterId = characters.of(roll.characterId);
            return next;
          }),
        };
      case "cast":
        return { ...data, tokenId: tokens.of(data.tokenId) };
      // Trap lines live in their own logs, remapped below.
      case "trap":
      case "trapSeen":
      case "trapNotice":
        return null;
    }
  };
  // Log ids are `"<seq>:<index>"`, and an imported line keeps its op's seq, so the log reads in the old room's order
  // across audiences, and the new room's ops start after the last of them (lastLineSeq), so none can collide. Within
  // each op the lines are numbered again as the reducer writes them (Tx.addLog): the shared lines and whispers from 0
  // with the players' trap lines, each reader's copies of party lines in their own run on the new roster, and the
  // DM's from DM_LINE_BASE with the traps' (dmLineIdsOf). A line players may get that does not come through leaves no
  // number behind, so the lines a player gets in an op have no gap where one only others hold was.
  const dmLineIds = dmLineIdsOf(state, scenes);
  const dmLines = new Set(state.log.filter((e) => lineAudience(e) === "dm").map((e) => e.id));
  const ranks = rosterRanks(out.members);
  const kept: { line: LogEntry; old: string; reader?: string; apart: boolean }[] = [];
  blocks.assign(state.log.flatMap((line) => (line.parts?.correction ?? []).flatMap((witness) => {
    const parsed = parseKey(witness.key);
    return parsed?.kind === "companionBlock" && witness.characterId !== undefined && characters.has(witness.characterId) ? [parsed.id] : [];
  })));
  for (const e of state.log) {
    const audience = lineAudience(e);
    const apart = audience !== "shared" || dmLineIds.has(e.id);
    const { copyOf, parts, ...rest } = e;
    // A whisper holds who it is from and for and what it says, as log.whisper writes it.
    const next: LogEntry = e.kind === "whisper" ? { id: e.id, at: e.at, kind: e.kind, ...(e.from !== undefined ? { from: e.from } : {}), ...(e.to !== undefined ? { to: e.to } : {}), ...(e.text !== undefined ? { text: e.text } : {}) } : rest;
    if (e.from !== undefined) next.from = members.of(e.from);
    if (e.to !== undefined) next.to = e.to.map((member) => members.of(member));
    // Only a shared line has part readers (LineParts).
    if (parts !== undefined && !apart) next.parts = remapParts(parts, memberList);
    if (e.data?.type === "correction" && parts?.correction) {
      const correction = parts.correction.flatMap((witness) => {
        const parsed = parseKey(witness.key);
        if (!parsed || !("id" in parsed)) return [];
        const ids = parsed.kind === "token" ? tokens : parsed.kind === "character" ? characters : parsed.kind === "companionBlock" ? blocks : null;
        const characterId = witness.characterId;
        if (characterId !== undefined && !characters.has(characterId)) return [];
        // A deleted definition's id still identifies absence in its owner's library.
        const missingBlock = parsed.kind === "companionBlock" && characterId !== undefined;
        return ids && (ids.has(parsed.id) || missingBlock) ? [{ ...witness, key: `${parsed.kind}:${ids.of(parsed.id)}`, ...(characterId !== undefined ? { characterId: characters.of(characterId) } : {}) }] : [];
      });
      if (audience === "party" && correction.length === 0) continue;
      next.parts = { correction };
    }
    let reader: string | undefined;
    if (dmLineIds.has(e.id)) next.id = dmLineIds.get(e.id)!;
    else if (audience === "party") {
      reader = next.to![0];
      // A copy whose reader did not come through, which no one here reads.
      if (e.to!.length !== 1 || reader === undefined || !ranks.has(reader)) continue;
      // A copy whose DM line did not come with it stands for its event alone (eventLines).
      if (copyOf !== undefined && dmLines.has(copyOf)) next.copyOf = dmLineIds.get(copyOf)!;
    }
    if (next.data) {
      const data = event(next.data);
      if (!data) continue;
      next.data = data;
    }
    kept.push({ line: next, old: e.id, ...(reader !== undefined ? { reader } : {}), apart });
  }
  // The players' trap lines count among the shared lines of their op, in the old room's order with them.
  const seenKept = (state.trapSeen ?? []).filter((line) => line.data?.type === "trapSeen");
  const sharedKept = kept.filter((k) => k.reader === undefined && !dmLineIds.has(k.old));
  const sharedIds = numberedWithin<object>([...sharedKept.map((k) => ({ id: k.old, key: k })), ...seenKept.map((line) => ({ id: line.id, key: line }))], 0);
  const copies = new Map<string, number>();
  kept.sort((a, b) => compareLogIds(a.old, b.old));
  for (const k of kept) {
    if (k.reader !== undefined) {
      const seq = seqOf(k.old);
      const key = `${seq} ${k.reader}`;
      const count = copies.get(key) ?? 0;
      copies.set(key, count + 1);
      k.line.id = `${seq}:${partyIndex(ranks.get(k.reader)!, count)}`;
    } else if (!dmLineIds.has(k.old)) k.line.id = sharedIds.get(k)!;
    // Each line outside the measures is cut to its bound, as the reducer cuts them, so every ring keeps its bytes.
    out.log.push(k.apart ? cutLine(k.line) : k.line);
  }
  out.log.sort((a, b) => compareLogIds(a.id, b.id));
  remapTraps(state, out, { scenes, tokens, stampIds, lightIds, newId, dmLineIds, seenLineIds: (line) => sharedIds.get(line)! });
  // A file's trap lines come in its own order, and the reducer finds a line by its id in each log.
  out.trapLog.sort((a, b) => compareLogIds(a.id, b.id));
  out.trapSeen.sort((a, b) => compareLogIds(a.id, b.id));
  // A hand-made or older file is brought within the companion rules (docs/design/design-v1-combat-flow.md 4.7), a character's
  // initiative and Passive Perception follow its stat block, and a Wild Shape mark stands only beside its creature
  // (docs/design/design-v1-pc-stats.md 3.5 and 3.6).
  return withShapeRules(withPcActors(normalizeCompanionState(out)));
}

/**
 * A scene's phases with their images remapped (docs/design/design-v1-maps-vision.md
 * 2.5). A phase whose image did not come through goes. When the active one
 * went, the scene switches to the first one left, on the reference grid and
 * with its light level as any switch (withPhaseLight), and when none is
 * left the scene has neither phases nor a map.
 *
 * A phase whose video did not come through stays, as a still
 * (docs/design/design-v1-animated-maps.md 9.3). The map's video is always
 * the surviving active phase's, since players receive the map and never
 * the phases.
 */
function withPhaseImages(scene: Scene, phases: readonly MapPhase[], asset: (id: string) => string | undefined, videoAsset: (id: string) => string | undefined): Scene {
  const kept = phases.flatMap((p) => {
    const mapped = asset(p.assetId);
    return mapped ? [withVideo({ ...p, assetId: mapped }, videoUnder(p.video, videoAsset))] : [];
  });
  const { phases: _phases, phaseId: _phaseId, phaseGrid, map: _map, ...rest } = scene;
  const active = kept.find((p) => p.id === scene.phaseId) ?? kept[0];
  if (!active || !phaseGrid) return rest;
  const map = active.id === scene.phaseId && scene.map ? withVideo(scene.map, active.video) : phaseMap(phaseGrid, active);
  const next: Scene = { ...rest, phases: kept, phaseId: active.id, phaseGrid, map };
  return active.id === scene.phaseId ? next : withPhaseLight(next, active);
}

/** A video under its imported row's new id, or none when its row did not come through as a video. */
function videoUnder(video: MapVideo | undefined, asset: (id: string) => string | undefined): MapVideo | undefined {
  if (video === undefined) return undefined;
  const mapped = asset(video.assetId);
  return mapped === undefined ? undefined : { ...video, assetId: mapped };
}

/** A map or a phase with this video over its still, or as a still without one. */
function withVideo<T extends { video?: MapVideo }>(place: T, video: MapVideo | undefined): T {
  const { video: _old, ...still } = place;
  return (video === undefined ? still : { ...still, video }) as T;
}

/**
 * Each map's and phase's video facts from its asset row, after the id
 * remap (docs/design/design-v1-animated-maps.md 9.3). The import's own
 * header check made the rows, so a file's facts are never trusted, as an
 * op's are not (server/rooms/actor.ts withAssetSizes). `facts` is keyed by
 * the new asset id. A video with no row there, or one its still no longer
 * fits (`stillFitsVideo`, the rule every op is held to), is dropped and
 * leaves its still as a plain map. Then the shown map takes the surviving
 * active phase's video, so the map and the showing phase agree as every
 * op leaves them (stateSchema.ts phasesFitTheirGrid).
 */
export function refillMapVideos(state: RoomState, facts: ReadonlyMap<string, VideoFacts>): RoomState {
  const refilled = (place: { widthPx: number; heightPx: number; video?: MapVideo }): MapVideo | undefined => {
    if (place.video === undefined) return undefined;
    const row = checkedVideoFacts(facts.get(place.video.assetId) ?? facts.get(place.video.assetId.toLowerCase()));
    return row !== undefined && stillFitsVideo(place, row) ? { assetId: place.video.assetId, ...row } : undefined;
  };
  const scenes: Record<string, Scene> = {};
  for (const [id, scene] of Object.entries(state.scenes)) {
    if (scene.phases) {
      const phases = scene.phases.map((p) => withVideo(p, refilled(p)));
      const active = phases.find((p) => p.id === scene.phaseId);
      scenes[id] = { ...scene, phases, ...(scene.map ? { map: withVideo(scene.map, active?.video) } : {}) };
    } else if (scene.map) scenes[id] = { ...scene, map: withVideo(scene.map, refilled(scene.map)) };
    else scenes[id] = scene;
  }
  return { ...state, scenes };
}

type IdMap = { has(id: string): boolean; of(id: string): string };

/**
 * A scene's sound under the ids `sounds` and `playlists` give. A playlist or
 * a track that is not there leaves the scene's music silent, and a
 * background sound that is not there goes, as deleting either would leave
 * the scene (shared/reducer/sound.ts).
 */
function sceneSoundUnder(sound: SceneSound, sounds: IdMap, playlists: IdMap): SceneSound {
  const was = sound.music;
  let music: SceneSound["music"] = null;
  if (was?.playlistId !== undefined) music = playlists.has(was.playlistId) ? { ...was, playlistId: playlists.of(was.playlistId) } : null;
  else if (was?.soundId !== undefined) music = sounds.has(was.soundId) ? { ...was, soundId: sounds.of(was.soundId) } : null;
  return { music, loops: sound.loops.filter((l) => sounds.has(l.soundId)).map((l) => ({ ...l, soundId: sounds.of(l.soundId) })) };
}

/**
 * Each sound's length from its file's row, after the id remap
 * (docs/design/design-v1-music.md 6.7, MSOL-33). The import's own frame
 * walk made the rows, so a file's lengths are never trusted, as
 * sound.create's `ms` comes from the row and never from the client (4.2).
 * `facts` is keyed by the new asset id and read as untrusted, by the one
 * rule for the audio column (store.ts soundFactsOfRow). A sound with no
 * row there, whose row's facts do not check, or whose length does not fit
 * its use with 4.2's allowance (soundUseFits, the rule its ops are held
 * to) is left out with its places in playlists and scene sounds, as
 * deleting it would leave them, and `left` counts those sounds for the
 * import's answer (soundsLeftOut). It runs after the remap, which leaves
 * nothing playing.
 */
export function refillSoundFacts(state: RoomState, facts: ReadonlyMap<string, SoundFacts>): { state: RoomState; left: number } {
  if (!state.sounds) return { state, left: 0 };
  const kept: Record<string, Sound> = {};
  let left = 0;
  for (const [id, sound] of Object.entries(state.sounds)) {
    const row = soundFactsOfRow({ kind: "sound", media: SOUND_MEDIA, audio: facts.get(sound.assetId) ?? facts.get(sound.assetId.toLowerCase()) ?? null });
    if (row === undefined || !soundUseFits(sound.use, row.ms)) left++;
    else kept[id] = { ...sound, ms: row.ms };
  }
  const same = (has: (id: string) => boolean): IdMap => ({ has, of: (id) => id });
  const keptSounds = same((id) => Object.hasOwn(kept, id));
  const allPlaylists = same((id) => Object.hasOwn(state.playlists ?? {}, id));
  const next: RoomState = { ...state, sounds: kept, scenes: {} };
  if (state.playlists) {
    next.playlists = {};
    for (const [id, p] of Object.entries(state.playlists)) next.playlists[id] = { ...p, sounds: p.sounds.filter((s) => keptSounds.has(s)) };
  }
  for (const [id, scene] of Object.entries(state.scenes)) next.scenes[id] = scene.sound ? { ...scene, sound: sceneSoundUnder(scene.sound, keptSounds, allPlaylists) } : scene;
  return { state: next, left };
}

/** The kinds of entry a chunk of memory holds (MemoryEntries). */
const MEMORY_KINDS = ["cells", "edges", "walls", "heights", "up", "upDir", "rough", "labels", "stamps"] as const satisfies readonly (keyof MemoryEntries)[];

/**
 * Players' memory follows its scene and its layer
 * (docs/design/design-v1-map-discovery.md 5.4): the party's on a scene that keeps
 * memory, and a holder's only where their entry is on after the remap, as
 * their explored layer, so it goes with that layer (ASTRA-5). A remembered
 * label or stamp takes the new id of the live one, and one only memory
 * names takes a fresh id, the same in every layer and chunk, so imported
 * memory never names the old room's things. A remembered stamp's art
 * follows its image as a live stamp's does, and the entry goes when the
 * image did not come through or is not token art, or when the live stamp is
 * the DM's alone, since memory would show its art to players. Free wall ids
 * are only unique within their chunk, and stay. Both marks follow their
 * scenes. A share mark stays only on a scene that keeps memory, the only
 * kind the reducer leaves one on. The players' scene is marked played, as
 * every op that makes a scene the players' scene marks it, so memory never
 * grows on a scene the size guard does not reserve it on (5.5).
 */
function remapMemory(
  state: RoomState,
  out: RoomState,
  ids: {
    scenes: { has(id: string): boolean; of(id: string): string };
    members: { has(id: string): boolean; of(id: string): string };
    labels: { has(id: string): boolean; of(id: string): string };
    stampIds: ReadonlyMap<string, string>;
    newId: () => string;
    tokenArt: (id: string) => string | undefined;
  },
): void {
  const { scenes, members, labels, stampIds, newId, tokenArt } = ids;
  const memory: Record<string, MemoryChunk> = {};
  const memoryBy: Record<string, MemoryChunk> = {};
  const playedScenes: Record<string, SceneMark> = {};
  const memoryShared: Record<string, ShareMark> = {};
  const rememberedOnly = { labels: new Map<string, string>(), stamps: new Map<string, string>() };
  const idOf = (field: "labels" | "stamps", old: string): string => {
    const live = field === "labels" ? (labels.has(old) ? labels.of(old) : undefined) : stampIds.get(old);
    if (live !== undefined) return live;
    let fresh = rememberedOnly[field].get(old);
    if (fresh === undefined) rememberedOnly[field].set(old, (fresh = newId()));
    return fresh;
  };
  const rememberedLabels = (record: Record<string, Label | null>, sceneId: string): Record<string, Label | null> => {
    const next: Record<string, Label | null> = {};
    for (const [old, value] of Object.entries(record)) {
      const id = idOf("labels", old);
      next[id] = value === null ? null : { ...value, id, sceneId };
    }
    return next;
  };
  const rememberedStamps = (record: Record<string, Stamp | null>, sceneId: string): Record<string, Stamp | null> => {
    const next: Record<string, Stamp | null> = {};
    for (const [old, value] of Object.entries(record)) {
      const id = idOf("stamps", old);
      if (value === null) {
        next[id] = null;
        continue;
      }
      const live = out.stamps[id]?.sceneId === sceneId ? out.stamps[id] : undefined;
      if (live?.visibility === "dm") continue;
      let art = value.art;
      if ("assetId" in art) {
        const mapped = tokenArt(art.assetId);
        if (mapped === undefined) {
          // Dropping the entry would show the live stamp, which they never saw: they remember none there instead.
          if (live) next[id] = null;
          continue;
        }
        art = { assetId: mapped };
      }
      next[id] = { ...value, id, sceneId, art };
    }
    return next;
  };
  // A chunk under its new scene and member, in the reducer's one stored form: a kind only while it names something, and no chunk when none is left.
  const chunk = (c: MemoryChunk, sceneId: string, memberId: string | undefined): MemoryChunk | null => {
    const next: MemoryChunk = { sceneId, cx: c.cx, cy: c.cy, rev: c.rev };
    if (memberId !== undefined) next.memberId = memberId;
    const entries: MemoryEntries = { ...c };
    if (c.labels) entries.labels = rememberedLabels(c.labels, sceneId);
    if (c.stamps) entries.stamps = rememberedStamps(c.stamps, sceneId);
    let any = false;
    for (const kind of MEMORY_KINDS) {
      const record = entries[kind];
      if (record === undefined || Object.keys(record).length === 0) continue;
      (next as Record<string, unknown>)[kind] = record;
      any = true;
    }
    return any ? next : null;
  };
  for (const c of Object.values(state.memory ?? {})) {
    if (!scenes.has(c.sceneId)) continue;
    const sceneId = scenes.of(c.sceneId);
    if (!keepsMemory(out.scenes[sceneId])) continue;
    const next = chunk(c, sceneId, undefined);
    if (next) memory[chunkKey(sceneId, c.cx, c.cy)] = next;
  }
  for (const c of Object.values(state.memoryBy ?? {})) {
    if (c.memberId === undefined || !scenes.has(c.sceneId) || !members.has(c.memberId)) continue;
    const sceneId = scenes.of(c.sceneId);
    const memberId = members.of(c.memberId);
    if (!keepsMemory(out.scenes[sceneId]) || !out.holders[sceneId]?.entries.some((e) => e.on && e.memberId === memberId)) continue;
    const next = chunk(c, sceneId, memberId);
    if (next) memoryBy[holderChunkKey(sceneId, memberId, c.cx, c.cy)] = next;
  }
  for (const mark of Object.values(state.playedScenes ?? {})) {
    if (!scenes.has(mark.sceneId)) continue;
    const sceneId = scenes.of(mark.sceneId);
    playedScenes[sceneId] = { ...mark, sceneId };
  }
  // Every floor of the players' scene is played, as markPlayed leaves it (docs/design/design-v1-floors.md 9).
  for (const scene of Object.values(out.scenes)) if (onPlayersScene(out, scene.id)) playedScenes[scene.id] ??= { sceneId: scene.id, rev: 0 };
  for (const mark of Object.values(state.memoryShared ?? {})) {
    if (!scenes.has(mark.sceneId)) continue;
    const sceneId = scenes.of(mark.sceneId);
    if (keepsMemory(out.scenes[sceneId])) memoryShared[sceneId] = { ...mark, sceneId };
  }
  out.memory = memory;
  out.memoryBy = memoryBy;
  out.playedScenes = playedScenes;
  out.memoryShared = memoryShared;
}

/** A shared line's part readers named after their new ids, each list keeping only members who came through. */
function remapParts(parts: LineParts, memberList: (ids: string[]) => string[]): LineParts {
  const out: LineParts = {};
  if (parts.exact) out.exact = memberList(parts.exact);
  if (parts.label) out.label = memberList(parts.label);
  if (parts.to) out.to = memberList(parts.to);
  if (parts.rolls) out.rolls = parts.rolls.map((ids) => (ids === null ? null : memberList(ids)));
  return out;
}

/**
 * The new ids of every line only the DM holds: the room log's DM lines
 * (shared/logRings.ts), party lines' own among them, the trap log's and the
 * occurrences that name them, each in its op, in the old room's order, all
 * counting on from DM_LINE_BASE together, as the reducer writes them
 * (docs/design/design-v1-traps.md 6.3). Numbered with the lines players get, each
 * would leave a gap in theirs.
 */
function dmLineIdsOf(state: RoomState, scenes: { has(id: string): boolean }): Map<string, string> {
  const dmIds = new Set<string>();
  for (const line of state.log) if (lineAudience(line) === "dm") dmIds.add(line.id);
  for (const trap of Object.values(state.traps ?? {})) if (scenes.has(trap.sceneId)) for (const d of trap.rig?.due ?? []) dmIds.add(d.id);
  for (const line of state.trapLog ?? []) dmIds.add(line.id);
  return numberedWithin([...dmIds].map((id) => ({ id, key: id })), DM_LINE_BASE);
}

/**
 * The seq of the op a line id names (`"<seq>:<index>"`), which the stored id
 * grammar keeps to 18 digits, in its plain decimal form. Exact past the
 * integers a Number holds, so no two ops of a hand-made file ever merge.
 */
function seqOf(id: string): string {
  return BigInt(id.slice(0, id.indexOf(":"))).toString();
}

/**
 * New ids for lines that count together within their op, from `base`, in
 * the old room's order: each keeps its op's seq and takes the next number
 * there. Keyed by what the caller names each line by, since two logs, or a
 * hand-made file, may each hold an id.
 */
function numberedWithin<K>(lines: readonly { id: string; key: K }[], base: number): Map<K, string> {
  const out = new Map<K, string>();
  const counts = new Map<string, number>();
  for (const { id, key } of [...lines].sort((a, b) => compareLogIds(a.id, b.id))) {
    const seq = seqOf(id);
    const count = counts.get(seq) ?? 0;
    counts.set(seq, count + 1);
    out.set(key, `${seq}:${base + count}`);
  }
  return out;
}

/**
 * The seq of the newest op a room's lines name: the room log's, both trap
 * logs' and the occurrences waiting on a trap. An imported room's lines
 * keep their seqs (remapState), so its own ops start after this one.
 */
export function lastLineSeq(state: RoomState): number {
  let last = 0;
  const see = (id: string) => { last = Math.max(last, Number(seqOf(id))); };
  for (const line of state.log) see(line.id);
  for (const line of state.trapLog ?? []) see(line.id);
  for (const line of state.trapSeen ?? []) see(line.id);
  for (const trap of Object.values(state.traps ?? {})) for (const d of trap.rig?.due ?? []) see(d.id);
  return last;
}

/**
 * Traps follow their scene (docs/design/design-v1-traps.md 6.8), each with a new
 * id, as pins do. What a trap names follows its new id: a light, a stamp
 * or a creature its actions show, and the creature its hint named, each
 * dropped when it did not come through. Doors keep their ids, as a scene's
 * chunks do. A trap's waiting occurrences and both trap logs come along,
 * named after the new ids, every list keeping only plain ids that came
 * through and counting the rest, as the reducer stores them (6.1). Lines
 * keep their ops and are numbered in the old room's order within each, the
 * players' with the room log's shared lines (remapState) and the DM's from
 * DM_LINE_BASE (dmLineIdsOf), so no two imported lines share an id and the
 * newest occurrence stays the newest.
 */
function remapTraps(
  state: RoomState,
  out: RoomState,
  ids: {
    scenes: { has(id: string): boolean; of(id: string): string };
    tokens: { has(id: string): boolean; of(id: string): string };
    stampIds: ReadonlyMap<string, string>;
    lightIds: ReadonlyMap<string, string>;
    newId: () => string;
    dmLineIds: ReadonlyMap<string, string>;
    seenLineIds: (line: LogEntry) => string;
  },
): void {
  const { scenes, tokens, stampIds, lightIds, newId, dmLineIds, seenLineIds } = ids;
  const trapIds = new Map<string, string>();
  const lineId = (id: string) => dmLineIds.get(id)!;
  const kept = (list: readonly string[], more = 0): { list: string[]; more: number } => {
    const mapped = list.filter((id) => tokens.has(id)).map((id) => tokens.of(id));
    const plain = mapped.filter(isPlainId);
    return { list: plain, more: more + (list.length - plain.length) };
  };
  for (const trap of Object.values(state.traps ?? {})) {
    if (!scenes.has(trap.sceneId)) continue;
    trapIds.set(trap.id, newId());
  }
  for (const trap of Object.values(state.traps ?? {})) {
    const id = trapIds.get(trap.id);
    if (!id) continue;
    const copy: Trap = { ...trap, id, sceneId: scenes.of(trap.sceneId) };
    if (trap.rig) {
      const rig: TrapRig = { ...trap.rig };
      rig.actions = trap.rig.actions.flatMap((a): TrapAction[] => {
        if ("door" in a) return [a];
        if ("light" in a) return lightIds.has(a.light) ? [{ ...a, light: lightIds.get(a.light)! }] : [];
        if ("tokenId" in a.show) return tokens.has(a.show.tokenId) ? [{ show: { tokenId: tokens.of(a.show.tokenId) } }] : [];
        return stampIds.has(a.show.stampId) ? [{ show: { stampId: stampIds.get(a.show.stampId)! } }] : [];
      });
      if (rig.noticedBy !== undefined) {
        const noticed = tokens.has(rig.noticedBy) ? tokens.of(rig.noticedBy) : undefined;
        if (noticed !== undefined && isPlainId(noticed)) rig.noticedBy = noticed;
        else delete rig.noticedBy;
      }
      if (rig.due) {
        rig.due = rig.due.map((d): TrapDue => {
          const by = kept(d.by, d.more ?? 0);
          const hits = kept(d.hits, d.hitsMore ?? 0);
          const { more: _more, hitsMore: _hitsMore, ...rest } = d;
          return { ...rest, id: lineId(d.id), by: by.list, ...(by.more > 0 ? { more: by.more } : {}), hits: hits.list, ...(hits.more > 0 ? { hitsMore: hits.more } : {}) };
        });
        if (rig.due.length === 0) delete rig.due;
      }
      copy.rig = rig;
    }
    out.traps[id] = copy;
  }
  for (const line of state.trapLog ?? []) {
    const data = line.data;
    if (!data) continue;
    if (data.type === "trap") {
      const by = kept(data.by, data.more ?? 0);
      const { more: _more, seen: _seen, ...rest } = data;
      // Which creatures players saw is the old room's history, read by index into the old list.
      const seen = (data.seen ?? []).map((i) => data.by[i]).filter((old): old is string => old !== undefined && tokens.has(old)).map((old) => by.list.indexOf(tokens.of(old))).filter((i) => i >= 0);
      out.trapLog.push({ ...line, id: lineId(line.id), data: { ...rest, trapId: trapIds.get(data.trapId) ?? data.trapId, sceneId: scenes.of(data.sceneId), by: by.list, ...(by.more > 0 ? { more: by.more } : {}), ...(seen.length > 0 ? { seen } : {}) } });
    } else if (data.type === "trapNotice") {
      if (!tokens.has(data.tokenId) || !isPlainId(tokens.of(data.tokenId))) continue;
      out.trapLog.push({ ...line, id: lineId(line.id), data: { ...data, trapId: trapIds.get(data.trapId) ?? data.trapId, sceneId: scenes.of(data.sceneId), tokenId: tokens.of(data.tokenId) } });
    }
  }
  for (const line of state.trapSeen ?? []) {
    const data = line.data;
    if (data?.type !== "trapSeen") continue;
    const by = kept(data.by, data.more ?? 0);
    const { more: _more, ...rest } = data;
    out.trapSeen.push({ ...line, id: seenLineIds(line), data: { ...rest, by: by.list, ...(by.more > 0 ? { more: by.more } : {}) } });
  }
}
