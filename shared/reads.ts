import { doorChunk, keys, readEntity, type EntityKey } from "./keys.ts";
import type { RoomState, Viewer } from "./model.ts";
import type { ActorTarget, Op } from "./protocol.ts";
import type { ProjectedState } from "./project.ts";
import { nextTurn } from "./rules/initiative.ts";

/**
 * What an op reads (design 7.4), so the client knows whether its redacted
 * view can replay the op optimistically. A read names an entity key and the
 * fields the op needs on it. A "complete" read names a collection the op
 * scans, which only a DM viewing the right scene holds in full.
 */
export type Read = { key: EntityKey; fields?: string[] };

export type Collection =
  /** The encounter and every creature its rows point at. */
  | "encounter"
  /** Everything on one scene: tokens, templates, drawings, chunks, fog. */
  | `scene:${string}`
  /** Every token of every scene. */
  | "tokens"
  /** Every pin of every scene. */
  | "pins"
  /** Every roll request, which only a DM's view holds whole. */
  | "rolls"
  /** The scene list. */
  | "scenes";

export type Reads = { never: true } | { keys: Read[]; complete: Collection[] };

const NEVER: Reads = { never: true };

function of(keys_: Read[], complete: Collection[] = []): Reads {
  return { keys: keys_, complete };
}

/** The entity that holds a target's actor, with the fields the op needs on it. */
function holderRead(state: RoomState, target: ActorTarget, fields: string[]): Read {
  if ("characterId" in target) return { key: keys.character(target.characterId), fields: fields.map((f) => `actor.${f}`) };
  const token = state.tokens[target.tokenId];
  if (token && "ref" in token.actor) return { key: keys.character(token.actor.ref), fields: fields.map((f) => `actor.${f}`) };
  return { key: keys.token(target.tokenId), fields: fields.map((f) => `actor.inline.${f}`) };
}

/**
 * A "save ends" request's creature, whose effect a pass removes and a close
 * settles (docs/design-v1-roll-request.md 7.5): an answer or a close of such
 * a request reads its effects, so a DM's view that lacks the creature, a
 * token on a scene the DM is not viewing, waits for the server.
 */
function endsReads(state: RoomState, rollIds: readonly string[]): Read[] {
  const out: Read[] = [];
  for (const id of rollIds) {
    const request = state.rolls[id];
    const target = request?.ends ? request.targets[0] : undefined;
    if (target) out.push(holderRead(state, target.tokenId !== undefined ? { tokenId: target.tokenId } : { characterId: target.characterId! }, ["effects"]));
  }
  return out;
}

