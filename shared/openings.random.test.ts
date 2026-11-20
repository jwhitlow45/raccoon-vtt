import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { ANA, ATTIC, GROUND, UPPER, fallCard, onThornsTurn, thornToken, tower, trapdoor, withFalls, withOpening, withStairs, withTrapdoor } from "./floorLinksTestutil.ts";
import { FALLS_PER_ROOM, type FallRecord, type RoomState, type Token, type Viewer } from "./model.ts";
import { canApply } from "./permissions.ts";
import { inSightOfNonOwners, stableStringify } from "./project.ts";
import { isPoseOp, opSchema, type Op, type RestoreEntry } from "./protocol.ts";
import { applyOp, type Applied } from "./reducer.ts";
import { isCreature, onHolder } from "./rules/attach.ts";
import { isHole, linksOn, spaceOn } from "./rules/floorLinks.ts";
import { floorProblem } from "./rules/floors.ts";
import { footprintGround } from "./rules/heights.ts";
import { DM, env, template, token } from "./testutil.ts";
import { climbOf, type ClimbRecord } from "#server/rooms/undo.ts";

/*
 * Openings between floors as a state machine (docs/design/design-v1-floors.md
 * phase 4, 15): stairs, ladders and openings placed, moved, resized,
 * hidden, locked and removed, the DM's and Ana's walks onto and past
 * holes, group moves, heights, resizes, seats taken and left, flights and
 * climbs, trapdoors made, sprung by the DM and walked onto, floors shown
 * and hidden, blackouts, vision, fall cards dismissed, deletes, and the
 * undo and redo of both the DM's steps and Ana's falls, built as the actor
 * builds them, in random order. Each op runs as the actor runs it:
 * permissions, the reducer, then floorProblem on the tower. After every op
 * that applied:
 *
 * 1. floorProblem holds on the tower, and no link or trap op the reducer
 *    took needed the actor's floorProblem to refuse it, since linkProblem,
 *    the trap rules and pitsFit hold the same rules.
 * 2. No creature the op placed anew, or that stood on an upper end whose
 *    squares the op wrote, ends on the ground wholly over an opening's
 *    upper end while nothing holds it up by 4.1's rule (no fall for a
 *    restore, which never falls).
 * 3. Every card's creature exists, or a player's op deleted it.
 * 4. At most FALLS_PER_ROOM cards, each id "<made>:<n>".
 * 5. Each fall record names an opening's upper end as it stood before the
 *    op, at its rev and `made`, from its floor to the floor below, or one
 *    the op itself placed.
 * 6. The same op on the same room gives byte-equal results.
 * 7. Ana's undo of her step right after it, a fall's or a flight's
 *    included, passes, while no floor's fog is on: the actor explores
 *    after each batch, which shows her the ends her undo crosses back by,
 *    and this machine runs no explore.
 * 8. A player's op takes no card away but the oldest a full room drops
 *    for a new one, or one its own undo's record names.
 * 9. A restore makes no fall record, and every creature it puts back
 *    stands on the floor it puts it on, so a restore never falls.
 * 10. A redo writes back only a card its record carries.
 * 11. A walk takes no creature it names that was in the air off its floor.
 * 12. An op that makes cards drops only the oldest past a full room.
 *
 * What players are sent (no key of an unheld floor, a hidden end or a
 * hidden creature, joined sight) is the projection's, which its own
 * tests hold, so it is left out here.
 */

type Kind = "stairs" | "ladder" | "opening";

type Act =
  | { k: "put"; floor: number; up: boolean; x: number; y: number; w: number; h: number; kind: number }
  | { k: "link"; link: number; how: number; x: number; y: number; w: number }
  | { k: "remove"; link: number }
  | { k: "walk"; who: number; x: number; y: number; dm: boolean; route: boolean }
  | { k: "onto"; who: number; link: number; dm: boolean; dx: number }
  | { k: "anaHole"; who: number; link: number }
  | { k: "rim"; link: number; dm: boolean }
  | { k: "gone"; link: number }
  | { k: "settled"; link: number }
  | { k: "many"; link: number; dx: number }
  | { k: "height"; who: number; up: boolean; dm: boolean }
  | { k: "size"; who: number; size: number; dm: boolean }
  | { k: "seat"; rider: number; holder: number; kind: number }
  | { k: "off"; who: number }
  | { k: "climb"; who: number; link: number; dm: boolean }
  | { k: "trapdoor"; floor: number; x: number; y: number }
  | { k: "under"; who: number }
  | { k: "ontoTrap"; who: number; trap: number; dm: boolean }
  | { k: "fly"; who: number; link: number; dm: boolean }
  | { k: "spring"; trap: number }
  | { k: "open"; floor: number; open: boolean }
  | { k: "blackout"; on: boolean }
  | { k: "vision"; floor: number; on: boolean; perPlayer: boolean }
  | { k: "settle"; card: number }
  | { k: "delete"; who: number }
  | { k: "moveTo"; who: number; floor: number }
  | { k: "undo" }
  | { k: "anaUndo" }
  | { k: "anaRedo" };

