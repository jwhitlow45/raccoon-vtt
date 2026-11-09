import { spanText } from "#shared/calendar.ts";
import { chunkKey, doorChunk, keys } from "#shared/keys.ts";
import type { Actor, LogEvent, RoomState, Token, Viewer } from "#shared/model.ts";
import { PLAYERS_SEE_WORDS, playersSeeOf } from "#shared/playersSee.ts";
import { gridOfScene, gridOfToken, projectEntity, type ProjectedToken } from "#shared/project.ts";
import { isResizeOp, type ActorTarget, type ClientOp, type OpOf, type TokenPatch } from "#shared/protocol.ts";
import { ownEntry } from "#shared/records.ts";
import { testText } from "#shared/rules/skills.ts";
import { LINK_LABELS, climbLabel, linkDir } from "#shared/rules/floorLinks.ts";
import { sizeCategory } from "#shared/rules/footprint.ts";
import { cellWord, SQUARES, type Grid } from "#shared/rules/grid.ts";

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
  const scene = (id: string) => the("scene", placeOf(before, id));
  // A floor by its own name, as Floors lists it (docs/design/design-v1-floors.md 7.1).
  const floor = (state: RoomState, id: string) => quoted(state.scenes[id]?.floor?.name, "a floor");
  const token = (id: string) => tokenName(viewer?.role === "player" ? seenBy(before, viewer, id) : before.tokens[id]);
  const target = (t: ActorTarget) => ("tokenId" in t ? token(t.tokenId) : quoted(before.characters[t.characterId]?.name, "a character"));
  switch (op.t) {
    case "room.update":
      // The Sound panel's Players see what is playing switch sends the setting alone (docs/design/design-v1-music.md 6.6).
      if (op.name === undefined && op.settings?.soundNames !== undefined && Object.keys(op.settings).length === 1) {
        return op.settings.soundNames ? "turning on Players see what is playing" : "turning off Players see what is playing";
      }
      // As does its Only DM devices play switch (docs/design/design-v1-sound-dm-only.md 4).
      if (op.name === undefined && op.settings?.soundDmOnly !== undefined && Object.keys(op.settings).length === 1) {
        return op.settings.soundDmOnly ? "turning on Only DM devices play" : "turning off Only DM devices play";
      }
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
      // The reducer names a new floor, so the label reads the state after it (docs/design/design-v1-floors.md 9).
      if (op.floor !== undefined) return `adding ${after ? floor(after, op.scene.id) : "a floor"}`;
      return `adding ${the("scene", op.scene.name)}`;
    case "scene.update":
      if (op.patch.floor !== undefined && Object.keys(op.patch).length === 1) {
        return op.patch.floor.name !== undefined ? `renaming ${floor(before, op.sceneId)}` : `changing the height of ${floor(before, op.sceneId)}`;
      }
      if (op.patch.folder !== undefined && Object.keys(op.patch).length === 1) {
        return op.patch.folder === null ? `taking ${scene(op.sceneId)} out of its folder` : `moving ${scene(op.sceneId)} to ${the("folder", op.patch.folder)}`;
      }
      if (op.patch.phases !== undefined && Object.keys(op.patch).length === 1) return `changing the phases of ${scene(op.sceneId)}`;
      if (op.patch.suggestedView !== undefined && Object.keys(op.patch).length === 1) return `changing the suggested view of ${scene(op.sceneId)}`;
      if (op.patch.weather !== undefined && Object.keys(op.patch).length === 1) return `changing the weather of ${scene(op.sceneId)}`;
      if (op.patch.sound !== undefined && Object.keys(op.patch).length === 1) return `changing the sound of ${scene(op.sceneId)}`;
      if (op.patch.blockMovement !== undefined && Object.keys(op.patch).length === 1) {
        return op.patch.blockMovement ? `making walls and ledges block players' moves on ${scene(op.sceneId)}` : `letting players' moves pass walls and ledges on ${scene(op.sceneId)}`;
      }
      if (op.patch.vision !== undefined && Object.keys(op.patch).every((k) => k === "vision" || k === "fogEnabled")) {
        // Fog and vision's settings and Light send one of the four at a time: Players see, party vision on or off, the light level, or the Sight row.
        const was = before.scenes[op.sceneId]?.vision;
        const { on, light, perPlayer } = op.patch.vision;
        // Players see sends fog and party vision together and names no Sight (docs/design/design-v1-map-discovery.md 8.1).
        const shown = before.scenes[op.sceneId];
        if (op.patch.fogEnabled !== undefined && perPlayer === undefined && shown) {
          const to = playersSeeOf({ fogEnabled: op.patch.fogEnabled, vision: { on, light } });
          if (playersSeeOf(shown) !== to) return `setting Players see on ${scene(op.sceneId)} to ${PLAYERS_SEE_WORDS[to]}`;
        }
        if (perPlayer !== undefined && (was?.perPlayer === true) !== perPlayer) {
          return perPlayer ? `making sight per player on ${scene(op.sceneId)}` : `making sight whole party on ${scene(op.sceneId)}`;
        }
        if ((was?.on === true) !== on) return on ? `turning on party vision on ${scene(op.sceneId)}` : `turning off party vision on ${scene(op.sceneId)}`;
        if ((was?.light ?? "bright") !== light) return `making ${scene(op.sceneId)} ${light}`;
      }
      return `changing ${scene(op.sceneId)}`;
    case "vision.holders":
      return `choosing who sees for themselves on ${scene(op.sceneId)}`;
    case "scene.delete": {
      // Remove floor takes one floor, and Delete a scene's main floor takes every floor with it (docs/design/design-v1-floors.md 9).
      const of = before.scenes[op.sceneId]?.floor?.of;
      if (of !== undefined && of !== op.sceneId) return `removing ${floor(before, op.sceneId)}`;
      return `deleting ${the("scene", before.scenes[op.sceneId]?.name)}`;
    }
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
      // Duplicate copies every floor of the scene (docs/design/design-v1-floors.md 9), so it names the scene alone.
      return `duplicating ${the("scene", before.scenes[op.sceneId]?.name)}`;
    case "floor.order":
      return `reordering the floors of ${the("scene", before.scenes[op.sceneId]?.name)}`;
    case "floor.open":
      return op.open ? `showing ${floor(before, op.sceneId)} to players` : `hiding ${floor(before, op.sceneId)} from players`;
    // Stairs and ladders by their far floor (docs/design/design-v1-floors.md phase 2, 7.2).
    case "floorLink.put":
      return LINK_LABELS.placed(op.link?.kind ?? "stairs", (op.link && before.scenes[op.link.to]?.floor?.name) ?? "a floor");
    case "floorLink.update": {
      const link = before.floorLinks?.[op.linkId];
      if (op.patch.locked !== undefined && op.patch.kind === undefined) return LINK_LABELS.lock(link?.kind ?? "stairs", op.patch.locked);
      return LINK_LABELS.kind(link?.kind ?? "stairs");
    }
    case "floorLink.delete": {
      const link = before.floorLinks?.[op.linkId];
      return LINK_LABELS.removed(link?.kind ?? "stairs", (link && before.scenes[link.to]?.floor?.name) ?? "a floor");
    }
    case "token.create":
      return `adding ${tokenName(op.token)}`;
    case "token.update": {
      if (op.patch.name !== undefined) return `renaming ${token(op.tokenId)} to ${quoted(op.patch.name, "nothing")}`;
      if (isResizeOp(op)) {
        const t = before.tokens[op.tokenId];
        return `resizing ${token(op.tokenId)} to ${sizeWords(op.patch, t, t ? gridOfToken(before, t) : SQUARES)}`;
      }
      const only = Object.keys(op.patch).length === 1;
      // A drop between squares on the token's own box, or Snap to grid (docs/design/design-v1-snap-off.md 5.5).
      if (only && op.patch.drawnAt !== undefined) return op.patch.drawnAt ? `placing ${token(op.tokenId)} between squares` : `snapping ${token(op.tokenId)} to the grid`;
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
    case "token.climb": {
      const link = before.floorLinks?.[op.linkId];
      return climbLabel(token(op.tokenId), (link && linkDir(before, link)) ?? "up", link?.kind ?? "stairs");
    }
    case "token.countLeg":
      return op.counts ? `counting the last move of ${token(op.tokenId)} again` : `not counting the last move of ${token(op.tokenId)}`;
    // Attached tokens (docs/design/design-v1-attach.md 8.3): "putting Bree on Warhorse", "letting go of Goblin 2".
    case "token.attach":
      if (op.kind === "drag") return `letting ${token(op.to)} drag ${token(op.tokenId)}`;
      if (op.kind === "carry") return `letting ${token(op.to)} carry ${token(op.tokenId)}`;
      return `putting ${token(op.tokenId)} on ${token(op.to)}`;
    case "token.detach": {
      // The whole link: a player's detach is taken only of a link to a holder they see (shared/permissions.ts detachCheck),
      // and the holder is named as their copy names it, so the label never tells them of one hidden from them.
      const link = before.tokens[op.tokenId]?.attached;
      if (op.x !== undefined) return link ? `taking ${token(op.tokenId)} off ${token(link.to)}` : `moving ${token(op.tokenId)}`;
      return before.tokens[op.tokenId]?.kind === "object" && link?.kind !== "drag" ? `putting down ${token(op.tokenId)}` : `letting go of ${token(op.tokenId)}`;
    }
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
      return `marking Death Saves for ${target(op.target)}`;
    case "actor.life":
      return op.life === "dead" ? `marking ${target(op.target)} dead` : `reviving ${target(op.target)}`;
    case "actor.rest":
      return `${op.kind === "long" ? "a Long Rest" : "a Short Rest"} for ${target(op.target)}`;
    case "actor.effect.add":
      return `adding ${effectName(op.effect.key, op.effect.label)} to ${target(op.target)}`;
    case "actor.effect.update":
      return `changing an effect on ${target(op.target)}`;
    case "actor.effect.remove":
      return `removing an effect from ${target(op.target)}`;
    case "actor.outcome": {
      // A plan names 1 to 100 creatures. The test's smallest op names none.
      const targets = op.targets ?? [];
      const first = targets[0];
      const who = targets.length === 1 && first ? target(first.target) : String(targets.length);
      // A trap's springing that changed no one is only settled (docs/design/design-v1-traps.md 4.4).
      if (targets.length === 0 && op.trap) return `settling ${op.label ?? "a trap"}`;
      return op.label ? `applying ${op.label} to ${who}` : `applying a group save to ${who}`;
    }
    case "actor.saveDue":
      return op.state === "resolved" ? `accepting a failed save for ${target(op.target)}` : `dismissing a save for ${target(op.target)}`;
    case "actor.use":
      return usePhrase(op, before, target(op.target));
    case "actor.prompt":
      return `${op.state === "skipped" ? "skipping" : "reopening"} ${possessive(target(op.target))} ${promptName(op.what)}`;
    case "character.create":
      return `adding ${the("character", op.character.name)}`;
    case "character.update": {
      // A stat block edit names the block, which the DM's undo puts back with the two numbers it gave the actor.
      const name = before.characters[op.characterId]?.name;
      // A sync's patch never carries `at`, which the server writes, so a record with one, or none, is the dialog's Undo (docs/design/design-v1-resync.md 4).
      if (op.patch.ddbSync === null || op.patch.ddbSync?.at !== undefined) return `undoing ${quoted(name, "a character")}'s re-sync`;
      if (op.patch.ddbSync !== undefined) return `re-syncing ${quoted(name, "a character")} from D&D Beyond`;
      if (op.patch.stats === null) return `removing ${quoted(name, "a character")}'s stat block`;
      if (op.patch.stats !== undefined) return `changing ${quoted(name, "a character")}'s stat block`;
      if (op.patch.knownForms !== undefined) return `changing ${quoted(name, "a character")}'s known forms`;
      if (op.patch.resources !== undefined) return `changing ${quoted(name, "a character")}'s class resources`;
      return `changing ${the("character", name)}`;
    }
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
    // An ask applies nothing and goes on no stack: the gesture's own ops are its step.
    case "build.ask":
      return "asking before building";
    case "build.height":
      return op.height === 0 ? "clearing heights" : "painting heights";
    case "build.stairs":
      return op.up === null ? "clearing stairs" : "marking stairs";
    case "build.rough": {
      const count = op.cells?.length ?? 0;
      // The scene's own cell word: "3 hexes" on a hex scene (docs/design/design-v1-hex-grids.md section 8).
      const g = gridOfScene(before, op.sceneId);
      const cells = count === 1 ? `1 ${cellWord(g)}` : `${count} ${cellWord(g, true)}`;
      return op.on ? `marking ${cells} as difficult ground on ${scene(op.sceneId)}` : `clearing difficult ground from ${cells} on ${scene(op.sceneId)}`;
    }
    case "door.set":
      return doorPhrase(op, before);
    // The clock (docs/design/design-v1-calendar.md 6.5). A party's Long Rest is a gesture whose first op is its advance, which names the step.
    case "clock.start":
      return "starting the clock";
    case "clock.stop":
      return "stopping the clock";
    case "clock.update":
      if (op.calendar !== undefined) return "changing the calendar";
      if (op.at !== undefined) return "setting the date and time";
      // Before the switch's, which would otherwise name an update of dawn and dusk alone (docs/design/design-v1-calendar-c2c3.md 6.2).
      if (op.daylight !== undefined) return "changing dawn and dusk";
      return op.shown ? "turning on Players see the date and time" : "turning off Players see the date and time";
    case "clock.set":
      return "setting the date and time";
    case "clock.advance":
      return op.why === "longRest" ? "the party's Long Rest" : `moving the clock on ${spanText(op.by)}`;
    // Synced music and sound (docs/design/design-v1-music.md 6.6). Only the library's edits and the playlists are steps: an
    // upload, a delete and playback record none, so their phrases name them only for completeness.
    case "sound.update": {
      const was = ownEntry(before.sounds, op.id);
      const name = quoted(was?.name, "a sound");
      if (op.use !== undefined && op.use !== was?.use) return `using ${name} as ${USE_WORDS[op.use]}`;
      return `renaming ${name}`;
    }
    case "playlist.create":
      return `creating ${the("playlist", op.name)}`;
    case "playlist.update":
      return `changing ${the("playlist", ownEntry(before.playlists, op.id)?.name)}`;
    case "playlist.delete":
      return `deleting ${the("playlist", ownEntry(before.playlists, op.id)?.name)}`;
    // Add to playlist (docs/design/design-v1-music-player.md 6.3), the queue's one step.
    case "playlist.add":
      return `adding ${quoted(ownEntry(before.sounds, op.soundId)?.name, "a track")} to ${the("playlist", ownEntry(before.playlists, op.id)?.name)}`;
    case "sound.create":
      return `adding ${quoted(op.name, "a sound")}`;
    case "sound.delete":
      return `deleting ${quoted(ownEntry(before.sounds, op.id)?.name, "a sound")}`;
    case "music.play":
    case "music.pause":
    case "music.resume":
    case "music.skip":
    case "music.stop":
    case "music.set":
    case "music.queue":
    case "music.jump":
      return "changing the music";
    case "loop.start":
    case "loop.set":
    case "loop.stop":
      return "changing the background sounds";
    case "effect.fire":
      return "playing an effect";
    case "sound.mix":
      return "changing the volume for everyone";
    case "sound.scene":
      return `playing the sound of ${scene(op.sceneId)}`;
    case "sound.stopAll":
      return "stopping all sound";
    case "encounter.start":
      return "starting the fight";
    case "encounter.end":
      return "ending the fight";
    case "encounter.add":
      return "adding to Initiative";
    case "encounter.remove":
      return "removing from Initiative";
    case "encounter.setValue":
    case "encounter.setValues":
      return "setting Initiative";
    case "encounter.reorder":
      return "reordering Initiative";
    case "encounter.next":
      return "moving to the next turn";
    case "encounter.prev":
      return "going back a turn";
    case "encounter.update": {
      // In lair changes the creature's counts too (docs/design/design-v1-combat-controls.md 3.5).
      if (op.patch.inLair === undefined || Object.keys(op.patch).length !== 1) return "changing an Initiative entry";
      const row = before.encounter?.entries.find((e) => e.id === op.entryId);
      const who = row?.tokenId !== undefined ? token(row.tokenId) : row?.characterId !== undefined ? quoted(before.characters[row.characterId]?.name, "a character") : quoted(row?.label, "a creature");
      return op.patch.inLair ? `putting ${who} in its lair` : `taking ${who} out of its lair`;
    }
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
    // Traps (docs/design/design-v1-traps.md 6.5), by the name the trap had before the op.
    case "trap.create":
      return `making the trap ${op.trap.name}`;
    case "trap.update":
      return trapUpdatePhrase(op, trapName(before, op.trapId));
    case "trap.delete":
      return `deleting ${before.traps[op.trapId] ? `the trap ${trapName(before, op.trapId)}` : "a trap"}`;
    case "trap.spring":
      return `setting off ${trapName(before, op.trapId)}`;
    case "trap.act":
      return `doing what ${trapName(before, op.trapId)} does`;
    case "trap.settle":
      return op.sprung ? `marking ${trapName(before, op.trapId)} sprung` : `dismissing ${trapName(before, op.trapId)}`;
    case "roll.ask":
      return `asking for ${testText(op.request.test)}`;
    case "roll.answer":
      // Only the DM's answers go on a stack (design 7.7): a player answers again to change theirs.
      return op.total === undefined ? `marking the roll of ${target(op.target)}` : `entering the roll of ${target(op.target)}`;
    case "roll.reopen":
      return op.change === undefined ? `reopening the roll of ${target(op.target)}` : `letting ${target(op.target)} fix the total`;
    // On no stack (undo.ts records), named for completeness as a roll is.
    case "roll.change":
      return op.ask ? `asking to change the roll of ${target(op.target)}` : `settling the ask about the roll of ${target(op.target)}`;
    case "roll.close": {
      const first = op.rollIds.length === 1 ? before.rolls[op.rollIds[0]!] : undefined;
      if (first) return `closing the request for ${testText(first.test)}`;
      return op.rollIds.length === 1 ? "closing a roll request" : `closing ${op.rollIds.length} roll requests`;
    }
    // Neither goes on a stack (docs/design/design-v1-player-save-spell.md 5.6), but every op has a phrase.
    case "cast.ask":
      return `asking for saves against ${op.cast.spell}`;
    case "cast.close": {
      const spell = before.casts[op.castId]?.spell;
      const what = spell ? `the ask for saves against ${spell}` : "an ask for saves";
      return op.end === "dismissed" ? `setting aside ${what}` : op.end === "withdrawn" ? `withdrawing ${what}` : `resolving ${what}`;
    }
    // A roll is on no stack (docs/design/design-v1-dice.md 4.5): the stored op is the server's `sys.dice`.
    case "dice.roll":
      return "rolling dice";
    case "roll.dice":
      return `rolling for ${target(op.target)}`;
    case "actor.deathRoll":
      return `rolling a Death Save for ${target(op.target)}`;
    case "actor.rechargeRoll":
      return `rolling the recharge of ${quoted(op.name, "an ability")} for ${target(op.target)}`;
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
 * A group's conditions (docs/design/design-v1-dm-tools.md 3.5): "adding Frightened
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
  /** A group's conditions over 100 creatures, sent in batches (docs/design/design-v1-dm-tools.md 3.5): creature keys and effect names. */
  | { verb: "effects"; creatures: string[]; added: string[]; removed: string[] }
  /**
   * One scene's vision settings used on others (docs/design/design-v1-map-discovery.md
   * 8.3): the settings every op sends, the scenes it went to by id with their
   * names, and the scenes that could be the source by id with their names:
   * those with the settings before the step, that the copy did not go to.
   */
  | { verb: "copying"; patch: string; to: Record<string, string>; sources: Record<string, string> };

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
    // A selection over 100 tokens goes as several group ops under one undo group (docs/design/design-v1-dm-tools.md 3.5).
    case "token.updateMany":
      return { verb: "changing", tokenIds: op.tokenIds };
    case "token.deleteMany":
      return { verb: "deleting", tokenIds: op.tokenIds };
    case "actor.effects":
      return effectsTally(op, before);
    case "scene.update": {
      const copy = before ? copyTally(op, before) : undefined;
      if (copy) return copy;
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
  if (step.verb === "copying" || op.verb === "copying") {
    if (step.verb !== "copying" || op.verb !== "copying" || step.patch !== op.patch) return undefined;
    const to = { ...step.to, ...op.to };
    // Every op sends the same settings, so a later op's possible sources differ only by the scenes the step already went to, which are none.
    const sources = Object.fromEntries(Object.entries(step.sources).filter(([id]) => !(id in to)));
    return { verb: "copying", patch: step.patch, to, sources };
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
  if (tally.verb === "copying") {
    const names = Object.values(tally.to);
    const where = names.length === 1 ? the("scene", names[0]) : `${names.length} scenes`;
    const sources = Object.values(tally.sources);
    // Only one scene can be the source to be named: others with the same settings leave it unsure which one it was.
    return sources.length === 1 ? `using ${quoted(sources[0], "a scene")}'s vision settings on ${where}` : `copying vision settings to ${where}`;
  }
  // One creature is named by the op's own phrase, which knows its name.
  if (tally.verb === "effects") return tally.creatures.length > 1 ? effectsWords(tally, `${tally.creatures.length} creatures`) : undefined;
  return tally.tokenIds.length > 1 ? `${tally.verb} ${tally.tokenIds.length} tokens` : undefined;
}

/**
 * A copy of one scene's vision settings is the only patch that names fog,
 * party vision and Sight together, with nothing else (client/features/vision/copyRules.ts).
 * The op does not say which scene it copies, so every other scene that has
 * the settings before it is a possible source.
 */
function copyTally(op: OpOf<"scene.update">, before: RoomState): Tally | undefined {
  const { patch } = op;
  const vision = patch.vision;
  if (patch.fogEnabled === undefined || vision?.perPlayer === undefined || Object.keys(patch).length !== 2) return undefined;
  const target = before.scenes[op.sceneId];
  if (!target) return undefined;
  const sources: Record<string, string> = {};
  for (const s of Object.values(before.scenes)) {
    if (s.id === op.sceneId) continue;
    const same = s.fogEnabled === patch.fogEnabled && (s.vision?.on === true) === vision.on && (s.vision?.light ?? "bright") === vision.light && (s.vision?.perPlayer === true) === vision.perPlayer;
    if (same) sources[s.id] = s.name;
  }
  return { verb: "copying", patch: JSON.stringify([patch.fogEnabled, vision.on, vision.light, vision.perPlayer]), to: { [op.sceneId]: target.name }, sources };
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

/** A use as its undo phrase says it: "using Rain as background". */
const USE_WORDS = { music: "music", loop: "background", effect: "an effect" } as const;

/**
 * A scene's name, and on a floor of a scene with floors the floor's too,
 * "Tower · Upper floor", as the DM's place words name it
 * (docs/design/design-v1-floors.md 18.6), so a step on one floor never reads as
 * a step on another.
 */
function placeOf(state: RoomState, sceneId: string): string | undefined {
  const scene = state.scenes[sceneId];
  if (!scene?.floor) return scene?.name;
  const name = quoted(scene.name, "");
  return name ? `${name} · ${quoted(scene.floor.name, "a floor")}` : undefined;
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

/**
 * A use as its step names it (docs/design/design-v1-combat-controls.md 3.5): "using
 * Fiery Rays for Adult Red Dragon", "restoring Fire Breath for Young Red
 * Dragon", "Regeneration for Troll", "using Rage for Thorn".
 */
function usePhrase(op: OpOf<"actor.use">, before: RoomState, who: string): string {
  const use = op.use;
  if (use.kind === "regenerate") return `Regeneration for ${who}`;
  const name =
    use.kind === "legendary"
      ? quoted(use.name, "a Legendary Action")
      : use.kind === "resist"
        ? "Legendary Resistance"
        : use.kind === "ability"
          ? quoted(use.name, "an ability")
          : quoted(resourceOf(before, op.target, use.id)?.name, "a class resource");
  return op.back ? `restoring ${name} for ${who}` : `using ${name} for ${who}`;
}

function possessive(name: string): string {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

/** A turn's prompt as a step names it: "Regeneration", "death save", "recharge". */
function promptName(what: string): string {
  return what === "regeneration" ? "Regeneration" : what === "deathSave" ? "death save" : "recharge";
}

/** A character's class resource by id, its target a character or a token that plays one. */
function resourceOf(state: RoomState, target: ActorTarget, id: string) {
  const token = "tokenId" in target ? state.tokens[target.tokenId] : undefined;
  const characterId = "characterId" in target ? target.characterId : token && "ref" in token.actor ? token.actor.ref : undefined;
  return characterId === undefined ? undefined : state.characters[characterId]?.resources?.find((r) => r.id === id);
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
      return `giving ${name} Temporary HP`;
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

/**
 * A resize's new size as its step names it: "Large", or a Custom size's
 * squares, its width and height from the patch or the token. On a hex
 * scene a Custom size reads as its category (docs/design/design-v1-hex-grids.md
 * 4.2), so its step names that.
 */
function sizeWords(patch: TokenPatch, token: Token | undefined, grid: Grid): string {
  const named = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const size = patch.size ?? token?.size ?? "medium";
  if (size !== "custom") return named(size);
  const w = patch.w ?? token?.w ?? 1;
  const h = patch.h ?? token?.h ?? 1;
  if (grid.shape === "hex") return named(sizeCategory({ size, w, h }));
  return `${w} by ${h} squares`;
}

function trapName(state: RoomState, trapId: string): string {
  return state.traps[trapId]?.name ?? "a trap";
}

/** A trap change by what it changed: the Armed and Found switches have their own words, any other change is a change. */
function trapUpdatePhrase(op: Extract<ClientOp, { t: "trap.update" }>, name: string): string {
  const p = op.patch;
  const only = Object.keys(p).length === 1;
  if (only && p.state === "armed") return `arming ${name}`;
  if (only && p.state === "disarmed") return `disarming ${name}`;
  if (only && p.state === "sprung") return `marking ${name} sprung`;
  if (only && p.found !== undefined) return p.found ? `marking ${name} found` : `hiding ${name} again`;
  return `changing ${name}`;
}
