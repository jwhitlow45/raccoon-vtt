import type { LogEntry, RoomState, TrapSound, Viewer } from "#shared/model.ts";
import { compareLogIds } from "#shared/keys.ts";
import { describeEvent, type LogNames } from "#shared/logText.ts";
import { isPoseOp, type ClientOp } from "#shared/protocol.ts";
import { ownsToken } from "../tokens/access.ts";

/*
 * What a trap going off tells each device (docs/design-v1-traps.md 4.3),
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
 * its sound, since the line keeps them, and Show.
 */
export function dmAlerts(lines: readonly LogEntry[], state: RoomState, viewing: string | null): TrapAlert[] {
  const out: TrapAlert[] = [];
  for (const e of lines) {
    const data = e.data;
    if (data?.type === "trapNotice") {
      if (data.sceneId !== viewing) {
        out.push({ text: `A creature's Passive Perception (${data.passive}) would notice a trap ${sceneWords(state, data.sceneId)} (DC ${data.dc}).`, trapId: data.trapId, notice: true, ...showOf(state, data.sceneId, e.id) });
        continue;
      }
      out.push({ text: describeEvent(data, namesOf(state), true), trapId: data.trapId, notice: true });
      continue;
    }
    if (data?.type !== "trap" || data.how === "hand") continue;
    const sound = data.sound ? { sound: data.sound } : {};
    const unseen = data.hidden ? " The players saw nothing." : "";
    if (data.sceneId !== viewing) {
      out.push({ text: `${data.name} went off ${sceneWords(state, data.sceneId)}.${unseen}`, ...sound, trapId: data.trapId, due: e.id, ...showOf(state, data.sceneId, e.id) });
      continue;
    }
    out.push({ text: `${describeEvent(data, namesOf(state), true)}${unseen}`, ...sound, trapId: data.trapId, due: e.id });
  }
  return out;
}

/** The toast the DM gets once Show brought them to the trap's scene: the line read again, with the creatures' names. */
export function shownAlert(line: LogEntry, state: RoomState, viewing: string | null): TrapAlert | null {
  const alert = dmAlerts([line], state, viewing)[0];
  if (!alert || alert.show !== undefined) return null;
  const { sound: _sound, ...rest } = alert;
  return rest;
}

function sceneWords(state: RoomState, sceneId: string): string {
  const name = state.scenes[sceneId]?.name.trim();
  return name ? `on ${name}` : "on another scene";
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