const n = fc.nat({ max: 60 });
const cell = fc.nat({ max: 13 });
const ACT: fc.Arbitrary<Act> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant("put" as const), floor: n, up: fc.boolean(), x: cell, y: cell, w: fc.integer({ min: 1, max: 3 }), h: fc.integer({ min: 1, max: 3 }), kind: n }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("link" as const), link: n, how: n, x: cell, y: cell, w: fc.integer({ min: 1, max: 3 }) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("remove" as const), link: n }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("walk" as const), who: n, x: cell, y: cell, dm: fc.boolean(), route: fc.boolean() }) },
  { weight: 8, arbitrary: fc.record({ k: fc.constant("onto" as const), who: n, link: n, dm: fc.boolean(), dx: fc.integer({ min: -1, max: 1 }) }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("anaHole" as const), who: fc.boolean(), link: n }).map((x) => ({ ...x, who: x.who ? 1 : 0 })) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("rim" as const), link: n, dm: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("gone" as const), link: n }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("settled" as const), link: n }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("many" as const), link: n, dx: fc.integer({ min: 0, max: 1 }) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("height" as const), who: n, up: fc.boolean(), dm: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("size" as const), who: n, size: n, dm: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("seat" as const), rider: n, holder: n, kind: n }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("off" as const), who: n }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("climb" as const), who: n, link: n, dm: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("trapdoor" as const), floor: n, x: cell, y: cell }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("under" as const), who: n }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("ontoTrap" as const), who: n, trap: n, dm: fc.boolean() }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("fly" as const), who: n, link: n, dm: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("spring" as const), trap: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("open" as const), floor: n, open: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("blackout" as const), on: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("vision" as const), floor: n, on: fc.boolean(), perPlayer: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("settle" as const), card: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("delete" as const), who: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("moveTo" as const), who: n, floor: n }) },
  { weight: 2, arbitrary: fc.constant({ k: "undo" as const }) },
  { weight: 3, arbitrary: fc.constant({ k: "anaUndo" as const }) },
  { weight: 4, arbitrary: fc.constant({ k: "anaRedo" as const }) },
);

/** A step of Ana's own, as the actor keeps one: its restore, its climb, and its fall records with the card each undo removed. */
type AnaStep = { entries: RestoreEntry[]; falls: FallRecord[]; climb?: ClimbRecord };

type World = {
  state: RoomState;
  seq: number;
  next: number;
  /** The DM's steps, each its whole inverse. */
  undo: RestoreEntry[][];
  /** Ana's last step, while nothing since could stand in its way. */
  ana: AnaStep | null;
  /** Ana's last undone fall step, for her redo. */
  redo: AnaStep | null;
  /** Creatures a player's op deleted, whose cards stay for the DM (4.4). */
  playerDeleted: Set<string>;
  /** Whether Ana's step is the last op that applied, so nothing stands in its undo's way. */
  fresh: boolean;
};

const FLOORS = [GROUND, UPPER, ATTIC] as const;
/** Every creature of the room: Thorn and Pip are Ana's, the rest the DM's, the shade hidden. */
const WHO = ["thorn", "pip", "goblin", "ogre", "bat", "horse", "shade"] as const;
const SIZES = ["tiny", "small", "medium", "large", "huge"] as const;
const ATTACH = ["ride", "perch", "carry", "drag"] as const;

const pickOf = <T>(list: readonly T[], i: number): T | undefined => (list.length === 0 ? undefined : list[i % list.length]);
const linkIds = (s: RoomState) => Object.keys(s.floorLinks ?? {}).sort();
const mine = (id: string) => id === "thorn" || id === "pip";

