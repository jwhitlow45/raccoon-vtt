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

export type TrapAlert = { text: string; sound?: TrapSound; trapId?: string; due?: string };

/**
 * The DM's toasts (4.3): "Hidden Pit went off: Thorn.", and the trap's
 * sound. One that went off out of the players' sight in a player's op says
 * so. The DM's own Set it off needs none: its card, if any, is already on
 * the desk.
 */
export function dmAlerts(lines: readonly LogEntry[], state: RoomState): TrapAlert[] {
  const out: TrapAlert[] = [];
  for (const e of lines) {
    const data = e.data;
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
export type Watched = { n: number; tokenIds: readonly string[]; to: readonly { tokenId: string; x: number; y: number }[]; since: string | null };

export function watchOf(op: ClientOp, n: number, since: string | null): Watched | null {
  if (!isPoseOp(op)) return null;
  if (op.t === "token.move") return { n, tokenIds: [op.tokenId], to: [{ tokenId: op.tokenId, x: op.x, y: op.y }], since };
  if (op.t === "token.moveMany") return { n, tokenIds: op.moves.map((m) => m.tokenId), to: op.moves.map((m) => ({ tokenId: m.tokenId, x: m.x, y: m.y })), since };
  if (op.t === "token.detach" && op.x !== undefined && op.y !== undefined) return { n, tokenIds: [op.tokenId], to: [{ tokenId: op.tokenId, x: op.x, y: op.y }], since };
  return "tokenId" in op ? { n, tokenIds: [op.tokenId], to: [], since } : null;
}

/**
 * Whether the server's answer shows a trap met the move (4.3): a token it
 * moved stands short of where the move asked, which only a trap's stop
 * does to a walk the device already checked, or a players' line since it
 * went names one of its tokens. Then the server refuses to take it back,
 * so the bar stops offering Undo move and Teleport here.
 */
export function metTrap(w: Watched, confirmed: { tokens: Readonly<Record<string, { x: number; y: number } | undefined>> }, trapSeen: readonly LogEntry[]): boolean {
  for (const t of w.to) {
    const now = confirmed.tokens[t.tokenId];
    if (now && (Math.abs(now.x - t.x) > 1e-6 || Math.abs(now.y - t.y) > 1e-6)) return true;
  }
  return linesAfter(trapSeen, w.since).some((e) => e.data?.type === "trapSeen" && e.data.by.some((id) => w.tokenIds.includes(id)));
}
