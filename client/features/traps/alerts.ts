import type { LogEntry, RoomState, TrapSound, Viewer } from "#shared/model.ts";
import { compareLogIds } from "#shared/keys.ts";
import { describeEvent, type LogNames } from "#shared/logText.ts";
import { ownsToken } from "#shared/project.ts";
import { isPoseOp, type ClientOp } from "#shared/protocol.ts";

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

/** A toast: its words, the sound it plays, and for the DM the trap and springing it names, or the hint (`notice`), which offers Mark found. */
export type TrapAlert = { text: string; sound?: TrapSound; trapId?: string; due?: string; notice?: true };

/**
 * The DM's toasts (4.3): "Hidden Pit went off: Thorn.", and the trap's
 * sound. One that went off out of the players' sight in a player's op says
 * so. The DM's own Set it off needs none: its card, if any, is already on
 * the desk. The Passive Perception hint (4.6) is a toast too.
 */
export function dmAlerts(lines: readonly LogEntry[], state: RoomState): TrapAlert[] {
  const out: TrapAlert[] = [];
  for (const e of lines) {
    const data = e.data;
    if (data?.type === "trapNotice") {
      out.push({ text: describeEvent(data, namesOf(state), true), trapId: data.trapId, notice: true });
      continue;
    }
    if (data?.type !== "trap" || data.how === "hand") continue;
    const text = describeEvent(data, namesOf(state), true);
    const sound = state.traps[data.trapId]?.rig?.sound;
    out.push({ text: data.hidden ? `${text} The players saw nothing.` : text, ...(sound ? { sound } : {}), trapId: data.trapId, due: e.id });
  }
  return out;
}

/** A player's toasts (4.3): each players' line that names a creature they play, with its sound. Everyone else reads it in the log. */
export function playerAlerts(lines: readonly LogEntry[], state: RoomState, viewer: Viewer): TrapAlert[] {
  const out: TrapAlert[] = [];
  for (const e of lines) {
    const data = e.data;
    if (data?.type !== "trapSeen") continue;
    const plays = data.by.some((id) => {
      const token = state.tokens[id];
      return token !== undefined && ownsToken(state, viewer, token);
    });
    if (!plays) continue;
    out.push({ text: describeEvent(data, namesOf(state)), ...(data.sound ? { sound: data.sound } : {}) });
  }
  return out;
}

function namesOf(state: RoomState): LogNames {
  return { members: state.members, tokens: state.tokens, characters: state.characters, handouts: state.handouts, encounter: state.encounter, traps: state.traps };
}

/** A player's move this device sent, watched until its answer: where it asked its tokens to land, and the players' trap log when it went. */
/** A move of the player's the bar may offer to take back (4.3), watched until the server answers it. */
export type Watched = { n: number };

export function watchOf(op: ClientOp, n: number): Watched | null {
  return isPoseOp(op) ? { n } : null;
}

/**
 * Whether a trap met the move in a way the player sees (4.3): the server's
 * ack marks the op (`ev.trapped`) by the same rule its undo refuses by
 * (shared/reducer/trapStep.ts blocksUndo). Then the server refuses to take
 * it back, so the bar stops offering Undo move and Teleport here.
 */
export function metTrap(w: Watched, trapped: readonly number[] | undefined): boolean {
  return trapped?.includes(w.n) ?? false;
}