function opFor(w: World, a: Act): { op: Op; who: Viewer } | null {
  const s = w.state;
  const dm = (op: Op) => ({ op, who: DM });
  const as = (tokenId: string, byDm: boolean) => (byDm || !mine(tokenId) ? DM : ANA);
  switch (a.k) {
    case "put": {
      const from = FLOORS[a.floor % 3]!;
      const level = FLOORS.indexOf(from);
      const to = FLOORS[level + (a.up ? 1 : -1)];
      if (!to) return null;
      const kind: Kind = (["stairs", "ladder", "opening", "opening"] as const)[a.kind % 4]!;
      const id = w.next++;
      return dm({ t: "floorLink.put", link: { id: `a${id}`, pairId: `b${id}`, sceneId: from, to, rect: { x: a.x, y: a.y, w: a.w, h: a.h }, kind } });
    }
    case "link": {
      const id = pickOf(linkIds(s), a.link);
      if (!id) return null;
      const link = s.floorLinks![id]!;
      const patches = [
        { locked: link.locked !== true },
        { hidden: link.hidden !== true },
        { kind: (["stairs", "ladder", "opening"] as const)[a.how % 3]! },
        { rect: { x: a.x, y: a.y, w: link.rect.w, h: link.rect.h } },
        { rect: { x: link.rect.x, y: link.rect.y, w: a.w, h: a.w }, pairRect: { x: a.x, y: a.y, w: a.w, h: a.w } },
        { pairRect: { x: a.x, y: a.y, w: link.rect.w, h: link.rect.h } },
      ];
      return dm({ t: "floorLink.update", linkId: id, patch: pickOf(patches, a.how)! });
    }
    case "remove": {
      const id = pickOf(linkIds(s), a.link);
      return id ? dm({ t: "floorLink.delete", linkId: id }) : null;
    }
    case "walk": {
      const id = pickOf(WHO, a.who)!;
      const t = s.tokens[id];
      if (!t) return null;
      const op: Op = a.route ? { t: "token.move", tokenId: id, x: a.x, y: a.y, route: [[a.x, a.y, 0, 0]] } : { t: "token.move", tokenId: id, x: a.x, y: a.y };
      return { op, who: as(id, a.dm) };
    }
    case "onto": {
      // Onto an end on the creature's floor, a hole most of all, or one square off it, so falls and their misses come often.
      const id = pickOf(WHO, a.who)!;
      const t = s.tokens[id];
      if (!t) return null;
      const holes = linksOn(s, t.sceneId).filter((l) => isHole(s, l));
      const ends = holes.length > 0 && a.link % 3 !== 0 ? holes : linksOn(s, t.sceneId);
      const end = pickOf(ends, a.link);
      if (!end) return null;
      return { op: { t: "token.move", tokenId: id, x: end.rect.x + (a.dx === 0 ? 0 : a.dx < 0 ? -1 : end.rect.w - 1), y: end.rect.y }, who: as(id, a.dm) };
    }
    case "anaHole": {
      // Ana walks Thorn or Pip onto a hole on its floor, so her falls and their undo and redo come often.
      const t = s.tokens[a.who === 0 ? "thorn" : "pip"];
      const end = t && pickOf(linksOn(s, t.sceneId).filter((l) => isHole(s, l)), a.link);
      return t && end ? { op: { t: "token.move", tokenId: t.id, x: end.rect.x, y: end.rect.y }, who: ANA } : null;
    }
    case "many": {
      // The goblin and the ogre onto two holes, or the same one, in one group move, as one floor's creatures.
      const g = s.tokens.goblin;
      const o = s.tokens.ogre;
      if (!g || !o || g.sceneId !== o.sceneId) return null;
      const holes = linksOn(s, g.sceneId).filter((l) => isHole(s, l));
      const h1 = pickOf(holes, a.link);
      const h2 = pickOf(holes, a.link + a.dx);
      if (!h1 || !h2) return null;
      return dm({ t: "token.moveMany", moves: [{ tokenId: "goblin", x: h1.rect.x, y: h1.rect.y }, { tokenId: "ogre", x: h2.rect.x, y: h2.rect.y }] });
    }
    case "height": {
      const id = pickOf(WHO, a.who)!;
      const t = s.tokens[id];
      if (!t) return null;
      const ground = footprintGround(s.buildChunks, t);
      return { op: { t: "token.update", tokenId: id, patch: { elevation: a.up ? ground + 10 : ground } }, who: as(id, a.dm) };
    }
    case "size": {
      const id = pickOf(WHO, a.who)!;
      if (!s.tokens[id]) return null;
      return { op: { t: "token.update", tokenId: id, patch: { size: pickOf(SIZES, a.size)! } }, who: as(id, a.dm) };
    }
    case "seat": {
      const rider = s.tokens[pickOf(WHO, a.rider)!];
      const holder = s.tokens[pickOf(WHO, a.holder)!];
      if (!rider || !holder || rider.id === holder.id || rider.sceneId !== holder.sceneId) return null;
      const kind = pickOf(ATTACH, a.kind)!;
      // A seat on the holder's own square, a drag where the creature stands.
      const at = kind === "drag" ? { x: rider.x, y: rider.y, elevation: rider.elevation } : { x: holder.x, y: holder.y, elevation: holder.elevation };
      return dm({ t: "token.attach", tokenId: rider.id, to: holder.id, kind, ...at });
    }
    case "off": {
      const id = pickOf(WHO, a.who)!;
      const t = s.tokens[id];
      if (!t?.attached) return null;
      return dm(t.attached.kind === "ride" ? { t: "token.detach", tokenId: id, x: t.x + 2, y: t.y, elevation: t.elevation } : { t: "token.detach", tokenId: id });
    }
    case "climb": {
      const id = pickOf(WHO, a.who)!;
      const t = s.tokens[id];
      if (!t) return null;
      // Mostly an end the creature is on or under, sometimes any end on its floor, whose refusal is read too.
      const here = linksOn(s, t.sceneId);
      const under = here.filter((l) => t.x >= l.rect.x && t.y >= l.rect.y && t.x < l.rect.x + l.rect.w && t.y < l.rect.y + l.rect.h);
      const end = a.link % 4 === 0 ? pickOf(here, a.link) : (pickOf(under, a.link) ?? pickOf(here, a.link));
      return end ? { op: { t: "token.climb", tokenId: id, linkId: end.id }, who: as(id, a.dm) } : null;
    }
    case "trapdoor": {
      const { id: _id, rev: _rev, state: _state, found: _found, ...rest } = trapdoor(`d${w.next}`, { sceneId: FLOORS[a.floor % 3]!, zone: { cells: [{ x: a.x, y: a.y, w: 2, h: 2 }] } });
      return dm({ t: "trap.create", trap: { ...rest, id: `d${w.next++}`, rig: { ...rest.rig!, resets: "nextTurn" } } } as Op);
    }
    case "under": {
      // A trapdoor under a creature where it stands, which the next spring or walk drops.
      const t = s.tokens[pickOf(WHO, a.who)!];
      if (!t) return null;
      const { id: _id, rev: _rev, state: _state, found: _found, ...rest } = trapdoor("x", { sceneId: t.sceneId, zone: { cells: [{ x: Math.floor(t.x), y: Math.floor(t.y), w: 2, h: 2 }] } });
      return dm({ t: "trap.create", trap: { ...rest, id: `d${w.next++}` } } as Op);
    }
    case "ontoTrap": {
      const id = pickOf(WHO, a.who)!;
      const t = s.tokens[id];
      if (!t) return null;
      const trap = pickOf(
        Object.values(s.traps ?? {})
          .filter((x) => x.sceneId === t.sceneId && "cells" in x.zone)
          .sort((x, y) => (x.id < y.id ? -1 : 1)),
        a.trap,
      );
      if (!trap || !("cells" in trap.zone)) return null;
      const at = trap.zone.cells[0]!;
      return { op: { t: "token.move", tokenId: id, x: at.x, y: at.y }, who: as(id, a.dm) };
    }
    case "fly": {
      // A creature in the air over or under an opening's end takes it: lifted first where it stands on the ground.
      const over = (t: Token) => linksOn(s, t.sceneId).filter((l) => l.kind === "opening" && spaceOn(s, t, l));
      const t = pickOf(
        WHO.map((id) => s.tokens[id]).filter((x): x is Token => x !== undefined && over(x).length > 0),
        a.who,
      );
      const end = t && pickOf(over(t), a.link);
      if (!t || !end) return null;
      const id = t.id;
      if (t.elevation === footprintGround(s.buildChunks, t)) return { op: { t: "token.update", tokenId: id, patch: { elevation: t.elevation + 10 } }, who: as(id, a.dm) };
      return { op: { t: "token.climb", tokenId: id, linkId: end.id }, who: as(id, a.dm) };
    }
    case "spring": {
      const trap = pickOf(Object.values(s.traps ?? {}).sort((x, y) => (x.id < y.id ? -1 : 1)), a.trap);
      if (!trap) return null;
      const on = Object.values(s.tokens)
        .filter((t) => t.sceneId === trap.sceneId)
        .map((t) => t.id)
        .sort();
      return dm({ t: "trap.spring", trapId: trap.id, tokenIds: on });
    }
    case "open":
      return dm({ t: "floor.open", sceneId: FLOORS[a.floor % 3]!, open: a.open });
    case "blackout":
      return dm({ t: "view.blackout", blackout: a.on });
    case "vision":
      return dm({ t: "scene.update", sceneId: FLOORS[a.floor % 3]!, patch: { vision: { on: a.on, light: "bright", perPlayer: a.perPlayer } } });
    case "settle": {
      const id = pickOf(Object.keys(s.falls ?? {}).sort(), a.card);
      return id ? dm({ t: "fall.settle", fallId: id }) : null;
    }
    case "delete": {
      // Ana dismisses Pip, her own creature, or the DM deletes another.
      const id = pickOf(WHO, a.who)!;
      if (!s.tokens[id] || id === "thorn") return null;
      return { op: { t: "token.delete", tokenId: id }, who: id === "pip" ? ANA : DM };
    }
    case "moveTo": {
      const id = pickOf(WHO, a.who)!;
      const t = s.tokens[id];
      if (!t) return null;
      return dm({ t: "token.update", tokenId: id, patch: { sceneId: FLOORS[a.floor % 3]! } });
    }
    case "undo": {
      const entries = w.undo.pop();
      return entries ? dm({ t: "sys.restore", entries, from: "undo", deps: true }) : null;
    }
    case "rim":
    case "gone":
    case "settled":
      // Scenes of several ops (opsFor).
      return null;
    case "anaUndo": {
      const step = w.ana;
      if (!step) return null;
      return { op: { t: "sys.restore", entries: step.entries, from: "undo", deps: true, ...(step.climb ? { climb: step.climb } : {}), ...(step.falls.length > 0 ? { falls: step.falls } : {}) } as Op, who: ANA };
    }
    case "anaRedo": {
      const step = w.redo;
      if (!step) return null;
      return { op: { t: "sys.restore", entries: step.entries, from: "redo", deps: true, ...(step.climb ? { climb: step.climb } : {}), ...(step.falls.length > 0 ? { falls: step.falls } : {}) } as Op, who: ANA };
    }
  }
}

