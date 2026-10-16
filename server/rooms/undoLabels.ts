import { chunkKey, doorChunk, keys } from "#shared/keys.ts";
import type { Actor, LogEvent, RoomState, Token, Viewer } from "#shared/model.ts";
import { projectEntity, type ProjectedToken } from "#shared/project.ts";
import { isResizeOp, type ActorTarget, type ClientOp, type OpOf, type TokenPatch } from "#shared/protocol.ts";
import { testText } from "#shared/rules/skills.ts";

/**
 * What an undo step did, as a short phrase for the toast that says what an
 * undo or redo took back ("Undid moving Goblin 2.", design 7.7). Undo must
 * never be a surprise: the person who pressed it may have forgotten what
 * their last change was, ten minutes and a handout ago.
 *
 * Built on the server from the op and the state before it, so deleted
 * things still have their names, and for an erase also the state after
 * it, which says what the erase took. Only the member who made the op ever sees
 * its phrase. A player's stack holds only their own drawings and token
 * moves, and a player's phrase names a token the way that player saw it
 * (a hidden name as the name players see, without its number), so a phrase
 * never names anything its reader could not see when they acted.
 */
export function describeOp(op: ClientOp, before: RoomState, viewer?: Viewer, after?: RoomState): string {
  const scene = (id: string) => the("scene", before.scenes[id]?.name);
  const token = (id: string) => tokenName(viewer?.role === "player" ? seenBy(before, viewer, id) : before.tokens[id]);
  const target = (t: ActorTarget) => ("tokenId" in t ? token(t.tokenId) : quoted(before.characters[t.characterId]?.name, "a character"));
  switch (op.t) {
    case "room.update":
      return op.settings ? "changing room settings" : "renaming the room";
    case "room.setPlayerScene":
      return `moving players to ${scene(op.sceneId)}`;
    case "view.follow":
      return op.follow ? "turning on Follow me" : "turning off Follow me";
    case "view.blackout":
      return op.blackout ? "blacking out players' screens" : "ending the blackout";
    case "member.update":
      return "changing your name or color";
    case "scene.create":
      return `adding ${the("scene", op.scene.name)}`;
    case "scene.update":
      if (op.patch.folder !== undefined && Object.keys(op.patch).length === 1) {
        return op.patch.folder === null ? `taking ${scene(op.sceneId)} out of its folder` : `moving ${scene(op.sceneId)} to ${the("folder", op.patch.folder)}`;
      }
      if (op.patch.phases !== undefined && Object.keys(op.patch).length === 1) return `changing the phases of ${scene(op.sceneId)}`;
      if (op.patch.blockMovement !== undefined && Object.keys(op.patch).length === 1) {
        return op.patch.blockMovement ? `making walls and ledges block players' moves on ${scene(op.sceneId)}` : `letting players' moves pass walls and ledges on ${scene(op.sceneId)}`;
      }
      if (op.patch.vision !== undefined && Object.keys(op.patch).every((k) => k === "vision" || k === "fogEnabled")) {
        // The Vision settings send one of the two at a time: party vision on or off, or the light level.
        const was = before.scenes[op.sceneId]?.vision;
        const { on, light } = op.patch.vision;
        if ((was?.on === true) !== on) return on ? `turning on party vision on ${scene(op.sceneId)}` : `turning off party vision on ${scene(op.sceneId)}`;
        if ((was?.light ?? "bright") !== light) return `making ${scene(op.sceneId)} ${light}`;
      }
      return `changing ${scene(op.sceneId)}`;
    case "scene.delete":
      return `deleting ${scene(op.sceneId)}`;
    case "scene.reorder":
      return "reordering scenes";
    case "scene.setMap":
      return `changing the map of ${scene(op.sceneId)}`;
    case "scene.setGrid":
      return `lining up the grid of ${scene(op.sceneId)}`;
    case "scene.setPhase": {
      const phase = before.scenes[op.sceneId]?.phases?.find((p) => p.id === op.phaseId);
      return `switching ${scene(op.sceneId)} to ${the("phase", phase?.name)}`;
    }
    case "scene.duplicate":
      return `duplicating ${scene(op.sceneId)}`;
    case "token.create":
      return `adding ${tokenName(op.token)}`;
    case "token.update": {
      if (op.patch.name !== undefined) return `renaming ${token(op.tokenId)} to ${quoted(op.patch.name, "nothing")}`;
      if (isResizeOp(op)) return `resizing ${token(op.tokenId)} to ${sizeWords(op.patch, before.tokens[op.tokenId])}`;
      const only = Object.keys(op.patch).length === 1;
      if (only && op.patch.light !== undefined) {
        const lit = (l: { bright: number; dim: number } | null | undefined) => !!l && (l.bright > 0 || l.dim > 0);
        if (!lit(op.patch.light)) return `putting out the light of ${token(op.tokenId)}`;
        return lit(before.tokens[op.tokenId]?.light) ? `changing the light of ${token(op.tokenId)}` : `giving ${token(op.tokenId)} a light`;
      }
      if (only && op.patch.partyVision !== undefined) {
        return op.patch.partyVision ? `letting ${token(op.tokenId)} share its sight with the party` : `stopping ${token(op.tokenId)} sharing its sight with the party`;
      }
      return `changing ${token(op.tokenId)}`;
    }
    case "token.delete":
      return `deleting ${token(op.tokenId)}`;
    case "token.move":
      return op.teleport ? `teleporting ${token(op.tokenId)}` : `moving ${token(op.tokenId)}`;
    case "token.countLeg":
      return op.counts ? `counting the last move of ${token(op.tokenId)} again` : `not counting the last move of ${token(op.tokenId)}`;
    case "token.moveMany": {
      const first = op.moves[0];
      return op.moves.length === 1 && first ? `moving ${token(first.tokenId)}` : `moving ${op.moves.length} tokens`;
    }
    case "actor.hp":
      return hpPhrase(op, target(op.target));
    case "actor.damageMany": {
      const first = op.hits[0];
      return op.hits.length === 1 && first ? `damaging ${target(first.target)}` : `damaging ${op.hits.length} creatures`;
    }
    case "actor.deathSave":
      return `marking death saves for ${target(op.target)}`;
    case "actor.life":
      return op.life === "dead" ? `marking ${target(op.target)} dead` : `reviving ${target(op.target)}`;
    case "actor.rest":
      return `${op.kind === "long" ? "a long rest" : "a short rest"} for ${target(op.target)}`;
    case "actor.effect.add":
      return `adding ${effectName(op.effect.key, op.effect.label)} to ${target(op.target)}`;
    case "actor.effect.update":
      return `changing an effect on ${target(op.target)}`;
    case "actor.effect.remove":
      return `removing an effect from ${target(op.target)}`;
    case "character.create":
      return `adding ${the("character", op.character.name)}`;
    case "character.update":
      return `changing ${the("character", before.characters[op.characterId]?.name)}`;
    case "character.delete":
      return `deleting ${the("character", before.characters[op.characterId]?.name)}`;
    case "monster.create":
      return `adding ${the("monster", op.monster.name)}`;
    case "monster.update":
      return `changing ${the("monster", before.monsters[op.monsterId]?.name)}`;
    case "monster.delete":
      return `deleting ${the("monster", before.monsters[op.monsterId]?.name)}`;
    case "companionBlock.create":
      return `adding ${the("stat block", op.block.name)}`;
    case "companionBlock.update":
      return `changing ${the("stat block", before.companionBlocks[op.blockId]?.name)}`;
    case "companionBlock.delete":
      return `deleting ${the("stat block", before.companionBlocks[op.blockId]?.name)}`;
    case "monster.setSrdImage":
      return `${op.image ? "setting" : "removing"} the image of ${srdName(op.srdId)}`;
    case "savedEncounter.create":
      return `saving ${encounterName(op.encounter.name)}`;
    case "savedEncounter.update":
      return `changing ${encounterName(before.savedEncounters[op.encounterId]?.name)}`;
    case "savedEncounter.delete":
      return `deleting ${encounterName(before.savedEncounters[op.encounterId]?.name)}`;
    case "template.create":
      return `placing ${areaName(op.template.spell ?? op.template.label)}`;
    case "template.update": {
      const t = before.templates[op.templateId];
      return `changing ${areaName(t?.spell ?? t?.label)}`;
    }
    case "template.delete": {
      const t = before.templates[op.templateId];
      return `deleting ${areaName(t?.spell ?? t?.label)}`;
    }
    case "drawing.create":
      return op.drawing.kind === "ruler" ? "keeping a ruler" : "drawing";
    case "drawing.delete":
      return before.drawings[op.drawingId]?.kind === "ruler" ? "removing a kept ruler" : "erasing a drawing";
    case "drawing.clear":
      return op.scope === "all" ? "clearing all drawings" : "clearing your drawings";
    case "fog.draft":
      return "editing the fog draft";
    case "fog.publish":
      return "showing the fog draft to players";
    case "fog.discard":
      return "discarding the fog draft";
    case "fog.live":
      return "changing the fog";
    case "fog.reset":
      return op.to === "hidden" ? "hiding the whole scene" : "revealing the whole scene";
    case "build.paint":
      return "painting floor";
    case "build.erase":
      return after ? erasingLabel(erasedBy(op.sceneId, before, after)) : "erasing";
    case "build.rect":
      return op.terrain === null ? "erasing a rectangle" : "adding a room";
    case "build.poly":
      return op.terrain === null ? "erasing a shape" : "adding a shaped room";
    case "build.edge":
      return "changing walls and doors";
    case "build.label":
      if (op.label === null) return "deleting a label";
      return before.labels[op.labelId] ? "changing a label" : "adding a label";
    case "build.clear":
      return "clearing the build";
    case "build.walls":
      return "changing walls and doors";
    case "build.stamps": {
      const put = op.put ?? [];
      const removed = op.remove ?? [];
      const only = put.length === 1 && removed.length === 0 ? put[0] : undefined;
      if (put.length === 0) return removed.length === 1 ? "deleting a stamp" : "deleting stamps";
      if (only) return before.stamps[only.id] ? "changing a stamp" : "placing a stamp";
      return "changing stamps";
    }
    case "build.lights":
      return "changing lights";
    case "build.height":
      return op.height === 0 ? "clearing heights" : "painting heights";
    case "build.stairs":
      return op.up === null ? "clearing stairs" : "marking stairs";
    case "door.set":
      return doorPhrase(op, before);
    case "encounter.start":
      return "starting the fight";
    case "encounter.end":
      return "ending the fight";
    case "encounter.add":
      return "adding to initiative";
    case "encounter.remove":
      return "removing from initiative";
    case "encounter.setValue":
    case "encounter.setValues":
      return "setting initiative";
    case "encounter.reorder":
      return "reordering initiative";
    case "encounter.next":
      return "moving to the next turn";
    case "encounter.prev":
      return "going back a turn";
    case "encounter.update":
      return "changing an initiative entry";
    case "log.chat":
    case "log.whisper":
      return "sending a message";
    case "handout.show":
      return `showing ${the("handout", op.handout.title)}`;
    case "handout.close":
      return `closing ${the("handout", before.handouts[op.handoutId]?.title)}`;
    case "handoutDoc.create":
      return `saving ${the("handout", op.doc.title)}`;
    case "handoutDoc.delete":
      return `deleting ${the("handout", before.handoutDocs[op.docId]?.title)}`;
    case "token.updateMany":
      return manyTokens("changing", op.tokenIds, token);
    case "token.deleteMany":
      return manyTokens("deleting", op.tokenIds, token);
    case "actor.effects":
      return effectsPhrase(op, before, target);
    case "journal.create":
      return `adding ${the("page", op.page.title)}`;
    case "journal.update":
      return `changing ${the("page", before.journal[op.pageId]?.title)}`;
    case "journal.reveal":
      return `${op.revealed ? "revealing" : "hiding"} a secret on ${the("page", before.journal[op.pageId]?.title)}`;
    case "journal.delete":
      return `deleting ${the("page", before.journal[op.pageId]?.title)}`;
    case "pin.put":
      return before.pins[op.pin.id] ? "changing a pin" : "placing a pin";
    case "pin.remove":
      return "deleting a pin";
    case "roll.ask":
      return `asking for ${testText(op.request.test)}`;
    case "roll.answer":
      // Only the DM's answers go on a stack (design 7.7): a player answers again to change theirs.
      return op.total === undefined ? `marking the roll of ${target(op.target)}` : `entering the roll of ${target(op.target)}`;
    case "roll.reopen":
      return `reopening the roll of ${target(op.target)}`;
    case "roll.close": {
      const first = op.rollIds.length === 1 ? before.rolls[op.rollIds[0]!] : undefined;
      if (first) return `closing the request for ${testText(first.test)}`;
      return op.rollIds.length === 1 ? "closing a roll request" : `closing ${op.rollIds.length} roll requests`;
    }
    case "undo":
    case "redo":
      return op.t;
  }
}