export function reads(op: Op, state: RoomState): Reads {
  switch (op.t) {
    case "undo":
    case "redo":
    case "sys.memberJoin":
    case "sys.memberSetKind":
    case "sys.memberRemove":
    case "sys.restore":
    case "sys.explore":
    // The server rolls (docs/design-v1-dice.md 4.5), so no client predicts a roll. It waits for the `ev`.
    case "sys.dice":
    case "dice.roll":
    case "roll.dice":
    case "actor.deathRoll":
      return NEVER;

    case "room.update":
    case "view.follow":
    case "view.blackout":
      return of([{ key: keys.meta }]);
    case "room.setPlayerScene":
      return of([{ key: keys.meta }, { key: keys.scene(op.sceneId) }]);
    case "member.update":
      return of([{ key: keys.member(op.memberId) }]);

    case "scene.create":
      return of([], ["scenes"]);
    case "scene.update":
    case "scene.setMap":
    case "scene.setGrid":
    case "scene.setPhase":
      return of([{ key: keys.scene(op.sceneId) }]);
    // A copy's derived ids are checked against every entity of the room,
    // which no client holds, and the DM waits for the server's answer anyway
    // ("Duplicating…").
    case "scene.duplicate":
      return NEVER;
    case "scene.delete":
      return of([{ key: keys.scene(op.sceneId) }], ["scenes", `scene:${op.sceneId}`, "encounter"]);
    case "scene.reorder":
      return of(op.order.map((id) => ({ key: keys.scene(id) })), ["scenes"]);

    case "token.create": {
      // A companion's checks read its character's tokens and the walls, and a player's writes the DM's line, so its
      // form waits for the server (docs/design-v1-combat-flow.md 4.6).
      if (op.token.companion) return NEVER;
      const r: Read[] = [{ key: keys.scene(op.token.sceneId) }];
      if ("ref" in op.token.actor) r.push({ key: keys.character(op.token.actor.ref) });
      const numbered = op.token.kind === "npc" || op.token.kind === "monster";
      return of(r, numbered ? [`scene:${op.token.sceneId}`] : []);
    }
    case "token.update": {
      // Changing what a companion is may remove rows, rewrite the history and bind durations over every actor.
      if (op.patch.companion !== undefined) return NEVER;
      // Its Reaction alone reads its `companion` field, so a device that holds the token predicts the switch at once.
      const r: Read[] = [{ key: keys.token(op.tokenId), ...(op.patch.companionReaction !== undefined ? { fields: ["companion"] } : {}) }];
      if (op.patch.sceneId !== undefined) r.push({ key: keys.scene(op.patch.sceneId) });
      if (op.patch.actor) r.push(holderRead(state, { tokenId: op.tokenId }, op.patch.actor.hp ? ["hp", "life"] : ["life"]));
      // A companion's block link reads the block's character, which the DM's and the owners' views hold (docs/design-v1-companion-stat-blocks.md 4.4).
      if (op.patch.actor?.blockId) r.push({ key: keys.companionBlock(op.patch.actor.blockId), fields: ["characterId"] });
      return of(r);
    }
    // A companion's deletion rewrites the fight's history (docs/design-v1-combat-flow.md 3.6.8).
    case "token.delete": {
      const token = state.tokens[op.tokenId];
      return of([{ key: keys.token(op.tokenId) }, { key: keys.encounterHistory }], token ? [`scene:${token.sceneId}`, "encounter"] : ["encounter"]);
    }
    case "token.move":
      return of([{ key: keys.token(op.tokenId) }]);
    case "token.moveMany":
      return of(op.moves.map((m) => ({ key: keys.token(m.tokenId) })));
    case "token.countLeg":
      return of([{ key: keys.token(op.tokenId), fields: ["path"] }, { key: keys.encounter }]);

    case "actor.hp":
      return of([holderRead(state, op.target, ["hp", "life", "effects"])]);
    case "actor.damageMany":
      return of(op.hits.map((hit) => holderRead(state, hit.target, ["hp", "life", "effects"])));
    case "actor.deathSave":
      return of([holderRead(state, op.target, ["deathSaves", "life"])]);
    case "actor.life":
    case "actor.rest":
      return of([holderRead(state, op.target, ["hp", "life", "effects"])]);
    case "actor.effect.add":
    case "actor.effect.update": {
      const r: Read[] = [holderRead(state, op.target, ["effects"])];
      const duration = op.t === "actor.effect.add" ? op.effect.duration : op.patch.duration;
      if (duration) {
        if ("tokenId" in duration.of) r.push({ key: keys.token(duration.of.tokenId) });
        else if ("characterId" in duration.of) r.push({ key: keys.character(duration.of.characterId) });
      }
      return of(r);
    }
    case "actor.effect.remove":
      return of([holderRead(state, op.target, ["effects"])]);

    case "character.create":
      return of([]);
    // New owners reach the character's companions on every scene, which only a one-scene room viewed whole holds.
    case "character.update":
      return of([{ key: keys.character(op.characterId), fields: op.patch.actor?.hp ? ["actor.hp", "actor.life"] : [] }], op.patch.ownerIds !== undefined ? ["tokens"] : []);
    case "character.delete":
      return of([{ key: keys.character(op.characterId) }, { key: keys.encounterHistory }], ["tokens", "encounter"]);

    // A DM's view always holds every monster and SRD image, whatever scene it shows.
    case "monster.create":
    case "monster.setSrdImage":
      return of([]);
    case "monster.update":
    case "monster.delete":
      return of([{ key: keys.monster(op.monsterId) }]);
    // A companion's stat blocks (docs/design-v1-companion-stat-blocks.md 4.4). The DM's and the character's owners'
    // views hold the character and its blocks, so both predict a save at once.
    case "companionBlock.create":
      return of([{ key: keys.character(op.block.characterId) }]);
    case "companionBlock.update":
    case "companionBlock.delete":
      return of([{ key: keys.companionBlock(op.blockId) }]);
    // Saved encounters too.
    case "savedEncounter.create":
      return of([]);
    case "savedEncounter.update":
    case "savedEncounter.delete":
      return of([{ key: keys.savedEncounter(op.encounterId) }]);

    case "template.create": {
      const r: Read[] = [{ key: keys.scene(op.template.sceneId) }];
      if (op.template.attachedTo !== undefined) r.push({ key: keys.token(op.template.attachedTo) });
      if (op.template.casterId !== undefined) r.push({ key: keys.token(op.template.casterId) });
      return of(r);
    }
    case "template.update": {
      const r: Read[] = [{ key: keys.template(op.templateId) }];
      if (op.patch.attachedTo) r.push({ key: keys.token(op.patch.attachedTo) });
      if (op.patch.casterId) r.push({ key: keys.token(op.patch.casterId) });
      return of(r);
    }
    case "template.delete":
      return of([{ key: keys.template(op.templateId) }]);

    case "drawing.create":
      return of([{ key: keys.scene(op.drawing.sceneId) }]);
    case "drawing.delete":
      return of([{ key: keys.drawing(op.drawingId) }]);
    case "drawing.clear":
      return of([{ key: keys.scene(op.sceneId) }], op.scope === "all" ? [`scene:${op.sceneId}`] : []);

    case "fog.draft":
    case "fog.publish":
    case "fog.discard":
    case "fog.live":
    case "fog.reset":
    case "build.paint":
    case "build.erase":
    case "build.rect":
    case "build.poly":
    case "build.edge":
    case "build.label":
    case "build.clear":
    case "build.walls":
    case "build.stamps":
    case "build.lights":
    case "build.stairs":
      return of([{ key: keys.scene(op.sceneId) }], [`scene:${op.sceneId}`]);
    // A height paint lifts the tokens standing there, so it reads the whole scene, as erase does.
    case "build.height":
      return of([{ key: keys.scene(op.sceneId) }], [`scene:${op.sceneId}`]);
    // A player opens a door their own view shows, so the door swings at once.
    case "door.set": {
      const { cx, cy } = doorChunk(op.door);
      return of([{ key: keys.scene(op.sceneId) }, { key: keys.chunk(op.sceneId, cx, cy) }]);
    }

    case "encounter.start":
    case "encounter.add": {
      const r: Read[] = [];
      for (const entry of op.entries) {
        if (entry.tokenId !== undefined) r.push({ key: keys.token(entry.tokenId) });
        if (entry.characterId !== undefined) r.push({ key: keys.character(entry.characterId) });
      }
      return of(r, ["encounter"]);
    }
    case "encounter.end":
    case "encounter.remove":
    case "encounter.setValue":
    case "encounter.setValues":
    case "encounter.reorder":
    case "encounter.update":
      return of([], ["encounter"]);
    case "encounter.next":
      return of([], ["encounter", ...companionScene(state)]);
    case "encounter.prev": {
      const saved = state.encounterHistory?.[state.encounterHistory.length - 1]?.companionReactions ?? [];
      return of([{ key: keys.encounterHistory }, ...saved.map((id) => ({ key: keys.token(id) }))], ["encounter"]);
    }

    case "log.chat":
      return of([]);
    case "log.whisper":
      return of(op.to.map((id) => ({ key: keys.member(id) })));
    case "handout.show":
      return of([]);
    case "handout.close":
      return of([{ key: keys.handout(op.handoutId) }]);
    // A DM's view holds every document, as it holds every saved encounter.
    case "handoutDoc.create":
      return of([]);
    case "handoutDoc.delete":
      return of([{ key: keys.handoutDoc(op.docId) }]);

    // Wave 5 (docs/design-v1-dm-tools.md). A group edit reads only its tokens, so a DM's on tokens in view replays at
    // once, and a player's waits when any target is redacted (section 3.5).
    case "token.updateMany":
      return of(op.tokenIds.map((id) => ({ key: keys.token(id) })));
    case "token.deleteMany": {
      const scenes = new Set<string>();
      for (const id of op.tokenIds) {
        const token = state.tokens[id];
        if (token) scenes.add(token.sceneId);
      }
      return of(
        [...op.tokenIds.map((id) => ({ key: keys.token(id) })), { key: keys.encounterHistory }],
        [...[...scenes].map((sceneId): Collection => `scene:${sceneId}`), "encounter"],
      );
    }
    case "actor.effects": {
      const r: Read[] = [];
      for (const item of op.add ?? []) {
        r.push(holderRead(state, item.target, ["effects"]));
        const of_ = item.effect.duration?.of;
        if (of_ && "tokenId" in of_) r.push({ key: keys.token(of_.tokenId) });
        else if (of_ && "characterId" in of_) r.push({ key: keys.character(of_.characterId) });
      }
      for (const item of op.remove ?? []) r.push(holderRead(state, item.target, ["effects"]));
      return of(r);
    }
    // A DM's view holds every journal page, whatever scene it shows.
    case "journal.create":
      return of([]);
    case "journal.update":
    case "journal.reveal":
      return of([{ key: keys.journal(op.pageId) }]);
    // A page's deletion makes every pin linked to it DM only, on every scene.
    case "journal.delete":
      return of([{ key: keys.journal(op.pageId) }], ["pins"]);
    case "pin.put": {
      const r: Read[] = [{ key: keys.scene(op.pin.sceneId) }];
      if (op.pin.pageId !== undefined) r.push({ key: keys.journal(op.pin.pageId) });
      return of(r, [`scene:${op.pin.sceneId}`]);
    }
    case "pin.remove":
      return of([{ key: keys.pin(op.pinId) }]);
    // The targets' creatures, which must be played by a player and, for a token, stand on the player scene.
    case "roll.ask": {
      const r: Read[] = [{ key: keys.meta }];
      for (const t of op.request.targets) r.push("tokenId" in t ? { key: keys.token(t.tokenId) } : { key: keys.character(t.characterId) });
      return of(r);
    }
    // A player's view of a request lacks a hidden DC and the other targets, so an answer waits for the server.
    case "roll.answer":
      return of([{ key: keys.roll(op.rollId) }, ...endsReads(state, [op.rollId])], ["rolls"]);
    case "roll.reopen":
      return of([{ key: keys.roll(op.rollId) }]);
    case "roll.close":
      return of([...op.rollIds.map((id) => ({ key: keys.roll(id) })), ...endsReads(state, op.rollIds)]);
  }
}