/** An op to run, and the act it stands for inside a scene of several (`as`), which the step's bookkeeping reads. */
type Next = { op: Op; who: Viewer; as?: "anaUndo" | "anaRedo" };

/**
 * The ops an act makes, each made from the room the one before left:
 * most acts make one. Two make a short scene the random order would
 * seldom reach. On the rim, Thorn sits on the shade, which the DM made
 * Large and set half over a hole, and then walks onto the hole inside
 * its space, so Ana's walk falls alone off a holder no player sees and
 * the DM's stays (4.1). An opening gone and given back: the DM removes a
 * hole, Ana walks Thorn onto its squares, and the DM's undo puts the hole
 * back under him, which never drops him, as a restore never falls.
 */
function opsFor(a: Act): ((w: World) => Next | null)[] {
  const hole = (s: RoomState, sceneId: string | undefined, i: number) => (sceneId === undefined ? undefined : pickOf(linksOn(s, sceneId).filter((l) => isHole(s, l) && l.rect.x > 0), i));
  if (a.k === "rim") {
    return [
      (w) => {
        const thorn = w.state.tokens.thorn;
        const h = hole(w.state, thorn?.sceneId, a.link);
        if (!thorn || !h || !w.state.tokens.shade) return null;
        const at = { ...w.state.tokens.shade, sceneId: thorn.sceneId, size: "large" as const, x: h.rect.x - 1, y: h.rect.y };
        return { op: { t: "token.update", tokenId: "shade", patch: { sceneId: thorn.sceneId, size: "large", x: at.x, y: at.y, elevation: footprintGround(w.state.buildChunks, at) } }, who: DM };
      },
      (w) => {
        const shade = w.state.tokens.shade;
        return shade ? { op: { t: "token.attach", tokenId: "thorn", to: "shade", kind: "ride", x: shade.x, y: shade.y, elevation: shade.elevation }, who: DM } : null;
      },
      (w) => {
        const shade = w.state.tokens.shade;
        return shade && w.state.tokens.thorn?.attached?.to === "shade" ? { op: { t: "token.move", tokenId: "thorn", x: shade.x + 1, y: shade.y }, who: a.dm ? DM : ANA } : null;
      },
    ];
  }
  if (a.k === "gone") {
    let rect: { x: number; y: number } | undefined;
    return [
      (w) => {
        const h = hole(w.state, w.state.tokens.thorn?.sceneId, a.link);
        rect = h?.rect;
        return h ? { op: { t: "floorLink.delete", linkId: h.id }, who: DM } : null;
      },
      () => (rect ? { op: { t: "token.move", tokenId: "thorn", x: rect.x, y: rect.y }, who: ANA } : null),
      (w) => opFor(w, { k: "undo" }),
    ];
  }
  if (a.k === "settled") {
    // Ana falls, the DM dismisses her card, and her undo and redo follow: the redo's record carries no card, so it writes none.
    let fallId: string | undefined;
    return [
      (w) => opFor(w, { k: "anaHole", who: 0, link: a.link }),
      (w) => {
        fallId = w.ana?.falls[0]?.fallId;
        return fallId && w.state.falls?.[fallId] ? { op: { t: "fall.settle", fallId }, who: DM } : null;
      },
      (w) => {
        const next = opFor(w, { k: "anaUndo" });
        return next && { ...next, as: "anaUndo" };
      },
      (w) => {
        const next = opFor(w, { k: "anaRedo" });
        return next && { ...next, as: "anaRedo" };
      },
    ];
  }
  return [(w) => opFor(w, a)];
}