/** "changing 6 tokens", or the one token's name when the group has one. */
function manyTokens(verb: string, tokenIds: readonly string[], token: (id: string) => string): string {
  const first = tokenIds[0];
  return tokenIds.length === 1 && first !== undefined ? `${verb} ${token(first)}` : `${verb} ${tokenIds.length} tokens`;
}

/** The actor behind a target as the state held it, for the names of the effects a step removed. */
function actorOf(state: RoomState, t: ActorTarget): Actor | undefined {
  if ("characterId" in t) return state.characters[t.characterId]?.actor;
  const token = state.tokens[t.tokenId];
  if (!token) return undefined;
  return "inline" in token.actor ? token.actor.inline : state.characters[token.actor.ref]?.actor;
}

/**
 * A group's conditions (docs/design-v1-dm-tools.md 3.5): "adding Frightened
 * to 4 creatures", "removing Poisoned from Thorn", or "changing effects on
 * 3 creatures" when the step did several things.
 */
function effectsPhrase(op: OpOf<"actor.effects">, before: RoomState, target: (t: ActorTarget) => string): string {
  const tally = effectsTally(op, before);
  const first = [...(op.add ?? []), ...(op.remove ?? [])][0];
  return effectsWords(tally, tally.creatures.length === 1 && first ? target(first.target) : `${tally.creatures.length} creatures`);
}

