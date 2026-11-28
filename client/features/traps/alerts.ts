import type { Fall, LogEntry, RoomState, TrapSound, Viewer } from "#shared/model.ts";
import { compareLogIds } from "#shared/keys.ts";
import { describeEvent, type LogNames } from "#shared/logText.ts";
import { isPoseOp, type ClientOp } from "#shared/protocol.ts";
import { ownsToken } from "../tokens/access.ts";
import type { Labels } from "../../lib/labels.ts";
import { LIMITS } from "#shared/limits.ts";
import { ownEntry } from "#shared/records.ts";
import { sameScene } from "#shared/rules/floors.ts";
import { byFallAge } from "#shared/rules/fallCards.ts";
import type { ProjectedFall } from "#shared/project.ts";
import { fallers, fallNamed, fallNames, fallRead, holderIdOf, KNOWN } from "./desk.ts";
import { placeName } from "../floors/words.ts";

/*
 * What a trap going off tells each device (docs/design/design-v1-traps.md 4.3),
 * as plain functions for node --test: the DM's toast and sound for each new
 * line in the DM's trap log, a player's for each new players' line naming
 * a creature they play, and whether a player's move met a trap, which ends
 * the bar's offer to take it back.
 */

/** The lines newer than `after`, oldest first. */
export function linesAfter(lines: readonly LogEntry[], after: string | null): LogEntry[] {
  return after === null ? [...lines] : lines.filter((e) => compareLogIds(e.id, after) > 0);
}

export function newestId(lines: readonly LogEntry[]): string | null {
  return lines[lines.length - 1]?.id ?? null;
}

/**
 * A toast: its words, the sound it plays, and for the DM the trap and
 * springing it names, or the hint (`notice`), which offers Mark found. A
 * toast for a trap on a scene the DM is not viewing names the scene and
 * goes there (`show`), since the DM holds neither that trap nor its
 * creatures until then.
 */
export type TrapAlert = { text: string; sound?: TrapSound; trapId?: string; due?: string; notice?: true; show?: { sceneId: string; line: string } };

/**
 * The DM's toasts (4.3): "Hidden Pit went off: Thorn.", and the trap's
 * sound. One that went off out of the players' sight in a player's op says
 * so. The DM's own Set it off needs none: its card, if any, is already on
 * the desk. The Passive Perception hint (4.6) is a toast too. A trap on
 * another scene than `viewing` reads "Hidden Pit went off on Crypt." with
 * its sound, since the line keeps them, and Show. On a scene with floors it
 * names the floor (sceneWords).
 */
export function dmAlerts(lines: readonly LogEntry[], state: RoomState, viewing: string | null): TrapAlert[] {
  const out: TrapAlert[] = [];
  for (const e of lines) {
    const data = e.data;
    if (data?.type === "trapNotice") {
      if (data.sceneId !== viewing) {
        out.push({ text: `A creature's Passive Perception (${data.passive}) would notice a trap ${sceneWords(state, data.sceneId, viewing)} (DC ${data.dc}).`, trapId: data.trapId, notice: true, ...showOf(state, data.sceneId, e.id) });
        continue;
      }
      out.push({ text: describeEvent(data, namesOf(state), true), trapId: data.trapId, notice: true });
      continue;
    }
    if (data?.type !== "trap" || data.how === "hand") continue;
    const sound = data.sound ? { sound: data.sound } : {};
    const unseen = data.hidden ? " The players saw nothing." : "";
    if (data.sceneId !== viewing) {
      out.push({ text: `${data.name} went off ${sceneWords(state, data.sceneId, viewing)}.${unseen}`, ...sound, trapId: data.trapId, due: e.id, ...showOf(state, data.sceneId, e.id) });
      continue;
    }
    out.push({ text: `${describeEvent(data, namesOf(state), true)}${unseen}`, ...sound, trapId: data.trapId, due: e.id });
  }
  return out;
}

/**
 * The newest card's `made` among the DM's fall cards (docs/design/design-v1-floors.md
 * phase 4, 4.4), or -1 with none: what a device held when it loaded, so a
 * later card is new and a reconnect, which brings the same cards back,
 * toasts nothing old.
 */
export function newestMade(falls: Readonly<Record<string, Fall | undefined>> | undefined): number {
  let most = -1;
  for (const card of Object.values(falls ?? {})) if (card && card.made > most) most = card.made;
  return most;
}

/** The fall cards made after `after`, oldest first, so their toasts come in the order they fell. */
export function fallsAfter(falls: Readonly<Record<string, Fall | undefined>> | undefined, after: number): Fall[] {
  return Object.values(falls ?? {})
    .filter((card): card is Fall => card !== undefined && card.made > after)
    .sort(byFallAge);
}