type Stepped = { ok: true; r: Applied } | { ok: false; message: string; byFloors: boolean };

/** The actor's order: permissions, the reducer, then floorProblem on the tower (server/rooms/actor.ts). */
function step(w: World, op: Op, who: Viewer): Stepped {
  // An op the schema refuses never reaches the room, as the server's socket refuses it.
  const shaped = opSchema.safeParse(op);
  if (!shaped.success) return { ok: false, message: shaped.error.message, byFloors: false };
  const parsed = shaped.data;
  const d = canApply(parsed, who, w.state, { canUseAsset: () => true });
  if (!d.ok) return { ok: false, message: d.message, byFloors: false };
  const seq = ++w.seq;
  const r = applyOp(w.state, parsed, who, env(seq));
  if (!r.ok) return { ok: false, message: r.message, byFloors: false };
  // Invariant 6: the same op on the same room, again.
  const again = applyOp(w.state, parsed, who, env(seq));
  assert.ok(again.ok);
  assert.equal(digest(again), digest(r), `${op.t} applies the same twice`);
  const problem = floorProblem(r.state, GROUND);
  if (problem !== null) return { ok: false, message: problem, byFloors: true };
  return { ok: true, r };
}

function digest(r: Applied): string {
  return stableStringify({ state: r.state, touched: r.touched, inverse: r.inverse, falls: r.falls ?? null, trapWrote: r.trapWrote ? [...r.trapWrote].sort() : null, trapped: r.trapped ?? null });
}

/** Whether something holds the creature up by 4.1's rule, restated: a seat on a holder on its floor, every one for the DM, one every player saw for a player. */
function heldUp(before: RoomState, after: RoomState, t: Token, who: Viewer): boolean {
  const link = t.attached;
  if (!link || !onHolder(link.kind)) return false;
  const holder = after.tokens[link.to];
  if (!holder || holder.id === t.id || holder.sceneId !== t.sceneId) return false;
  if (who.role === "dm") return true;
  const was = before.tokens[holder.id];
  return was !== undefined && inSightOfNonOwners(before, was, {});
}

function placedAnew(was: Token, now: Token): boolean {
  const seated = (t: Token) => t.attached !== undefined && onHolder(t.attached.kind);
  return was.sceneId !== now.sceneId || was.x !== now.x || was.y !== now.y || was.elevation !== now.elevation || was.size !== now.size || was.w !== now.w || was.h !== now.h || (was.squeeze === true) !== (now.squeeze === true) || (seated(was) && !seated(now));
}