/** The creatures an `actor.effects` changes and the names of what it adds and removes, which a step of several sums (addTally). */
function effectsTally(op: OpOf<"actor.effects">, before: RoomState | undefined): Extract<Tally, { verb: "effects" }> {
  const adds = op.add ?? [];
  const removes = op.remove ?? [];
  const creatures = [...adds, ...removes].map((item) => ("tokenId" in item.target ? `t:${item.target.tokenId}` : `c:${item.target.characterId}`));
  const removed = removes.map((r) => {
    const effect = before ? actorOf(before, r.target)?.effects.find((e) => e.id === r.effectId) : undefined;
    return effect ? effectName(effect.key, effect.label) : "an effect";
  });
  return { verb: "effects", creatures: [...new Set(creatures)], added: [...new Set(adds.map((a) => effectName(a.effect.key, a.effect.label)))], removed: [...new Set(removed)] };
}

function effectsWords(tally: Extract<Tally, { verb: "effects" }>, who: string): string {
  const [added] = tally.added;
  const [removed] = tally.removed;
  if (tally.removed.length === 0) return tally.added.length === 1 && added !== undefined ? `adding ${added} to ${who}` : `adding effects to ${who}`;
  if (tally.added.length === 0) return tally.removed.length === 1 && removed !== undefined ? `removing ${removed} from ${who}` : `removing effects from ${who}`;
  return `changing effects on ${who}`;
}