/** A fall's toast for the DM: its words, and Show where the floor it names is not the one shown. */
export type FallAlert = { text: string; show?: { sceneId: string } };

/**
 * The DM's toasts for new fall cards (4.4): "Thorn fell 10 ft to Ground
 * floor.", "Horse and Thorn fell 10 ft to Ground floor." with riders, with
 * Show where that floor is not the one shown, and "Thorn fell 10 ft to
 * Ground floor on Tower." with Show for another scene, whose creatures the
 * DM's copy does not hold, named as the DM's fall card names them (the
 * card's `away`, then KNOWN, else "A creature"). No name is stored on the
 * card, so each is read off the creature the copy holds. One op that drops more than
 * FALL_TOASTS_MOST cards, as an opening placed under a crowd, toasts once
 * for them all: "4 creatures fell to Ground floor.", "10 or more creatures
 * fell to Ground floor." once its cards fill the room (LP46A polish).
 */
export function fallAlerts(cards: readonly ProjectedFall[], state: Pick<RoomState, "scenes" | "tokens">, viewing: string | null, labels: Labels): FallAlert[] {
  const byOp = new Map<number, Fall[]>();
  for (const card of cards) byOp.set(card.made, [...(byOp.get(card.made) ?? []), card]);
  return [...byOp.values()].flatMap((op) => (op.length > FALL_TOASTS_MOST ? [crowdAlert(op, state, viewing)] : eachAlert(op, state, viewing, labels)));
}

/** The most fall cards one op toasts one by one. */
export const FALL_TOASTS_MOST = 3;

function crowdAlert(cards: readonly Fall[], state: Pick<RoomState, "scenes" | "tokens">, viewing: string | null): FallAlert {
  // A character shown by two tokens is one creature, as a card names it (fallNamed), and a token the copy no longer holds counts for itself.
  const creatures = new Set(cards.flatMap((card) => [card.tokenId, ...(card.riders ?? [])]).map((id) => holderIdOf(state, id))).size;
  // A new card past the room's cap drops the oldest in the same op (writeCard), so an op whose cards fill the room may have made more.
  const count = cards.length >= LIMITS.fallsPerRoom ? `${creatures} or more creatures` : `${creatures} ${creatures === 1 ? "creature" : "creatures"}`;
  const sceneId = cards[0]!.sceneId;
  if (!cards.every((card) => card.sceneId === sceneId)) return { text: `${count} fell to the floors below.` };
  const scene = ownEntry(state.scenes, sceneId);
  if (!scene) return { text: `${count} fell to another floor.` };
  // Another scene's floor is named with its scene, as each creature's toast names it.
  const away = scene.floor !== undefined && scene.name.trim() !== "" && (viewing === null || !sameScene(state, sceneId, viewing)) ? ` on ${scene.name.trim()}` : "";
  return { text: `${count} fell to ${scene.floor?.name ?? scene.name}${away}.`, ...(sceneId !== viewing ? { show: { sceneId } } : {}) };
}

function eachAlert(cards: readonly ProjectedFall[], state: Pick<RoomState, "scenes" | "tokens">, viewing: string | null, labels: Labels): FallAlert[] {
  return cards.map((card) => {
    const scene = ownEntry(state.scenes, card.sceneId);
    const floor = scene?.floor?.name ?? scene?.name ?? "another floor";
    const ids = fallers(state, card);
    const show = scene && card.sceneId !== viewing ? { show: { sceneId: card.sceneId } } : {};
    if (ids.length > 0) return { text: `${fallNames(state, fallNamed(state, ids), labels)} fell ${card.ft} ft to ${floor}.`, ...show };
    // The copy holds every floor of the scene shown, so a creature missing from it is no longer on the map there.
    if (viewing !== null && sameScene(state, card.sceneId, viewing)) return { text: `A creature no longer on the map fell ${card.ft} ft to ${floor}.` };
    // Named as the DM's fall card names it: by the card's `away` word for the creature, else the device's memory (KNOWN), else "A creature".
    return { text: fallRead(state, card, viewing, labels, KNOWN).line, ...show };
  });
}

/** The toast the DM gets once Show brought them to the trap's scene: the line read again, with the creatures' names. */
export function shownAlert(line: LogEntry, state: RoomState, viewing: string | null): TrapAlert | null {
  const alert = dmAlerts([line], state, viewing)[0];
  if (!alert || alert.show !== undefined) return null;
  const { sound: _sound, ...rest } = alert;
  return rest;
}

/**
 * Where a trap went off, as the floors UI names a place (docs/design/design-v1-floors.md
 * 18.6): "on Upper floor" from another floor of the same scene, "on Crypt · Upper floor"
 * for a floor of another scene, "on Crypt" for a scene with no floors, and "on another
 * scene" for one since deleted or with no name.
 */
