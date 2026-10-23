import { uuidv7 } from "#shared/ids.ts";
import { chunkKey, compareLogIds, tileKey } from "#shared/keys.ts";
import { isPlainId } from "#shared/rules/traps.ts";
import { DM_LINE_BASE, lineAudience } from "#shared/logRings.ts";
import type {
  AreaTemplate,
  Character,
  CompanionBlock,
  CustomMonster,
  Drawing,
  Effect,
  Encounter,
  EncounterSnapshot,
  Handout,
  HandoutDoc,
  HandoutPage,
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
  Trap,
  TrapAction,
  TrapDue,
  TrapRig,
  Token,
} from "#shared/model.ts";
import { normalizeCompanionState } from "#shared/reducer/companions.ts";
import { withPcActors, withShapeRules } from "#shared/rules/pcStats.ts";
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
  const blocks = new Ids(newId);
  members.assign(Object.keys(state.members));
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
  const asset = (id: string, kind: AssetKind): string | undefined => {
    const imported = opts.assets.get(id);
    return imported?.kind === kind ? imported.id : undefined;
  };
  labels.assign(Object.values(state.labels).filter((l) => scenes.has(l.sceneId)).map((l) => l.id));
  /*
   * A handout's or a document's pages in order, each page that came through
   * as a handout image under its new id and the rest dropped
   * (docs/design-v1-pdf-handouts.md 3.6). One image is the list of its one page.
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
  const liveEntries = (state.encounter?.entries ?? []).filter((e) => (e.tokenId === undefined || tokens.has(e.tokenId)) && (e.characterId === undefined || characters.has(e.characterId)));
  entries.assign(liveEntries.map((e) => e.id));

  const memberList = (ids: string[]): string[] => ids.filter((id) => members.has(id)).map((id) => members.of(id));
  const effect = (withDue: Effect): Effect => {
    // An occurrence names a line of the old room's log, and the requests that answer it do not come through, so a save ends waits for the next turn end.
    const { due: _due, ...e } = withDue;
    if (!e.duration) return e;
    const a = e.duration.anchor;
    const anchor =
      "entryId" in a ? { entryId: entries.of(a.entryId) } : "tokenId" in a ? { tokenId: tokens.of(a.tokenId) } : { characterId: characters.of(a.characterId) };
    return { ...e, duration: { ...e.duration, anchor } };
  };
  // A link to a room monster follows its new id, and one to a monster that did not come through is dropped (wave 5). So does
  // a link to a companion block (docs/design-v1-companion-stat-blocks.md 3.6).
  const actor = <A extends { effects: Effect[]; monsterId?: string; blockId?: string }>(a: A): A => {
    const next: A = { ...a, effects: a.effects.map(effect) };
    if (a.monsterId !== undefined) {
      if (monsters.has(a.monsterId)) next.monsterId = monsters.of(a.monsterId);
      else delete next.monsterId;
    }
    if (a.blockId !== undefined) {
      if (blocks.has(a.blockId)) next.blockId = blocks.of(a.blockId);
      else delete next.blockId;
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
    handoutDocs: {},
    companionBlocks: {},
    // Open asks for saves belong to a moment of play too, and the import keeps their lines (docs/design-v1-player-save-spell.md 5.7).
    casts: {},
    traps: {},
    trapLog: [],
    trapSeen: [],
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
    // Known forms are SRD ids, which no room renames. A hand-made file's empty list is stored as none, the one state the reducer keeps (docs/design-v1-known-forms.md 3.1).
    if (c.knownForms?.length === 0) delete next.knownForms;
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
    // A companion follows its character's new id, and is a plain token once its character did not come through.
    if (t.companion) {
      if (characters.has(t.companion.of)) next.companion = { ...t.companion, of: characters.of(t.companion.of) };
      else delete next.companion;
    }
    // A link follows its holder's new id, and goes when the holder did not come through (docs/design-v1-attach.md 5.2).
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
    const { turnStart, ...rest } = enc;
    const next: Encounter = { ...rest, activeEntryId: active, entries: kept };
    // The spot belongs to its row and token, so it goes with either of them.
    if (turnStart && entries.has(turnStart.entryId) && tokens.has(turnStart.tokenId) && scenes.has(turnStart.sceneId)) {
      // The seq that names the turn counts ops of the old room. The new room counts from the start again, so a
      // later turn could get the same number and take up an old path. The turn records no path until the next.
      // Without its seq the turn shares nothing with a mount either (docs/design-v1-attach.md 7.1).
      const { seq: _seq, mounts: _mounts, ...spot } = turnStart;
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
    const reactions = (snap.companionReactions ?? []).filter((id) => tokens.has(id)).map((id) => tokens.of(id));
    if (reactions.length > 0) next.companionReactions = reactions;
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
  // A document gets a new id, as a handout does, and one left with no page is dropped (docs/design-v1-pdf-handouts.md 3.6).
  for (const d of Object.values(state.handoutDocs)) {
    const pages = handoutPagesOf(d.pages);
    if (pages.length === 0) continue;
    const next: HandoutDoc = { ...d, id: newId(), pages };
    out.handoutDocs[next.id] = next;
  }
  // A companion block follows its character's new id, and its picture follows its image or goes (docs/design-v1-companion-stat-blocks.md 3.6).
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
      case "saveEnds": {
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
      // The roller and each roll's creature follow their new ids (docs/design-v1-dice.md 5.3).
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
  // Log ids are `"<seq>:<index>"`. The new room's ops start at seq 1, so seq 0 can never collide. Lines are numbered in the
  // old room's order, the DM's from DM_LINE_BASE with the traps' (dmLineIdsOf), as the reducer writes them, so the lines a
  // player gets have no gap where one only the DM holds was.
  const dmLineIds = dmLineIdsOf(state, scenes);
  let shared = 0;
  for (const e of state.log) {
    const dm = lineAudience(e) === "dm";
    const next: LogEntry = { ...e, id: dm ? dmLineIds.get(e.id)! : `0:${shared}` };
    if (e.from !== undefined) next.from = members.of(e.from);
    if (e.to !== undefined) next.to = e.to.map((id) => members.of(id));
    if (e.data) {
      const data = event(e.data);
      if (!data) continue;
      next.data = data;
    }
    if (!dm) shared++;
    out.log.push(next);
  }
  out.log.sort((a, b) => compareLogIds(a.id, b.id));
  remapTraps(state, out, { scenes, tokens, stampIds, lightIds, newId, dmLineIds, sharedLines: shared });
  // A hand-made or older file is brought within the companion rules (docs/design-v1-combat-flow.md 4.7), a character's
  // initiative and Passive Perception follow its stat block, and a Wild Shape mark stands only beside its creature
  // (docs/design-v1-pc-stats.md 3.5 and 3.6).
  return withShapeRules(withPcActors(normalizeCompanionState(out)));
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

/**
 * The new ids of every line only the DM holds: the room log's DM lines
 * (shared/logRings.ts), the trap log's and the occurrences that name them,
 * each ring in the old room's order, all counting on from DM_LINE_BASE
 * together, as the reducer writes them (docs/design-v1-traps.md 6.3).
 * Numbered with the lines players get, each would leave a gap in theirs.
 */