/**
 * The tokens an op adds, moves or changes, or the folder whose scene it
 * moves to another folder. A gesture sent as several ops under one undo
 * group (an encounter placed on the map, a big move sent in bands, a
 * monster's image applied to its tokens, a folder renamed on each of its
 * scenes) is one step, and its first op's phrase names only that op's
 * token or scene ("adding Goblin 1"), so the step counts these to name the
 * whole of it.
 */
export type Tally =
  | { verb: "adding" | "moving" | "changing" | "deleting"; tokenIds: string[] }
  | { verb: "renaming"; folder: string; to: string }
  | ({ verb: "erasing" } & Erased)
  /** A group's conditions over 100 creatures, sent in batches (docs/design-v1-dm-tools.md 3.5): creature keys and effect names. */
  | { verb: "effects"; creatures: string[]; added: string[]; removed: string[] };

export function tallyOf(op: ClientOp, before?: RoomState, after?: RoomState): Tally | undefined {
  switch (op.t) {
    case "build.erase":
      // A brush stroke is sent as several erases in one group, so the step is named for what all of them took.
      return before && after ? { verb: "erasing", ...erasedBy(op.sceneId, before, after) } : undefined;
    case "token.create":
      return { verb: "adding", tokenIds: [op.token.id] };
    case "token.move":
      return { verb: "moving", tokenIds: [op.tokenId] };
    case "token.moveMany":
      return { verb: "moving", tokenIds: op.moves.map((m) => m.tokenId) };
    case "token.update":
      return { verb: "changing", tokenIds: [op.tokenId] };
    // A selection over 100 tokens goes as several group ops under one undo group (docs/design-v1-dm-tools.md 3.5).
    case "token.updateMany":
      return { verb: "changing", tokenIds: op.tokenIds };
    case "token.deleteMany":
      return { verb: "deleting", tokenIds: op.tokenIds };
    case "actor.effects":
      return effectsTally(op, before);
    case "scene.update": {
      // The Scenes panel renames a folder by moving each of its scenes to the new name (client/features/scenes/folders.ts).
      const from = before?.scenes[op.sceneId]?.folder;
      const to = op.patch.folder;
      const onlyFolder = Object.keys(op.patch).length === 1;
      return onlyFolder && typeof to === "string" && from !== undefined && from !== to ? { verb: "renaming", folder: from, to } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * A step's tally after one more op. An op that adds, moves or changes no
 * token, such as the placed tokens' tracker rows, leaves it as it was. One
 * that does something else to tokens ends the count, so a gesture is never
 * named by half of it. A folder's scenes moved to another name stay one
 * rename only while every op moves them between the same two names.
 */
export function addTally(step: Tally | undefined, op: Tally | undefined): Tally | undefined {
  if (!step || !op) return step;
  if (step.verb === "renaming" || op.verb === "renaming") {
    return step.verb === "renaming" && op.verb === "renaming" && step.folder === op.folder && step.to === op.to ? step : undefined;
  }
  if (step.verb === "erasing" || op.verb === "erasing") {
    if (step.verb !== "erasing" || op.verb !== "erasing") return undefined;
    return {
      verb: "erasing",
      floor: step.floor + op.floor,
      walls: step.walls + op.walls,
      labels: step.labels + op.labels,
      stamps: step.stamps + op.stamps,
      lights: step.lights + op.lights,
    };
  }
  if (step.verb === "effects" || op.verb === "effects") {
    if (step.verb !== "effects" || op.verb !== "effects") return undefined;
    const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
    return { verb: "effects", creatures: union(step.creatures, op.creatures), added: union(step.added, op.added), removed: union(step.removed, op.removed) };
  }
  if (step.verb !== op.verb) return undefined;
  return { verb: step.verb, tokenIds: [...new Set([...step.tokenIds, ...op.tokenIds])] };
}

/**
 * The phrase for a whole merged step, "adding 6 tokens" or "renaming the
 * folder Act one to Act two", or undefined when the first op's own phrase
 * already says it (one token).
 */
export function describeTally(tally: Tally): string | undefined {
  if (tally.verb === "renaming") return `renaming ${the("folder", tally.folder)} to ${quoted(tally.to, "a new name")}`;
  if (tally.verb === "erasing") return erasingLabel(tally);
  // One creature is named by the op's own phrase, which knows its name.
  if (tally.verb === "effects") return tally.creatures.length > 1 ? effectsWords(tally, `${tally.creatures.length} creatures`) : undefined;
  return tally.tokenIds.length > 1 ? `${tally.verb} ${tally.tokenIds.length} tokens` : undefined;
}

/** Names come from people, so a long one is cut to keep the toast to a line or two. */
const MAX_NAME = 40;

function quoted(name: string | undefined, fallback: string): string {
  const trimmed = name?.trim();
  if (!trimmed) return fallback;
  return trimmed.length > MAX_NAME ? `${trimmed.slice(0, MAX_NAME - 1)}…` : trimmed;
}

/** What an erase took from its scene, counted. */
type Erased = { floor: number; walls: number; labels: number; stamps: number; lights: number };

/**
 * Counts what an erase took. Entities are replaced, never changed in
 * place, so only the chunks the erase wrote are compared.
 */
function erasedBy(sceneId: string, before: RoomState, after: RoomState): Erased {
  const erased: Erased = { floor: 0, walls: 0, labels: 0, stamps: 0, lights: 0 };
  for (const [key, chunk] of Object.entries(before.buildChunks)) {
    const next = after.buildChunks[key];
    if (chunk.sceneId !== sceneId || next === chunk) continue;
    erased.floor += Object.keys(chunk.cells).length - Object.keys(next?.cells ?? {}).length;
    erased.walls += Object.keys(chunk.edges).length - Object.keys(next?.edges ?? {}).length;
    erased.walls += (chunk.walls?.length ?? 0) - (next?.walls?.length ?? 0);
  }
  const gone = <T extends { sceneId: string }>(from: Record<string, T>, to: Record<string, T>) =>
    Object.entries(from).filter(([id, thing]) => thing.sceneId === sceneId && !(id in to)).length;
  erased.labels = gone(before.labels, after.labels);
  erased.stamps = gone(before.stamps, after.stamps);
  erased.lights = gone(before.lights, after.lights);
  return erased;
}

/**
 * An erase takes the floor in its cells and everything on them, so when
 * floor went the label says floor, as it always has. A Universal VTT map
 * has no floor, and an erase over it takes only walls, lights or stamps,
 * so the label names the one kind it took rather than saying "floor".
 * Several kinds, or nothing, read as plain "erasing".
 */
function erasingLabel(e: Erased): string {
  if (e.floor > 0) return "erasing floor";
  const took: string[] = [];
  if (e.walls > 0) took.push("erasing walls and doors");
  if (e.labels > 0) took.push(e.labels === 1 ? "erasing a label" : "erasing labels");
  if (e.stamps > 0) took.push(e.stamps === 1 ? "erasing a stamp" : "erasing stamps");
  if (e.lights > 0) took.push(e.lights === 1 ? "erasing a light" : "erasing lights");
  return took.length === 1 ? took[0]! : "erasing";
}

/** "the scene Cave", or "a scene" when it has no name to give. */
function the(kind: string, name: string | undefined): string {
  const n = quoted(name, "");
  return n ? `the ${kind} ${n}` : `a ${kind}`;
}

/** A token as a player's projection showed it, or undefined when it showed none. */
function seenBy(state: RoomState, viewer: Viewer, tokenId: string): ProjectedToken | undefined {
  return (projectEntity(keys.token(tokenId), state, viewer, { sceneId: state.meta.playerSceneId }) as ProjectedToken | null) ?? undefined;
}

function tokenName(token: Pick<Token, "name" | "number"> | undefined): string {
  if (!token) return "a token";
  const name = quoted(token.name, "a token");
  return token.number === undefined ? name : `${name} ${token.number}`;
}

/**
 * An SRD monster by its slug, "goblin-warrior" read as "Goblin Warrior".
 * Labels are built synchronously and the SRD list is half a megabyte, so
 * the slug stands in for the printed name, which it nearly always matches.
 */
function srdName(srdId: string): string {
  return srdId
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** "the encounter Goblin ambush", or "an encounter". */
function encounterName(name: string | undefined): string {
  const n = quoted(name, "");
  return n ? `the encounter ${n}` : "an encounter";
}

function areaName(name: string | undefined): string {
  const n = quoted(name, "");
  return n ? n : "an area";
}

function effectName(key: string, label: string | undefined): string {
  const custom = quoted(label, "");
  if (custom) return custom;
  if (key === "custom") return "an effect";
  const words = key.replaceAll("-", " ");
  return words[0]!.toUpperCase() + words.slice(1);
}

/**
 * An HP change on a log line, in the words its op's own undo would use, for
 * the DM taking it back from the log ("Undid damaging Goblin 2.").
 */
export function describeHpEvent(event: Extract<LogEvent, { type: "hp" }>, state: RoomState): string {
  const name =
    event.characterId !== undefined
      ? quoted(state.characters[event.characterId]?.name, "a character")
      : event.tokenId !== undefined
        ? tokenName(state.tokens[event.tokenId])
        : "a creature";
  return hpChangePhrase(event.change, name);
}

function hpPhrase(op: OpOf<"actor.hp">, name: string): string {
  return hpChangePhrase(op.change.kind, name);
}

function hpChangePhrase(kind: OpOf<"actor.hp">["change"]["kind"], name: string): string {
  switch (kind) {
    case "damage":
      return `damaging ${name}`;
    case "heal":
      return `healing ${name}`;
    case "temp":
      return `giving ${name} temporary HP`;
    case "set":
      return `setting ${name}'s HP`;
  }
}

/**
 * What a door edit did, from the door as it was: Mark found and Hide name
 * the secret door, and a closed door locked or a locked one unlocked name
 * the lock, so the DM's undo toast says what it takes back. Only the DM's
 * door edits go on a stack (design 7.7), so the lock it names is the DM's.
 */
function doorPhrase(op: OpOf<"door.set">, before: RoomState): string {
  if (op.found !== undefined) return op.found ? "marking a secret door found" : "hiding a secret door";
  const { cx, cy } = doorChunk(op.door);
  const chunk = before.buildChunks[chunkKey(op.sceneId, cx, cy)];
  const ref = op.door;
  const feature = "edge" in ref ? chunk?.edges[ref.edge] : chunk?.walls?.find((w) => w.id === ref.id)?.f;
  const was = feature?.kind === "door" ? feature.state : undefined;
  if (op.state === "open") return "opening a door";
  if (op.state === "locked") return "locking a door";
  return was === "locked" ? "unlocking a door" : "closing a door";
}

/** A resize's new size as its step names it: "Large", or a Custom size's squares, its width and height from the patch or the token. */
function sizeWords(patch: TokenPatch, token: Token | undefined): string {
  const size = patch.size ?? token?.size ?? "medium";
  if (size !== "custom") return size.charAt(0).toUpperCase() + size.slice(1);
  const w = patch.w ?? token?.w ?? 1;
  const h = patch.h ?? token?.h ?? 1;
  return `${w} by ${h} squares`;
}