/**
 * The scene whose `shared` companions a Next clears (docs/design-v1-combat-flow.md
 * 3.6.8 and 4.6): the landing row token's scene, or the players' scene for
 * a row with no token. A DM's view that holds every row's token holds the
 * token's scene whole, so the DM's Next stays predicted there.
 */
function companionScene(state: RoomState): Collection[] {
  const encounter = state.encounter;
  if (!encounter) return [];
  const step = nextTurn(state, encounter, state.meta.settings);
  const landing = step ? encounter.entries.find((e) => e.id === step.landing) : undefined;
  if (!landing) return [];
  if (landing.tokenId !== undefined) {
    const token = state.tokens[landing.tokenId];
    return token ? [`scene:${token.sceneId}`] : [];
  }
  return state.meta.playerSceneId !== null ? [`scene:${state.meta.playerSceneId}`] : [];
}

function fieldPresent(entity: unknown, path: string): boolean {
  let current: unknown = entity;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[part];
    if (current === undefined) return false;
  }
  return true;
}

/**
 * Whether a client's view holds everything the op reads: every key present
 * with every field, and every scanned collection complete. Players never
 * hold a complete collection, because their projection removes things they
 * cannot know about.
 */
export function satisfies(reads_: Reads, view: ProjectedState, viewer: Viewer, opts: { sceneId: string | null }): boolean {
  if ("never" in reads_) return false;
  const state = view as unknown as RoomState;
  for (const read of reads_.keys) {
    const entity = readEntity(state, read.key);
    if (entity === null) return false;
    for (const field of read.fields ?? []) if (!fieldPresent(entity, field)) return false;
  }
  for (const collection of reads_.complete) {
    if (viewer.role !== "dm") return false;
    if (collection === "scenes" || collection === "rolls") continue;
    if (collection === "tokens" || collection === "pins") {
      // Every token or pin of every scene: only a one-scene room viewed in full has that.
      const sceneIds = Object.keys(state.scenes);
      if (sceneIds.length !== 1 || sceneIds[0] !== opts.sceneId) return false;
      continue;
    }
    if (collection.startsWith("scene:")) {
      if (collection.slice("scene:".length) !== opts.sceneId) return false;
      continue;
    }
    const encounter = state.encounter;
    if (!encounter) continue;
    for (const entry of encounter.entries) {
      if (entry.tokenId !== undefined && state.tokens[entry.tokenId] === undefined) return false;
      if (entry.characterId !== undefined && state.characters[entry.characterId] === undefined) return false;
    }
  }
  return true;
}