function dmLineIdsOf(state: RoomState, scenes: { has(id: string): boolean }): Map<string, string> {
  const dmIds = new Set<string>();
  for (const line of state.log) if (lineAudience(line) === "dm") dmIds.add(line.id);
  for (const trap of Object.values(state.traps ?? {})) if (scenes.has(trap.sceneId)) for (const d of trap.rig?.due ?? []) dmIds.add(d.id);
  for (const line of state.trapLog ?? []) dmIds.add(line.id);
  const out = new Map<string, string>();
  for (const [i, id] of [...dmIds].sort(compareLogIds).entries()) out.set(id, `0:${DM_LINE_BASE + i}`);
  return out;
}

/**
 * Traps follow their scene (docs/design-v1-traps.md 6.8), each with a new
 * id, as pins do. What a trap names follows its new id: a light, a stamp
 * or a creature its actions show, and the creature its hint named, each
 * dropped when it did not come through. Doors keep their ids, as a scene's
 * chunks do. A trap's waiting occurrences and both trap logs come along,
 * named after the new ids, every list keeping only plain ids that came
 * through and counting the rest, as the reducer stores them (6.1). Lines
 * are numbered in the old room's order, the players' after the room log's
 * shared lines and the DM's from DM_LINE_BASE (dmLineIdsOf), so no two
 * imported lines share an id and the newest occurrence stays the newest.
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
    sharedLines: number;
  },
): void {
  const { scenes, tokens, stampIds, lightIds, newId, dmLineIds, sharedLines } = ids;
  const trapIds = new Map<string, string>();
  const lineId = (id: string) => dmLineIds.get(id)!;
  const seenLineIds = new Map<string, string>();
  const seenKept = (state.trapSeen ?? []).filter((line) => line.data?.type === "trapSeen");
  for (const [i, id] of seenKept.map((line) => line.id).sort(compareLogIds).entries()) seenLineIds.set(id, `0:${sharedLines + i}`);
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
    out.trapSeen.push({ ...line, id: seenLineIds.get(line.id)!, data: { ...rest, by: by.list, ...(by.more > 0 ? { more: by.more } : {}) } });
  }
}