/** Invariant 2. */
function noneLeftOverHoles(before: RoomState, r: Applied, op: Op, who: Viewer): number {
  if (op.t === "sys.restore") return 0;
  const after = r.state;
  const asked = new Set<string>();
  for (const key of r.touched) {
    if (key.startsWith("token:")) {
      const id = key.slice("token:".length);
      const was = before.tokens[id];
      const now = after.tokens[id];
      if (was && now && placedAnew(was, now)) asked.add(id);
    } else if (key.startsWith("floorLink:")) {
      // Squares written: a new end, or one whose rect the op changed (4.1). A lock, a hiding or a kind leaves who stands there standing.
      const id = key.slice("floorLink:".length);
      const end = after.floorLinks?.[id];
      const was = before.floorLinks?.[id];
      const moved = !was || was.rect.x !== end?.rect.x || was.rect.y !== end.rect.y || was.rect.w !== end.rect.w || was.rect.h !== end.rect.h;
      if (end && moved && isHole(after, end)) for (const t of Object.values(after.tokens)) if (spaceOn(after, t, end)) asked.add(t.id);
    }
  }
  let over = 0;
  for (const id of asked) {
    const t = after.tokens[id];
    if (!t || !isCreature(t) || t.elevation !== footprintGround(after.buildChunks, t)) continue;
    const hole = linksOn(after, t.sceneId).find((l) => isHole(after, l) && after.floorLinks?.[l.pair] !== undefined && spaceOn(after, t, l));
    if (!hole) continue;
    over++;
    assert.ok(heldUp(before, after, t, who), `${op.t} by ${who.memberId} left ${id} on the ground over ${hole.id} with nothing holding it up`);
  }
  return over;
}

/** Invariants 3 to 5. */
function cardsHold(w: World, before: RoomState, r: Applied, op: Op): void {
  const cards = Object.values(r.state.falls ?? {});
  assert.ok(cards.length <= FALLS_PER_ROOM, `${cards.length} cards`);
  for (const card of cards) {
    assert.match(card.id, /^\d+:\d+$/);
    assert.equal(card.id.slice(0, card.id.indexOf(":")), String(card.made), `${card.id} starts with its made`);
    assert.ok(r.state.tokens[card.tokenId] !== undefined || w.playerDeleted.has(card.tokenId), `${card.id}'s creature ${card.tokenId} is there or a player deleted it`);
  }
  for (const record of r.falls ?? []) {
    const was = before.floorLinks?.[record.linkId];
    if (was) {
      assert.ok(isHole(before, was), `${record.linkId} was an upper end`);
      assert.deepEqual([record.rev, record.made, record.from, record.to], [was.rev, was.made, was.sceneId, was.to], `${record.linkId} as it stood before`);
    } else {
      assert.ok(op.t === "floorLink.put" && (op.link.id === record.linkId || op.link.pairId === record.linkId), `${record.linkId} placed by the op`);
    }
    assert.ok(r.state.falls?.[record.fallId] !== undefined || cards.length === FALLS_PER_ROOM, `${record.fallId} written`);
  }
  // Each root's fall has a card of its own.
  const ids = (r.falls ?? []).map((f) => f.fallId);
  assert.equal(new Set(ids).size, ids.length, "one card a fall");
  // A move that makes cards drops only the oldest past a full room, and none sooner.
  if (MAKES_CARDS.has(op.t)) {
    const had = Object.keys(before.falls ?? {}).length;
    const made = cards.filter((c) => before.falls?.[c.id] === undefined).length;
    assert.equal(cards.length, Math.min(FALLS_PER_ROOM, had + made), `${op.t} keeps ${Math.min(FALLS_PER_ROOM, had + made)} cards`);
  }
}

/** The ops that make cards and take none away but by eviction: moves, landings, ends placed and trapdoors sprung. */
const MAKES_CARDS: ReadonlySet<string> = new Set(["token.move", "token.moveMany", "token.update", "token.attach", "token.detach", "token.climb", "floorLink.put", "floorLink.update", "trap.spring"]);

/**
 * Invariants 8 and 9: a player's op takes no card away but the oldest a
 * full room drops for a new one, or one its own undo's record names (4.4,
 * 4.7), and a restore lands nobody: it makes no record, and every creature
 * it puts back stands on the floor it puts it on.
 */
function playersAndRestores(before: RoomState, r: Applied, op: Op, who: Viewer): void {
  if (op.t === "sys.restore") {
    assert.equal(r.falls, undefined, "a restore makes no fall record");
    for (const e of op.entries) {
      const put = e.value as Token | null | undefined;
      if (!e.key.startsWith("token:") || !put) continue;
      assert.equal(r.state.tokens[put.id]?.sceneId, put.sceneId, `${put.id} stays where the restore puts it`);
    }
  }
  // Invariant 11: a walk takes no creature it names that was in the air off its floor, since a flier over a hole stays (4.1).
  if (op.t === "token.move" || op.t === "token.moveMany") {
    for (const m of op.t === "token.move" ? [op] : op.moves) {
      const was = before.tokens[m.tokenId];
      if (!was || m.elevation !== undefined || was.elevation <= footprintGround(before.buildChunks, was)) continue;
      assert.equal(r.state.tokens[m.tokenId]?.sceneId, was.sceneId, `${m.tokenId} in the air stays on its floor`);
    }
  }
  if (who.role !== "player") return;
  const undone = new Set(op.t === "sys.restore" && op.from === "undo" ? (op.falls ?? []).map((f) => f.fallId) : []);
  const left = Object.values(r.state.falls ?? {});
  for (const card of Object.values(before.falls ?? {})) {
    if (r.state.falls?.[card.id] !== undefined || undone.has(card.id)) continue;
    const evicted = left.length === FALLS_PER_ROOM && left.every((c) => c.made > card.made || (c.made === card.made && c.id > card.id));
    assert.ok(evicted, `a player's ${op.t} took ${card.id} away`);
  }
}

