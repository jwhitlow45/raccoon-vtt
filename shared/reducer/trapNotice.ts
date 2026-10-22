import { keys } from "../keys.ts";
import { LIMITS } from "../limits.ts";
import type { RoomState, Token, Trap } from "../model.ts";
import { partySightOf, playersSeeGround, playersToken } from "../project.ts";
import type { Op } from "../protocol.ts";
import { boxDistanceFt, tokenCellBox, type CellBox } from "../rules/distance.ts";
import { rangeGround } from "../rules/heights.ts";
import { isPlainId, trapCreature, walkOp, zoneRanges } from "../rules/traps.ts";
import type { Tx } from "./tx.ts";

/** How near a creature must end its walk for the hint, in feet (docs/design-v1-traps.md 4.6). */
export const NOTICE_FT = 10;

/**
 * The Passive Perception hint (docs/design-v1-traps.md 4.6), the DM's
 * alone. A party creature that ends a walk within 10 ft of an armed trap
 * nobody found, by the room's distance rule from its footprint to the
 * zone's nearest square, while players can see the zone (in the party's
 * sight on a vision scene, not fully fogged elsewhere), and whose Passive
 * Perception is at least the DC of the trap's Perception check, gets the
 * DM a line in the DM's trap log. The trap remembers that creature in
 * `noticedBy` and hints no more until its find checks change: one creature
 * able to notice it is all the DM needs. It never marks the trap found.
 *
 * It writes only what no player receives, so no player can observe it.
 * A teleport is no walk. Returns whether it wrote anything.
 */
export function noticeStep(tx: Tx, op: Op, before: RoomState): boolean {
  if (!walkOp(op) || (op.t === "token.move" && op.teleport !== undefined)) return false;
  const after = tx.state;
  if (!Object.values(after.traps ?? {}).some((t) => t.rig?.notice && !t.found && t.state === "armed" && t.rig.noticedBy === undefined)) return false;
  const walkers = movedPartyCreatures(before, after, tx.touched());
  if (walkers.length === 0) return false;
  let wrote = false;
  const visible = new Map<string, (trap: Trap) => boolean>();
  for (const trap of Object.values(after.traps ?? {}).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const rig = trap.rig;
    if (!rig || trap.state !== "armed" || trap.found || !rig.notice || rig.noticedBy !== undefined) continue;
    const dc = perceptionDc(trap);
    if (dc === null) continue;
    for (const token of walkers) {
      if (token.sceneId !== trap.sceneId) continue;
      const passive = passiveOf(after, token);
      if (passive === null || passive < dc || !near(after, token, trap)) continue;
      let seen = visible.get(trap.sceneId);
      if (!seen) visible.set(trap.sceneId, (seen = zoneSeen(after, trap.sceneId)));
      if (!seen(trap)) continue;
      tx.write(keys.trap(trap.id), { ...trap, rig: { ...rig, noticedBy: token.id } });
      tx.addTrapLine("trapLog", { type: "trapNotice", trapId: trap.id, tokenId: token.id, passive, dc }, LIMITS.trapLogLines);
      wrote = true;
      break;
    }
  }
  return wrote;
}

/** The party creatures this op moved, by id: its walkers, and what they carry, wherever they ended. Only a plain id can be remembered. */
function movedPartyCreatures(before: RoomState, after: RoomState, touched: readonly string[]): Token[] {
  const out: Token[] = [];
  for (const key of touched) {
    if (!key.startsWith("token:")) continue;
    const id = key.slice("token:".length);
    const t = after.tokens[id];
    const was = before.tokens[id];
    if (!t || !was || (was.x === t.x && was.y === t.y && was.elevation === t.elevation && was.sceneId === t.sceneId)) continue;
    if (!isPlainId(id) || !trapCreature(after, t) || !playersToken(after, t)) continue;
    out.push(t);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The lowest DC of the trap's Wisdom (Perception) checks, or null without one. */
function perceptionDc(trap: Trap): number | null {
  let dc: number | null = null;
  for (const c of trap.rig?.find ?? []) if (c.skill === "perception" && (dc === null || c.dc < dc)) dc = c.dc;
  return dc;
}

function passiveOf(state: RoomState, token: Token): number | null {
  const actor = "inline" in token.actor ? token.actor.inline : state.characters[token.actor.ref]?.actor;
  return typeof actor?.passivePerception === "number" ? actor.passivePerception : null;
}

/** Within 10 ft of the zone's nearest square, on its ground, by the room's diagonal rule: the distance between boxes is the nearest squares'. */
function near(state: RoomState, token: Token, trap: Trap): boolean {
  const settings = state.meta.settings;
  const fpc = settings.feetPerCell > 0 ? settings.feetPerCell : 5;
  const from = tokenCellBox(token, fpc);
  for (const r of zoneRanges(state, trap.sceneId, trap.zone)) {
    const z0 = Math.floor(rangeGround(state.buildChunks, trap.sceneId, r) / fpc);
    const zone: CellBox = { x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1, z0, z1: z0 + 1 };
    if (boxDistanceFt(from, zone, settings) <= NOTICE_FT) return true;
  }
  return false;
}

/** Whether players can see any square of a trap's zone now: in the party's sight on a vision scene, not fully fogged on a scene with fog. */
function zoneSeen(state: RoomState, sceneId: string): (trap: Trap) => boolean {
  const scene = state.scenes[sceneId];
  if (!scene) return () => false;
  if (scene.vision?.on === true) {
    const sight = partySightOf(state, sceneId);
    return (trap) => zoneRanges(state, sceneId, trap.zone).some((r) => anyCell(r, (x, y) => sight.seesToken({ size: "medium", x, y })));
  }
  if (!scene.fogEnabled) return () => true;
  const sees = playersSeeGround(state, sceneId);
  return (trap) => zoneRanges(state, sceneId, trap.zone).some((r) => anyCell(r, sees));
}

/** Whether `test` holds for some cell of the range. */
function anyCell(r: { x0: number; y0: number; x1: number; y1: number }, test: (x: number, y: number) => boolean): boolean {
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) if (test(x, y)) return true;
  return false;
}
