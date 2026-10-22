import type { BuildChunk, LogEntry, LogEvent, RoomState, Token, Trap, TrapAction, TrapDue } from "#shared/model.ts";
import { compareLogIds } from "#shared/keys.ts";
import { displayName } from "../../lib/scene.ts";
import { findDoor } from "../doors/doors.ts";

/*
 * What a trap going off shows the DM (docs/design-v1-traps.md 4.3), as
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

function nameOf(names: Names, id: string): string {
  const token = names.tokens[id];
  return token ? displayName(token) : "a creature";
}

/** "Thorn", "Thorn and Bree", "Thorn, Bree and 2 more". */
export function nameList(names: Names, ids: readonly string[], more = 0): string {
  const parts = ids.map((id) => nameOf(names, id));
  if (more > 0) parts.push(`${more} more`);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The card's lines on who: who set it off and who it hits (5.6, frozen when it went off). */
export function whoLines(names: Names, due: TrapDue): { by: string; hits: string } {
  const by = nameList(names, due.by, due.more ?? 0);
  const hits = nameList(names, due.hits, due.hitsMore ?? 0);
  const set = due.how === "hand" ? (by ? `You set it off for ${by}.` : "You set it off.") : by ? `${by} set it off.` : "It went off.";
  return { by: set, hits: hits ? `It hits ${hits}.` : "It hits no one." };
}

/** A hidden springing's line (5.5): "Imp set it off, out of the players' sight. The trap is still armed for them." */
export function hiddenLine(names: Names, due: TrapDue): string {
  const by = nameList(names, due.by, due.more ?? 0) || "A creature";
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
 * list, and the pit as -1.
 */
export function didLines(trap: Trap, did: readonly { action: number; ok: boolean }[], view: Pick<RoomState, "tokens" | "lights" | "stamps" | "scenes"> & { buildChunks: Readonly<Record<string, BuildChunk>> }): string[] {
  const actions = trap.rig?.actions ?? [];
  return did.map(({ action, ok }) => {
    if (action === -1) return ok ? "Opened the pit." : `Could not open the pit: ${pitOutside(trap, view) ? "some of its squares lie outside the scene" : "the scene is at its wall limit"}.`;
    const a = actions[action];
    if (!a) return ok ? "Did something it no longer lists." : "Could not do something it no longer lists.";
    return actionLine(a, ok, view, trap.sceneId);
  });
}

/** Whether a squares trap reaches past its scene's edge, as a scene made smaller leaves it: the one other reason a pit cannot open. */
function pitOutside(trap: Trap, view: Pick<RoomState, "scenes">): boolean {
  const bounds = view.scenes[trap.sceneId]?.bounds;
  if (!bounds || !("cells" in trap.zone)) return true;
  return trap.zone.cells.some((r) => r.x + r.w > bounds.w || r.y + r.h > bounds.h);
}

function actionLine(a: TrapAction, ok: boolean, view: Pick<RoomState, "tokens" | "lights" | "stamps"> & { buildChunks: Readonly<Record<string, BuildChunk>> }, sceneId: string): string {
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
    const name = token ? displayName(token) : "a creature";
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