/**
 * Ana's step as the actor keeps it (server/rooms/actor.ts, D-261119-120):
 * the inverse without the trap step's keys and without any fall card, and a
 * record for each root she received whose token stays in it. Null where the
 * step's undo is the DM's (`trapped`).
 */
function anaStep(before: RoomState, op: Op, r: Applied): AnaStep | null {
  if (r.trapped || !r.inverse) return null;
  const entries = r.inverse.filter((e) => !e.key.startsWith("fall:") && !(r.trapWrote?.has(e.key as never) ?? false));
  const kept = new Set(entries.filter((e) => e.key.startsWith("token:")).map((e) => e.key.slice("token:".length)));
  // Only a root she received: in this room, one the DM did not hide.
  const falls = (r.falls ?? []).filter((f) => kept.has(f.tokenId) && before.tokens[f.tokenId] !== undefined && before.tokens[f.tokenId]!.visibility !== "dm");
  const climb = climbOf(before, op);
  return entries.length > 0 ? { entries, falls, ...(climb ? { climb } : {}) } : null;
}

type Counts = { applied: number; refused: number; byFloors: number; falls: number; records: number; overHeld: number; flights: number; drops: number; anaUndos: number; anaRedos: number; cardsBack: number };

function counted(): Counts {
  return { applied: 0, refused: 0, byFloors: 0, falls: 0, records: 0, overHeld: 0, flights: 0, drops: 0, anaUndos: 0, anaRedos: 0, cardsBack: 0 };
}

/** The room every sequence starts from. */
function startRoom(): RoomState {
  // Thorn on Upper floor with an opening to Ground floor beside him, an opening from the Attic onto Upper floor, stairs up from
  // Ground floor, a trapdoor on Upper floor, a goblin, a Large ogre and a horse to sit on, a flying bat, a shade the DM hid, Pip
  // (Ana's), and Spirit Guardians on Ground floor, on Thorn's turn.
  const base = withTrapdoor(withOpening(withOpening(withStairs(tower({ tokens: {} }), { rect: { x: 10, y: 3, w: 1, h: 1 } })), { id: "o3", pairId: "o4", upper: ATTIC, lower: UPPER, rect: { x: 14, y: 14, w: 2, h: 2 } }));
  const creatures: Token[] = [
    thornToken({ sceneId: UPPER, x: 3, y: 3 }),
    token("pip", { sceneId: UPPER, name: "Pip", kind: "npc", size: "tiny", ownerIds: ["p1"], companion: { of: "thorn", turn: "own" }, x: 4, y: 3 }),
    token("goblin", { sceneId: UPPER, name: "Goblin", x: 4, y: 6 }),
    token("ogre", { sceneId: UPPER, name: "Ogre", size: "large", x: 1, y: 1 }),
    token("bat", { sceneId: UPPER, name: "Bat", size: "tiny", x: 6, y: 9, elevation: 10 }),
    token("horse", { sceneId: UPPER, name: "Horse", size: "large", x: 2, y: 8 }),
    token("shade", { sceneId: UPPER, name: "Shade", visibility: "dm", x: 8, y: 7 }),
  ];
  const guardians = template("sg", { sceneId: GROUND, shape: "sphere", size: 10, origin: { x: 7, y: 7, z: 0 }, ownerId: "dm1", spell: "Spirit Guardians", triggers: ["enter"] });
  // Eight cards from earlier falls, so a few more fill the room and eviction comes into play.
  const old = WHO.slice(0, 8).map((id, i) => fallCard({ made: 10 + i, tokenId: id, from: UPPER, sceneId: GROUND }));
  return onThornsTurn(withFalls({ ...base, tokens: Object.fromEntries(creatures.map((t) => [t.id, t])), templates: { sg: guardians } }, ...old, fallCard({ made: 18, tokenId: "goblin" })));
}

