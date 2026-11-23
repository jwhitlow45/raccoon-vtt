import type { BuildChunk, Fall, LogEntry, LogEvent, RoomState, Token, Trap, TrapAction, TrapDue } from "#shared/model.ts";
import { compareLogIds } from "#shared/keys.ts";
import { ownEntry } from "#shared/records.ts";
import { byFallAge } from "#shared/rules/fallCards.ts";
import { fallDice, floorBelow } from "#shared/rules/floorLinks.ts";
import { sameScene } from "#shared/rules/floors.ts";
import { displayName } from "../../lib/scene.ts";
import { holderOf } from "../dice/targets.ts";
import { findDoor } from "../doors/doors.ts";
import type { Labels } from "../../lib/labels.ts";
import { floorWord } from "./rules.ts";

/*
 * What a trap going off shows the DM (docs/design/design-v1-traps.md 4.3), as
 * plain functions for node --test: a card on the DM desk for each
 * springing still waiting, newest first, and the lines it reads.
 */

export type DeskTrap = { trap: Trap; due: TrapDue };

/** Every springing waiting for the DM on the scene in view, newest first. The DM receives the traps of that scene alone. */
export function deskTraps(traps: Readonly<Record<string, Trap | undefined>>): DeskTrap[] {
  const out: DeskTrap[] = [];
  for (const trap of Object.values(traps)) for (const due of trap?.rig?.due ?? []) out.push({ trap: trap!, due });
  return out.sort((a, b) => compareLogIds(b.due.id, a.due.id) || (a.trap.id < b.trap.id ? -1 : 1));
}

type Names = Pick<RoomState, "tokens">;

function nameOf(names: Names, id: string, labels: Labels): string {
  const token = names.tokens[id];
  return token ? displayName(token, labels) : "a creature";
}

