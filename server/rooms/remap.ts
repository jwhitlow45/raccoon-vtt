import { uuidv7 } from "#shared/ids.ts";
import { chunkKey, tileKey } from "#shared/keys.ts";
import type {
  AreaTemplate,
  Character,
  CustomMonster,
  Drawing,
  Effect,
  Encounter,
  EncounterSnapshot,
  Handout,
  ImageRef,
  InitEntry,
  JournalPage,
  LogEntry,
  LogEvent,
  Member,
  RoomState,
  SavedEncounter,
  SavedEncounterMonster,
  Scene,
  SrdImage,
  Stamp,
  Light,
  MapPhase,
  Pin,
  Token,
} from "#shared/model.ts";
import { phaseMap, withPhaseLight } from "#shared/reducer/phases.ts";
import type { AssetKind } from "../assets/kinds.ts";

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
  members.assign(Object.keys(state.members));
  // Before the actors, which name the room monster a token was placed from (Actor.monsterId).
  monsters.assign(Object.keys(state.monsters));
  pages.assign(Object.keys(state.journal));
  scenes.assign(Object.keys(state.scenes));
  characters.assign(Object.keys(state.characters));
  // A token whose character is gone would be a dangling actor, which only a live room may hold.
  const liveTokens = Object.values(state.tokens).filter((t) => scenes.has(t.sceneId) && ("inline" in t.actor || characters.has(t.actor.ref)));
  tokens.assign(liveTokens.map((t) => t.id));
  templates.assign(Object.values(state.templates).filter((t) => scenes.has(t.sceneId)).map((t) => t.id));
  // A kept ruler measures from the tokens it is on, so it goes when one of them did not come through.
  const liveDrawing = (d: Drawing) => scenes.has(d.sceneId) && (d.anchors ?? []).every((id) => id === null || tokens.has(id));
  drawings.assign(Object.values(state.drawings).filter(liveDrawing).map((d) => d.id));
  // The new id of an asset, only where its reference takes that kind.
  const asset = (id: string, kind: AssetKind): string | undefined => {
    const imported = opts.assets.get(id);
    return imported?.kind === kind ? imported.id : undefined;
  };
  labels.assign(Object.values(state.labels).filter((l) => scenes.has(l.sceneId)).map((l) => l.id));
  handouts.assign(Object.values(state.handouts).filter((h) => asset(h.assetId, "handout") !== undefined).map((h) => h.id));
  const liveEntries = (state.encounter?.entries ?? []).filter((e) => (e.tokenId === undefined || tokens.has(e.tokenId)) && (e.characterId === undefined || characters.has(e.characterId)));
  entries.assign(liveEntries.map((e) => e.id));

  const memberList = (ids: string[]): string[] => ids.filter((id) => members.has(id)).map((id) => members.of(id));
  const effect = (e: Effect): Effect => {
    if (!e.duration) return e;
    const a = e.duration.anchor;
    const anchor =
      "entryId" in a ? { entryId: entries.of(a.entryId) } : "tokenId" in a ? { tokenId: tokens.of(a.tokenId) } : { characterId: characters.of(a.characterId) };
    return { ...e, duration: { ...e.duration, anchor } };
  };
  // A link to a room monster follows its new id, and one to a monster that did not come through is dropped (wave 5).
  const actor = <A extends { effects: Effect[]; monsterId?: string }>(a: A): A => {
    const next: A = { ...a, effects: a.effects.map(effect) };
    if (a.monsterId !== undefined) {
      if (monsters.has(a.monsterId)) next.monsterId = monsters.of(a.monsterId);
      else delete next.monsterId;
    }
    return next;
  };
  // An upload follows its new id where its place takes a token image, and goes when it did not come through. A shipped
  // icon's key means the same in every room (docs/design-v1-dm-tools.md 2.5).
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
    journal: {},
    pins: {},
    // Open roll requests belong to a moment of play, and their targets' players have new member ids anyway (section 2.5).
    rolls: {},
  };

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
    if (s.map) {
      const mapped = asset(s.map.assetId, "map");
      if (mapped) next.map = { ...s.map, assetId: mapped };
      else delete next.map;
    }
    if (s.thumb !== undefined) {
      const mapped = asset(s.thumb, "thumb");
      if (mapped) next.thumb = mapped;
      else delete next.thumb;
    }
    if (s.phases) out.scenes[next.id] = withPhaseImages(next, s.phases, (id) => asset(id, "map"));
    else out.scenes[next.id] = next;
  }
  // New ids for stamps and lights, as for labels. A stamp of an image that did not come through goes with it.
  for (const st of Object.values(state.stamps)) {
    if (!scenes.has(st.sceneId)) continue;
    let art = st.art;
    if ("assetId" in art) {
      const mapped = asset(art.assetId, "token");
      if (!mapped) continue;
      art = { assetId: mapped };
    }
    const next: Stamp = { ...st, id: newId(), sceneId: scenes.of(st.sceneId), art };
    out.stamps[next.id] = next;
  }
  for (const l of Object.values(state.lights)) {
    if (!scenes.has(l.sceneId)) continue;
    const next: Light = { ...l, id: newId(), sceneId: scenes.of(l.sceneId) };
    out.lights[next.id] = next;
  }
  if (state.meta.playerSceneId !== null && scenes.has(state.meta.playerSceneId)) {
    out.meta.playerSceneId = scenes.of(state.meta.playerSceneId);
  } else {
    const first = Object.values(out.scenes).sort((a, b) => a.order - b.order)[0];
    out.meta.playerSceneId = first?.id ?? null;
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
  // The party's explored layer follows its scene, as the fog does (docs/design-v1-maps-vision.md 4.3.3).
  for (const t of Object.values(state.exploredTiles)) {
    if (!scenes.has(t.sceneId)) continue;
    const sceneId = scenes.of(t.sceneId);
    out.exploredTiles[tileKey(sceneId, t.tx, t.ty)] = { ...t, sceneId };
  }
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
    out.characters[next.id] = next;
  }
  for (const t of liveTokens) {
    // A path is tagged with the seq of its turn, and seqs start again in the new room (see `encounter` below).
    const { path: _path, ...rest } = t;
    const next: Token = {
      ...rest,
      id: tokens.of(t.id),
      sceneId: scenes.of(t.sceneId),
      ownerIds: memberList(t.ownerIds),
      actor: "ref" in t.actor ? { ref: characters.of(t.actor.ref) } : { inline: actor(t.actor.inline) },
    };
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
    const { turnStart, ...rest } = enc;
    const next: Encounter = { ...rest, activeEntryId: active, entries: kept };
    // The spot belongs to its row and token, so it goes with either of them.
    if (turnStart && entries.has(turnStart.entryId) && tokens.has(turnStart.tokenId) && scenes.has(turnStart.sceneId)) {
      // The seq that names the turn counts ops of the old room. The new room counts from the start again, so a
      // later turn could get the same number and take up an old path. The turn records no path until the next.
      const { seq: _seq, ...spot } = turnStart;
      next.turnStart = { ...spot, entryId: entries.of(turnStart.entryId), tokenId: tokens.of(turnStart.tokenId), sceneId: scenes.of(turnStart.sceneId) };
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
    const next: EncounterSnapshot = {
      encounter: encounter(snap.encounter),
      effects,
      revealed: snap.revealed.filter((r) => tokens.has(r.tokenId)).map((r) => ({ ...r, tokenId: tokens.of(r.tokenId) })),
      at: snap.at,
    };
    const legendaryHolder = snap.legendary ? holder(snap.legendary.holderId) : null;
    if (snap.legendary && legendaryHolder) next.legendary = { holderId: legendaryHolder, actionsUsed: snap.legendary.actionsUsed };
    return next;
  });
  for (const h of Object.values(state.handouts)) {
    if (!handouts.has(h.id)) continue;
    const to = h.to === "all" ? "all" : memberList(h.to);
    if (to !== "all" && to.length === 0) continue;
    const next: Handout = { ...h, id: handouts.of(h.id), assetId: asset(h.assetId, "handout")!, to };
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
      case "rest": {
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
        return data;
      case "teleport":
        return { ...data, tokenId: tokens.of(data.tokenId) };
      case "roll": {
        const next = { ...data };
        if (data.tokenId !== undefined) next.tokenId = tokens.of(data.tokenId);
        if (data.characterId !== undefined) next.characterId = characters.of(data.characterId);
        return next;
      }
    }
  };
  // Log ids are `"<seq>:<index>"`. The new room's ops start at seq 1, so seq 0 can never collide.
  for (const e of state.log) {
    const next: LogEntry = { ...e, id: `0:${out.log.length}` };
    if (e.from !== undefined) next.from = members.of(e.from);
    if (e.to !== undefined) next.to = e.to.map((id) => members.of(id));
    if (e.data) {
      const data = event(e.data);
      if (!data) continue;
      next.data = data;
    }
    out.log.push(next);
  }
  return out;
}

/**
 * A scene's phases with their images remapped (docs/design-v1-maps-vision.md
 * 2.5). A phase whose image did not come through goes. When the active one
 * went, the scene switches to the first one left, on the reference grid and
 * with its light level as any switch (withPhaseLight), and when none is
 * left the scene has neither phases nor a map.
 */
function withPhaseImages(scene: Scene, phases: readonly MapPhase[], asset: (id: string) => string | undefined): Scene {
  const kept = phases.flatMap((p) => {
    const mapped = asset(p.assetId);
    return mapped ? [{ ...p, assetId: mapped }] : [];
  });
  const { phases: _phases, phaseId: _phaseId, phaseGrid, map: _map, ...rest } = scene;
  const active = kept.find((p) => p.id === scene.phaseId) ?? kept[0];
  if (!active || !phaseGrid) return rest;
  const next: Scene = { ...rest, phases: kept, phaseId: active.id, phaseGrid, map: active.id === scene.phaseId && scene.map ? scene.map : phaseMap(phaseGrid, active) };
  return active.id === scene.phaseId ? next : withPhaseLight(next, active);
}