/** One sequence of acts, each op checked against every invariant above. */
function play(start: RoomState, acts: readonly Act[], counts: Counts): void {
  const w: World = { state: start, seq: 1000, next: 0, undo: [], ana: null, redo: null, playerDeleted: new Set(), fresh: false };
  for (const a of acts) for (const make of opsFor(a)) {
    const next = make(w);
    if (!next) break;
    const k = next.as ?? a.k;
    const before = w.state;
    const r = step(w, next.op, next.who);
    if (!r.ok) {
      counts.refused++;
      if (r.byFloors) {
        counts.byFloors++;
        // Invariant 1: the reducer and permissions refuse every link and trap op floorProblem would, in their own words.
        assert.ok(!(["floorLink.put", "floorLink.update", "trap.create", "trap.update"] as string[]).includes(next.op.t), `${next.op.t} needed floorProblem: ${r.message}`);
      }
      // Invariant 7.
      if (k === "anaUndo" && w.fresh && FLOORS.every((f) => w.state.scenes[f]?.fogEnabled !== true)) assert.fail(`Ana's undo right after her step refused: ${r.message} ${JSON.stringify(w.ana?.falls)}`);
      // A refused undo or redo leaves its step, as the actor's does until something stands in its way.
      if (k === "anaUndo") w.ana = null;
      if (k === "anaRedo") w.redo = null;
      break;
    }
    counts.applied++;
    w.fresh = false;
    const applied = r.r;
    w.state = applied.state;
    assert.equal(floorProblem(w.state, GROUND), null);
    if (next.op.t === "token.delete" && next.who.role === "player") w.playerDeleted.add(next.op.tokenId);
    counts.overHeld += noneLeftOverHoles(before, applied, next.op, next.who);
    cardsHold(w, before, applied, next.op);
    playersAndRestores(before, applied, next.op, next.who);
    counts.falls += Object.keys(applied.state.falls ?? {}).filter((id) => before.falls?.[id] === undefined).length;
    counts.records += applied.falls?.length ?? 0;
    if (next.op.t === "token.climb" && before.floorLinks?.[next.op.linkId]?.kind === "opening") counts.flights++;
    // A card with no record is a trapdoor's drop.
    const recorded = new Set((applied.falls ?? []).map((f) => f.fallId));
    counts.drops += Object.keys(applied.state.falls ?? {}).filter((id) => before.falls?.[id] === undefined && !recorded.has(id)).length;
    if (k === "anaUndo") {
      counts.anaUndos++;
      // Her redo carries the card each undo removed, as the actor puts it on the redo step's record (4.5).
      const step = w.ana!;
      const falls = step.falls.map((f) => {
        const card = before.falls?.[f.fallId];
        return card && applied.state.falls?.[f.fallId] === undefined ? { ...f, card } : f;
      });
      for (const f of step.falls) assert.equal(applied.state.falls?.[f.fallId], undefined, `the undo removes ${f.fallId}`);
      w.redo = applied.inverse ? { entries: applied.inverse.filter((e) => !e.key.startsWith("fall:")), falls, ...(step.climb ? { climb: step.climb } : {}) } : null;
      w.ana = null;
      continue;
    }
    if (k === "anaRedo") {
      counts.anaRedos++;
      for (const f of w.redo!.falls) {
        // A record without its card, one a later Apply or Dismiss took, writes none back: no damage asked for twice.
        if (!f.card) assert.ok(before.falls?.[f.fallId] !== undefined || applied.state.falls?.[f.fallId] === undefined, `the redo writes no card for ${f.fallId}`);
        if (f.card) {
          counts.cardsBack++;
          const back = applied.state.falls?.[f.card.id];
          const full = Object.keys(applied.state.falls ?? {}).length === FALLS_PER_ROOM;
          assert.ok(back !== undefined || full, `the redo writes back ${f.card.id}`);
        }
      }
      w.redo = null;
      continue;
    }
    if (next.op.t === "sys.restore") continue;
    // Ana's own steps go on her stack, the DM's on the DM's, and anything else in the room leaves Ana's step to its guards.
    if (next.who.role === "player") {
      // Only a move, climb or resize goes on her stack as a step its undo puts back (shared/protocol.ts isPoseOp).
      w.ana = isPoseOp(next.op) ? anaStep(before, next.op, applied) : null;
      w.fresh = w.ana !== null;
      w.redo = null;
    } else if (applied.inverse) {
      w.undo.push(applied.inverse);
    }
  }
}

test("openings, falls and trapdoors keep their invariants over random sequences", () => {
  const counts = counted();
  const start = startRoom();
  assert.equal(floorProblem(start, GROUND), null, "the tower starts whole");
  fc.assert(
    fc.property(fc.array(ACT, { minLength: 5, maxLength: 40 }), (acts) => play(start, acts, counts)),
    { numRuns: Number(process.env.OPENINGS_RUNS ?? 3000), seed: Number(process.env.OPENINGS_SEED ?? 2611191) },
  );
  if (process.env.OPENINGS_COUNTS) console.log(JSON.stringify(counts));
  // The sequences reach what they test.
  assert.ok(counts.falls > 3000, `${counts.falls} cards made`);
  assert.ok(counts.records > 2500, `${counts.records} fall records`);
  assert.ok(counts.flights > 150, `${counts.flights} flights`);
  assert.ok(counts.drops > 600, `${counts.drops} trapdoor drops`);
  assert.ok(counts.anaUndos > 250, `${counts.anaUndos} undos of Ana's`);
  assert.ok(counts.cardsBack > 20, `${counts.cardsBack} cards a redo wrote back`);
  assert.ok(counts.overHeld > 0, `${counts.overHeld} creatures held up over a hole`);
});

test("a DM's undo of a delete that puts its creature's cards back keeps the room to FALLS_PER_ROOM", () => {
  // Found by the machine (seed 1): the goblin and the ogre fall, the DM deletes the goblin and its cards, Thorn falls, and the
  // DM's undo of the delete puts the goblin's cards back beside Thorn's.
  const acts: Act[] = [
    { k: "many", link: 0, dx: 0 },
    { k: "delete", who: 9 },
    { k: "anaHole", who: 0, link: 0 },
    { k: "undo" },
  ];
  play(startRoom(), acts, counted());
});