/** "Thorn", "Thorn and Bree", "Thorn, Bree and 2 more", and "51 creatures" where it names none. */
export function nameList(names: Names, ids: readonly string[], labels: Labels, more = 0): string {
  if (ids.length === 0 && more > 0) return more === 1 ? "1 creature" : `${more} creatures`;
  const parts = ids.map((id) => nameOf(names, id, labels));
  if (more > 0) parts.push(`${more} more`);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The card's lines on who: who set it off and who it hits (5.6, frozen when it went off). */
export function whoLines(names: Names, due: TrapDue, labels: Labels): { by: string; hits: string } {
  const by = nameList(names, due.by, labels, due.more ?? 0);
  const hits = nameList(names, due.hits, labels, due.hitsMore ?? 0);
  const set = due.how === "hand" ? (by ? `You set it off for ${by}.` : "You set it off.") : by ? `${by} set it off.` : "It went off.";
  return { by: set, hits: hits ? `It hits ${hits}.` : "It hits no one." };
}

/** A hidden springing's line (5.5): "Imp set it off, out of the players' sight. The trap is still armed for them." */
export function hiddenLine(names: Names, due: TrapDue, labels: Labels): string {
  const by = nameList(names, due.by, labels, due.more ?? 0) || "A creature";
  return `${by} set it off, out of the players' sight. The trap is still armed for them.`;
}

/** The DM's line of a springing, by its occurrence's id, while the DM's trap log still holds it. */
export function lineOf(trapLog: readonly LogEntry[], dueId: string): Extract<LogEvent, { type: "trap" }> | null {
  const data = trapLog.find((e) => e.id === dueId)?.data;
  return data?.type === "trap" ? data : null;
}

const DOOR_DONE: Record<"open" | "closed" | "locked", [string, string]> = { open: ["Opened", "open"], closed: ["Closed", "close"], locked: ["Locked", "lock"] };

/**
 * What it did and could not do (4.3), one line each in the trap's order:
 * "Closed a door.", "Could not show a creature: it was deleted." Read from
 * the DM's line, whose outcomes name the actions by their place in the
 * list, and the pit as -1. A trapdoor's opening is that -1 too
 * (docs/design/design-v1-floors.md phase 4, 4.6), and drops what stood on
 * it to the floor below, so it names that floor.
 */
export function didLines(trap: Trap, did: readonly { action: number; ok: boolean }[], view: Pick<RoomState, "tokens" | "lights" | "stamps" | "scenes"> & { buildChunks: Readonly<Record<string, BuildChunk>> }, labels: Labels): string[] {
  const actions = trap.rig?.actions ?? [];
  return did.map(({ action, ok }) => {
    if (action === -1 && trap.rig?.below === true) return trapdoorLine(trap, ok, view);
    if (action === -1) return ok ? "Opened the pit." : `Could not open the pit: ${pitOutside(trap, view) ? "some of its squares lie outside the scene" : "the scene is at its wall limit"}.`;
    const a = actions[action];
    if (!a) return ok ? "Did something it no longer lists." : "Could not do something it no longer lists.";
    return actionLine(a, ok, view, trap.sceneId, labels);
  });
}

/**
 * A trapdoor's line: "Opened the trapdoor onto Ground floor.", or where
 * its floor has none below, as after Remove floor, "Could not open the
 * trapdoor: there is no floor below Cellar.", the pane's words for it.
 */
function trapdoorLine(trap: Trap, ok: boolean, view: Pick<RoomState, "scenes">): string {
  const below = floorBelow(view, trap.sceneId);
  if (ok) return `Opened the trapdoor onto ${below?.floor?.name ?? "the floor below"}.`;
  return below === undefined ? `Could not open the trapdoor: there is no floor below ${floorWord(view, trap.sceneId)}.` : "Could not open the trapdoor.";
}

/** Whether a squares trap reaches past its scene's edge, as a scene made smaller leaves it: the one other reason a pit cannot open. */
function pitOutside(trap: Trap, view: Pick<RoomState, "scenes">): boolean {
  const bounds = view.scenes[trap.sceneId]?.bounds;
  if (!bounds || !("cells" in trap.zone)) return true;
  return trap.zone.cells.some((r) => r.x + r.w > bounds.w || r.y + r.h > bounds.h);
}

function actionLine(a: TrapAction, ok: boolean, view: Pick<RoomState, "tokens" | "lights" | "stamps"> & { buildChunks: Readonly<Record<string, BuildChunk>> }, sceneId: string, labels: Labels): string {
  if ("door" in a) {
    const [done, verb] = DOOR_DONE[a.state];
    return ok ? `${done} a door.` : `Could not ${verb} a door: ${findDoor(view.buildChunks, sceneId, a.door) ? "it would not change" : "it was removed"}.`;
  }
  if ("light" in a) {
    const light = view.lights[a.light];
    const name = light?.label ?? "a light";
    if (ok) return a.on ? `Lit ${name}.` : `Put out ${name}.`;
    return `Could not ${a.on ? "light" : "put out"} ${name}: it was ${light ? "moved to another scene" : "deleted"}.`;
  }
  if ("tokenId" in a.show) {
    const token: Token | undefined = view.tokens[a.show.tokenId];
    const name = token ? displayName(token, labels) : "a creature";
    return ok ? `Showed ${name}.` : `Could not show ${name}: it was ${token ? "moved to another scene" : "deleted"}.`;
  }
  const stamp = view.stamps[a.show.stampId];
  return ok ? "Showed a stamp." : `Could not show a stamp: it was ${stamp ? "moved to another scene" : "deleted"}.`;
}

/** The desk's folded button with trap cards among what it folds: "Rolls 1/3, 1 trap", or "2 traps" alone. Its name starts with its text. */
export function foldedWithTraps(base: { text: string; label: string } | null, traps: number, tap: "sheet" | "more" | "less"): { text: string; label: string } | null {
  if (traps === 0) return base;
  const count = `${traps} ${traps === 1 ? "trap" : "traps"}`;
  const more = tap === "sheet" ? "" : "more ";
  const went = `${traps} ${more}${traps === 1 ? "trap" : "traps"} went off`;
  if (!base) return { text: count, label: `${count}: ${went}.${tap === "sheet" ? ` Close the sheet to see ${traps === 1 ? "it" : "them"}.` : ""}` };
  const cut = base.label.indexOf(": ");
  const head = cut >= 0 ? base.label.slice(0, cut) : base.label;
  const rest = cut >= 0 ? base.label.slice(cut + 2) : "";
  return { text: `${count}, ${base.text}`, label: `${count}, ${head}: ${went}, ${rest}` };
}

// Fall cards (docs/design/design-v1-floors.md phase 4, 4.4).

/** The fall cards waiting for the DM, newest first: by the op each was made in, then its place among that op's cards. */
export function deskFalls(falls: Readonly<Record<string, Fall | undefined>> | undefined): Fall[] {
  return Object.values(falls ?? {})
    .filter((card): card is Fall => card !== undefined)
    .sort((a, b) => byFallAge(b, a));
}

/**
 * How the DM's copy reads a card: `here` where it holds the creature,
 * `elsewhere` where the creature landed on another scene, whose tokens the
 * copy does not hold until the DM goes there, and `gone` where it landed on
 * the scene shown and is not on it now: moved to another scene, where the
 * card reads `here` again, or off the map, as after a player dismissed
 * their companion (4.4), which leaves its card for the DM.
 */
export type FallRead = {
  kind: "here" | "elsewhere" | "gone";
  name: string | null;
  /** The creatures it names that the copy holds, the one that fell first: Apply's rows. */
  tokenIds: string[];
  dice: number;
  line: string;
  /** The card's name as a region: "Fall: Thorn". */
  region: string;
  /** Its buttons' names end with it: "Dismiss Thorn's fall". */
  whose: string;
};

/** The landing floor's name, "Ground floor". */
function landedOn(view: Pick<RoomState, "scenes">, card: Fall): string {
  const scene = ownEntry(view.scenes, card.sceneId);
  return scene?.floor?.name ?? scene?.name ?? "another floor";
}

/** The most names a fall's words list before "and 2 more". */
const FALL_NAMES_SHOWN = 3;

/**
 * The creatures a card names that the copy holds (D-261120-007): the one
 * that fell, then the riders that fell with it, so a rider whose mount has
 * gone since still takes the fall.
 */
export function fallers(view: Pick<RoomState, "tokens">, card: Fall): string[] {
  return [card.tokenId, ...(card.riders ?? [])].filter((id) => ownEntry(view.tokens, id) !== undefined);
}

/** Whose creature a token is: its character's, shared by every token of it, else its own. */
export function holderIdOf(view: Pick<RoomState, "tokens">, id: string): string {
  const token = ownEntry(view.tokens, id);
  return token ? holderOf(token) : `token:${id}`;
}

/**
 * The first token of each holder, which is all a card's words name: a
 * character shown by two tokens, one riding and one carried, is one
 * creature that fell once (LP47B-FALL-1). Apply still takes every token.
 */
export function fallNamed(view: Pick<RoomState, "tokens">, ids: readonly string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    const holder = holderIdOf(view, id);
    if (seen.has(holder)) return false;
    seen.add(holder);
    return true;
  });
}