function sceneWords(state: RoomState, sceneId: string, viewing: string | null): string {
  const scene = ownEntry(state.scenes, sceneId);
  const name = scene?.name.trim();
  if (!scene || !name) return "on another scene";
  if (!scene.floor) return `on ${name}`;
  return viewing !== null && sameScene(state, sceneId, viewing) ? `on ${scene.floor.name}` : `on ${placeName(state, sceneId)}`;
}

function showOf(state: RoomState, sceneId: string, line: string): Pick<TrapAlert, "show"> {
  return state.scenes[sceneId] ? { show: { sceneId, line } } : {};
}

/** A player's toasts (4.3): each players' line that names a creature they play, with its sound. Everyone else reads it in the log. */
export function playerAlerts(lines: readonly LogEntry[], state: RoomState, viewer: Viewer): TrapAlert[] {
  const out: TrapAlert[] = [];
  for (const e of lines) {
    const data = e.data;
    if (data?.type !== "trapSeen") continue;
    // A player's copy holds `ownerIds` only on what they own, so this reads ownership as the client does.
    const plays = data.by.some((id) => {
      const token = state.tokens[id];
      return token !== undefined && ownsToken(state, viewer.memberId, token);
    });
    if (!plays) continue;
    out.push({ text: describeEvent(data, namesOf(state)), ...(data.sound ? { sound: data.sound } : {}) });
  }
  return out;
}

function namesOf(state: RoomState): LogNames {
  return { members: state.members, tokens: state.tokens, characters: state.characters, handouts: state.handouts, encounter: state.encounter, traps: state.traps };
}

/** A move of the player's the bar may offer to take back (4.3), watched until the server answers it. */
export type Watched = { n: number };

export function watchOf(op: ClientOp, n: number): Watched | null {
  return isPoseOp(op) ? { n } : null;
}

/**
 * Whether a trap met the move in a way the player sees (4.3): the server's
 * ack marks the op (`ev.trapped`) by the same rule its undo refuses by
 * (shared/reducer.ts playerSeesChange). Then the server refuses to take it
 * back, so the bar stops offering Undo move and Teleport here.
 */
export function metTrap(w: Watched, trapped: readonly number[] | undefined): boolean {
  return trapped?.includes(w.n) ?? false;
}

/**
 * The bar's Undo move offers once the server marked move `n` as met by a
 * trap: that move's offer goes, and every older one with it. The server
 * keeps the trapped step on its stack, under any newer move, until an undo
 * of it is refused, so an older offer could only be answered "no longer
 * your newest change".
 */
export function offersAfterTrap<T extends { ns: readonly number[] }>(offers: readonly T[], n: number): readonly T[] {
  const at = offers.findIndex((o) => o.ns.includes(n));
  return at < 0 ? offers : offers.slice(at + 1);
}

/** What the watch reads of the room's store (state/store.ts): the ops still on their way, and the server's answers to those that came back. */
export type MoveAnswers = { pending: readonly { n: number; op: ClientOp }[]; refused?: readonly number[]; trapped?: readonly number[] };

/**
 * A player's moves watched until the server answers them (4.3), as
 * useTrapAlerts runs it on every change of the room's store, kept free of
 * React so it is tested under Node. It starts from the ops on their way
 * when the room opened, which it never watches. Once the answer to a
 * watched move shows a trap met it, the bar's Undo move offers that move's
 * and every older one's go (`offersAfterTrap`), and the stopped walk's
 * note for it goes with its Teleport here, unless that teleport is on its
 * way. A refused move is left alone.
 */
export function trapMoveWatch<O extends { ns: readonly number[] }>(
  start: MoveAnswers,
  offers: { getState(): { offers: readonly O[] }; setState(patch: { offers: readonly O[] }): void },
  notes: { getState(): { note: { n: number | null } | null; busy: boolean }; setState(patch: { note: null }): void },
): (now: MoveAnswers) => void {
  let lastN = start.pending.reduce((n, p) => Math.max(n, p.n), 0);
  const watched = new Map<number, Watched>();
  return (now) => {
    for (const p of now.pending) {
      if (p.n <= lastN) continue;
      lastN = p.n;
      const w = watchOf(p.op, p.n);
      if (w) watched.set(p.n, w);
    }
    for (const [n, w] of watched) {
      if (now.pending.some((p) => p.n === n)) continue;
      watched.delete(n);
      if ((now.refused ?? []).includes(n) || !metTrap(w, now.trapped)) continue;
      const was = offers.getState().offers;
      const kept = offersAfterTrap(was, n);
      if (kept.length !== was.length) offers.setState({ offers: kept });
      const s = notes.getState();
      if (s.note?.n === n && !s.busy) notes.setState({ note: null });
    }
  };
}