/** "Thorn", "Horse and Thorn", "Horse, Thorn, Bree and 2 more". */
export function fallNames(view: Pick<RoomState, "tokens">, ids: readonly string[], labels: Labels): string {
  return nameList(view, ids.slice(0, FALL_NAMES_SHOWN), labels, Math.max(0, ids.length - FALL_NAMES_SHOWN));
}

/** The most creatures' names a device keeps for fall cards whose creature left the scene shown: a room's cards name at most 10 times 20. */
const FALL_NAMES_KEPT = 200;

/**
 * The names a device last read off the creatures its fall cards name, so a
 * card whose creature left the scene shown, as one the DM moved to another
 * scene, still names it (LP46A-FALL-2). The DM's copy holds the shown
 * scene's tokens alone and no room-wide list of where each one is, so
 * nothing else names it, and after a reload such a card reads "A creature".
 */
export type FallNames = Map<string, { name: string; holder: string }>;

function keepName(known: FallNames, id: string, name: string, holder: string): void {
  known.delete(id);
  known.set(id, { name, holder });
  if (known.size > FALL_NAMES_KEPT) known.delete(known.keys().next().value!);
}

/** "Giant", "Horse and Thorn": a gone card's names as `known` last read them, a holder named once as the card names it while its tokens are on the scene. */
function knownNames(known: FallNames | undefined, ids: readonly string[]): { name: string; count: number } | null {
  const seen = new Set<string>();
  const names = ids.flatMap((id) => {
    const entry = known?.get(id);
    if (entry === undefined || seen.has(entry.holder)) return [];
    seen.add(entry.holder);
    return [entry.name];
  });
  if (names.length === 0) return null;
  const shown = names.slice(0, FALL_NAMES_SHOWN);
  if (names.length > FALL_NAMES_SHOWN) shown.push(`${names.length - FALL_NAMES_SHOWN} more`);
  return { name: shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`, count: names.length };
}

/**
 * The card's line (4.4): "Thorn fell 10 ft to Ground floor: 1d6
 * Bludgeoning, Prone.", with riders "Horse and Thorn fell 10 ft to Ground
 * floor: each 1d6 Bludgeoning, Prone.", under 10 ft "Thorn fell 5 ft to
 * Ground floor: no damage.", "A creature fell 10 ft to Ground floor on
 * Tower." for another scene, and "Giant fell 10 ft to Ground floor and is
 * not on this scene now." for one whose creature left the scene shown,
 * moved to another or gone, by the name `known` last read, else "A
 * creature". No name is stored on the card, so each is read off its
 * creature.
 */
export function fallRead(view: Pick<RoomState, "scenes" | "tokens">, card: Fall, shown: string | null, labels: Labels, known?: FallNames): FallRead {
  const floor = landedOn(view, card);
  const tokenIds = fallers(view, card);
  if (tokenIds.length > 0) {
    if (known) for (const id of tokenIds) keepName(known, id, nameOf(view, id, labels), holderIdOf(view, id));
    const named = fallNamed(view, tokenIds);
    const name = fallNames(view, named, labels);
    const dice = fallDice(card.ft);
    const hurt = dice > 0 ? `${named.length > 1 ? "each " : ""}${dice}d6 Bludgeoning, Prone` : "no damage";
    return { kind: "here", name, tokenIds, dice, line: `${name} fell ${card.ft} ft to ${floor}: ${hurt}.`, region: `Fall: ${name}`, whose: `${name}'s fall` };
  }
  const here = shown !== null && sameScene(view, card.sceneId, shown);
  if (here) {
    // A DM's delete takes the card with its creatures (dropGoneCards), so most such cards' creatures were moved to another scene, where Apply works.
    const left = knownNames(known, [card.tokenId, ...(card.riders ?? [])]);
    const who = left ? `${left.name} fell ${card.ft} ft to ${floor} and ${left.count > 1 ? "are" : "is"}` : `A creature fell ${card.ft} ft to ${floor} and is`;
    return { kind: "gone", name: left?.name ?? null, tokenIds, dice: 0, line: `${who} not on this scene now.`, region: `Fall: ${left?.name ?? "a creature"}`, whose: left ? `${left.name}'s fall` : "this fall" };
  }
  const scene = ownEntry(view.scenes, card.sceneId)?.name.trim();
  return { kind: "elsewhere", name: null, tokenIds, dice: 0, line: `A creature fell ${card.ft} ft to ${floor} ${scene ? `on ${scene}` : "on another scene"}.`, region: "Fall: a creature", whose: "this fall" };
}

/** The desk's folded button with fall cards among what it folds, as with traps: "1 fall, Rolls 1/3", or "2 falls" alone. Its name starts with its text. */
export function foldedWithFalls(base: { text: string; label: string } | null, falls: number, tap: "sheet" | "more" | "less"): { text: string; label: string } | null {
  if (falls === 0) return base;
  const count = `${falls} ${falls === 1 ? "fall" : "falls"}`;
  const more = tap === "sheet" ? "" : "more ";
  const fell = `${falls} ${more}${falls === 1 ? "creature" : "creatures"} fell`;
  if (!base) return { text: count, label: `${count}: ${fell}.${tap === "sheet" ? ` Close the sheet to see ${falls === 1 ? "it" : "them"}.` : ""}` };
  const cut = base.label.indexOf(": ");
  const head = cut >= 0 ? base.label.slice(0, cut) : base.label;
  const rest = cut >= 0 ? base.label.slice(cut + 2) : "";
  return { text: `${count}, ${base.text}`, label: `${count}, ${head}: ${fell}, ${rest}` };
}
