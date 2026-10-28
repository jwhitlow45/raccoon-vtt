import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkOps, checkPair, type Drag, type OpPair, type Pair, type Step } from "./differential.ts";
import { chunkKey } from "./keys.ts";
import type { AttachKind, BuildChunk, EdgeFeature, RoomState, TerrainId, Token } from "./model.ts";
import type { Op } from "./protocol.ts";
import { getOffSpot, overlaps, seatSpot } from "./rules/attach.ts";
import { projectState } from "./project.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, actor, deepClone, effect, entry, env, reveal, room, template, token } from "./testutil.ts";
import { SQUARES } from "./rules/grid.ts";

/**
 * Movement's generators for the shared differential test
 * (docs/design-v1-movement.md 12, "Public determinism"): each a pair of
 * rooms that differ only in what players cannot see, with the same drags
 * by the DM and by a player, through a room cut by a wall along x = 6 that
 * leaves a gap below y = 12. The hero is P1's, the goblin the DM's.
 *
 * Attach's generators (hidden holders, dragged and carried creatures,
 * passengers) follow movement's, below.
 */

const WALL: EdgeFeature = { kind: "wall" };

function edges(extra: Record<string, EdgeFeature> = {}): Record<string, EdgeFeature> {
  const out: Record<string, EdgeFeature> = {};
  for (let y = 0; y < 12; y++) out[`6,${y},w`] = WALL;
  return { ...out, ...extra };
}

function chunk(cells: Record<string, TerrainId> = {}, extra: Record<string, EdgeFeature> = {}, rough?: string): BuildChunk {
  return { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells, edges: edges(extra), ...(rough ? { rough } : {}) };
}

function base(): RoomState {
  const state = room();
  // Painted terrain beside unpainted ground raises walls of its own (rules/autoWalls.ts), and walls are walls to every device, fog or not: off, so a pair differs only in the terrain.
  state.scenes.s1 = { ...state.scenes.s1!, blockMovement: true, autoWalls: "off" };
  state.tokens.hero = token("hero", { kind: "pc", name: "Hero", disposition: "ally", ownerIds: ["p1"], x: 2, y: 5 });
  state.tokens.gob = token("gob", { x: 2, y: 8 });
  state.buildChunks[chunkKey("s1", 0, 0)] = chunk();
  return state;
}

/** Both rooms from one, the second changed only where players cannot see. */
function pair(name: string, setup: (s: RoomState) => void, hidden: (s: RoomState) => void, drags: readonly Drag[] = everyone, unshown?: Pair["unshown"]): Pair {
  const a = base();
  setup(a);
  const b = deepClone(a);
  hidden(b);
  return { name, a, b, drags, ...(unshown ? { unshown } : {}) };
}

const heroAcross: Drag = { who: P1, tokenId: "hero", to: { x: 9, y: 5 } };
const dmHeroAcross: Drag = { who: DM, tokenId: "hero", to: { x: 9, y: 5 } };
const dmGoblinAcross: Drag = { who: DM, tokenId: "gob", to: { x: 9, y: 8 } };
const everyone = [heroAcross, dmHeroAcross, dmGoblinAcross];
/** On fogged ground only drags that keep to it: a player's, and the DM's of a party member. A DM's other drags read the fogged map by design. */
const partyOnly = [heroAcross, dmHeroAcross];

/** Fog on and the scene revealed but for a dark patch in the gap, where the walk around the wall would go. */
function fogged(s: RoomState): void {
  s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: true };
  reveal(s, "s1", { x: 0, y: 0, w: 40, h: 12 });
  reveal(s, "s1", { x: 0, y: 12, w: 5, h: 2 });
  reveal(s, "s1", { x: 8, y: 12, w: 32, h: 2 });
  reveal(s, "s1", { x: 0, y: 14, w: 40, h: 16 });
}

const PATCH = ["5,12", "6,12", "7,12", "5,13", "6,13", "7,13"];

function roughAt(cells: readonly string[]): string {
  const marks = new Array(256).fill(".");
  for (const key of cells) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    marks[y * 16 + x] = "d";
  }
  return marks.join("");
}

const PAIRS: Pair[] = [
  pair(
    "an unfound secret door in the wall",
    () => {},
    (s) => {
      s.buildChunks[chunkKey("s1", 0, 0)] = chunk({}, { "6,5,w": { kind: "door", state: "closed", secret: true, discovered: false } });
    },
  ),
  pair(
    "an unfound secret door left open beside Plant Growth",
    (s) => {
      s.buildChunks[chunkKey("s1", 0, 0)] = chunk({}, { "6,5,w": { kind: "door", state: "closed", secret: true, discovered: false } });
      s.templates.pg = template("pg", { shape: "sphere", size: 15, origin: { x: 5, y: 5, z: 0 }, ownerId: "dm1", slows: { kind: "quarter" } });
    },
    (s) => {
      s.buildChunks[chunkKey("s1", 0, 0)] = chunk({}, { "6,5,w": { kind: "door", state: "open", secret: true, discovered: false } });
    },
  ),
  pair("fogged rubble", fogged, (s) => {
    s.buildChunks[chunkKey("s1", 0, 0)] = chunk(Object.fromEntries(PATCH.map((k) => [k, "rubble" as TerrainId])));
  }, partyOnly, ["buildChunks"]),
  pair("fogged difficult ground marks", fogged, (s) => {
    s.buildChunks[chunkKey("s1", 0, 0)] = chunk({}, {}, roughAt(PATCH));
  }, partyOnly, ["buildChunks"]),
  pair("fogged pits", fogged, (s) => {
    s.buildChunks[chunkKey("s1", 0, 0)] = chunk(Object.fromEntries(PATCH.map((k) => [k, "pit" as TerrainId])));
  }, partyOnly, ["buildChunks"]),
  pair(
    "fogged rubble under a monster the hero rides, whose drag keeps to ground players have seen (docs/design-v1-attach.md 9)",
    (s) => {
      fogged(s);
      s.tokens.gob = { ...s.tokens.gob!, size: "large" };
      s.tokens.hero = { ...s.tokens.hero!, x: 2, y: 8, attached: { to: "gob", kind: "ride" } };
    },
    (s) => {
      s.buildChunks[chunkKey("s1", 0, 0)] = chunk(Object.fromEntries(PATCH.map((k) => [k, "rubble" as TerrainId])));
    },
    [dmGoblinAcross],
    ["buildChunks"],
  ),
  pair("a creature the DM hid in the gap", () => {}, (s) => {
    s.tokens.ogre = token("ogre", { name: "Ogre", x: 6, y: 12, visibility: "dm" });
  }),
  pair(
    "a creature the fog withholds in the gap",
    (s) => {
      s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: true };
      reveal(s, "s1", { x: 0, y: 0, w: 40, h: 12 });
    },
    (s) => {
      s.tokens.ogre = token("ogre", { name: "Ogre", x: 6, y: 12 });
    },
    [dmGoblinAcross],
  ),
  pair(
    "a creature's hidden HP",
    (s) => {
      s.tokens.ogre = token("ogre", { name: "Ogre", x: 6, y: 12, hpVisibility: "hidden" });
    },
    (s) => {
      s.tokens.ogre = { ...s.tokens.ogre!, actor: { inline: actor({ hp: { cur: 1, max: 20, temp: 0 } }) } };
    },
  ),
  pair("a DM-only area of difficult terrain in the gap", () => {}, (s) => {
    s.templates.web = template("web", { shape: "cube", size: 10, origin: { x: 6, y: 13, z: 0 }, visibility: "dm", ownerId: "dm1", slows: { kind: "difficult" } });
  }),
  pair(
    "another player's area players do not receive",
    (s) => {
      s.meta = { ...s.meta, settings: { ...s.meta.settings, playersSeeAoeOfOthers: false } };
    },
    (s) => {
      s.templates.web = template("web", { shape: "cube", size: 10, origin: { x: 6, y: 13, z: 0 }, ownerId: "p2", slows: { kind: "difficult" } });
    },
    [heroAcross, dmGoblinAcross],
  ),
  pair(
    "an area for the caster's enemies whose caster is hidden",
    (s) => {
      s.tokens.druid = token("druid", { name: "Druid", disposition: "hostile", x: 20, y: 20, visibility: "dm" });
      s.tokens.sage = token("sage", { name: "Sage", disposition: "ally", x: 22, y: 20, visibility: "dm" });
      s.templates.elementals = template("elementals", { shape: "sphere", size: 10, origin: { x: 6.5, y: 13.5, z: 0 }, ownerId: "dm1", casterId: "druid", slows: { kind: "difficult", foes: true } });
    },
    (s) => {
      s.templates.elementals = { ...s.templates.elementals!, casterId: "sage" };
    },
  ),
  pair("a hidden Prone", () => {}, (s) => {
    s.tokens.gob = { ...s.tokens.gob!, actor: { inline: actor({ effects: [effect("e1", { key: "prone", hiddenFromPlayers: true })] }) } };
  }, [dmGoblinAcross]),
  pair(
    "a monster's private Swim Speed through water",
    (s) => {
      s.buildChunks[chunkKey("s1", 0, 0)] = chunk(Object.fromEntries(["3,8", "4,8", "5,8", "3,9", "4,9", "5,9"].map((k) => [k, "water" as TerrainId])));
    },
    (s) => {
      s.tokens.gob = { ...s.tokens.gob!, actor: { inline: actor({ speeds: { walk: 30, swim: 30 } }) } };
    },
    [dmGoblinAcross],
  ),
  pair(
    "a player drags a monster they may move but do not own, its Prone hidden and its Swim Speed private",
    (s) => {
      s.meta = { ...s.meta, settings: { ...s.meta.settings, playersMoveAny: "all" } };
      s.buildChunks[chunkKey("s1", 0, 0)] = chunk(Object.fromEntries(["3,8", "4,8", "5,8", "3,9", "4,9", "5,9"].map((k) => [k, "water" as TerrainId])));
    },
    (s) => {
      s.tokens.gob = { ...s.tokens.gob!, actor: { inline: actor({ speeds: { walk: 30, swim: 30 }, effects: [effect("e1", { key: "prone", hiddenFromPlayers: true })] }) } };
    },
    [{ who: P1, tokenId: "gob", to: { x: 9, y: 8 } }, dmGoblinAcross],
  ),
  pair(
    "a creature the party's sight withholds in the gap, the fog lifted everywhere",
    (s) => {
      s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: true, vision: { on: true, light: "bright" } };
      reveal(s, "s1", { x: 0, y: 0, w: 40, h: 30 });
    },
    (s) => {
      // Behind the wall from the hero, though the fog is lifted there, and in the goblin's way round it: neutral, so it would block a hostile goblin.
      s.tokens.ogre = token("ogre", { name: "Ogre", disposition: "neutral", x: 7, y: 12 });
    },
    // The hero stays put, so what the party sees stays the same.
    [dmGoblinAcross],
  ),
  pair(
    "earlier legs of the turn unseen by others that took other diagonals",
    (s) => {
      s.meta = { ...s.meta, settings: { ...s.meta.settings, diagonal: "fiveTen" } };
      s.encounter = {
        rev: 0,
        round: 1,
        activeEntryId: "n1",
        entries: [entry("n1", { tokenId: "gob", value: 15 }), entry("n2", { tokenId: "hero", value: 5 })],
        turnStart: { entryId: "n1", tokenId: "gob", sceneId: "s1", x: 0, y: 8, elevation: 0, seen: true, seq: 2 },
      };
      const walked = { moved: 5, cost: 5 };
      s.tokens.gob = {
        ...s.tokens.gob!,
        x: 2,
        y: 9,
        path: { turn: 2, stops: [{ x: 0, y: 8, elevation: 0, seen: true }, { x: 1, y: 8, elevation: 0, ...walked }, { x: 2, y: 8, elevation: 0, ...walked }, { x: 2, y: 9, elevation: 0, seen: true, ...walked }] },
      };
    },
    (s) => {
      // Where nobody but the DM saw, it took one diagonal instead of none.
      const stops = s.tokens.gob!.path!.stops;
      s.tokens.gob = { ...s.tokens.gob!, path: { turn: 2, stops: [stops[0]!, { x: 1, y: 9, elevation: 0, moved: 5, cost: 5, diag: [1, 0] }, stops[3]!] } };
    },
    [{ who: DM, tokenId: "gob", to: { x: 9, y: 9 } }],
  ),
];

describe("public determinism: movement's generators (contract section 5)", () => {
  for (const p of PAIRS) {
    test(p.name, () => checkPair(p));
  }
});

/*
 * The log's rings (shared/logRings.ts): on the hero's turn, with the wall
 * taken down, a walk through Fog Cloud, which players see, and in one room
 * through a glyph hidden from them too, whose id sorts first, so its
 * reminder is written first. It counts with the DM's lines, so the cloud's
 * line and everything after it reach players with the same ids in both
 * rooms.
 */
const RING_PAIRS: Pair[] = [
  pair(
    "a walk through an area players see and one hidden from them",
    (s) => {
      s.buildChunks = {};
      s.encounter = {
        rev: 0,
        round: 1,
        activeEntryId: "n1",
        entries: [entry("n1", { tokenId: "hero", value: 15 })],
        turnStart: { entryId: "n1", tokenId: "hero", sceneId: "s1", x: 2, y: 5, elevation: 0, seen: true, seq: 2 },
      };
      s.templates.fog = template("fog", { shape: "sphere", size: 10, origin: { x: 4.5, y: 5.5, z: 0 }, spell: "Fog Cloud", ownerId: "dm1", triggers: ["enter"] });
      s.templates.aglyph = template("aglyph", { shape: "sphere", size: 10, origin: { x: 7.5, y: 15.5, z: 0 }, spell: "Glyph of Warding", visibility: "dm", ownerId: "dm1", triggers: ["enter"] });
    },
    (s) => {
      s.templates.aglyph = { ...s.templates.aglyph!, origin: { x: 7.5, y: 5.5, z: 0 } };
    },
    [heroAcross],
  ),
];

describe("public determinism: the log's rings (shared/logRings.ts)", () => {
  for (const p of RING_PAIRS) {
    test(p.name, () => {
      checkPair(p);
      // The pair tests something: the walk reminds of the cloud in both rooms, and of the glyph only in the second.
      const drag = applyOp(p.b, { t: "token.move", tokenId: "hero", x: 9, y: 5 }, P1, env(3));
      assert.ok(drag.ok);
      assert.deepEqual(drag.log.map((e) => e.data?.type === "area" && [e.id, e.data.templateId]), [["3:900000", "aglyph"], ["3:0", "fog"]]);
    });
  }
});

/*
 * Attached tokens' generators (docs/design-v1-attach.md 8.0): pairs of rooms
 * that differ only in hidden state, and never only in a link that carries a
 * visible token, which the carried-object reveal shows by design. Each pair
 * goes through the same steps in both rooms, made on the acting device's
 * own copy, and every player whose copy was the same before must see the
 * same answers, frames and copies throughout.
 *
 * The table: P1 plays Thorn (a PC at 4,6) and a warhorse (Large, at 4,4),
 * P2 plays Cora at 12,6, and the DM runs a goblin at 8,6. The scene stops
 * moves at a wall along x = 14 that leaves a gap below y = 10.
 */

function attachBase(): RoomState {
  const state = room();
  state.scenes.s1 = { ...state.scenes.s1!, blockMovement: true, autoWalls: "off" };
  const edges: Record<string, EdgeFeature> = {};
  for (let y = 0; y < 10; y++) edges[`14,${y},w`] = WALL;
  state.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges };
  state.tokens.thorn = token("thorn", { name: "Thorn", kind: "pc", disposition: "ally", ownerIds: ["p1"], x: 4, y: 6 });
  state.tokens.horse = token("horse", { name: "Warhorse", kind: "npc", size: "large", disposition: "ally", ownerIds: ["p1"], x: 4, y: 4, actor: { inline: actor({ speeds: { walk: 60 } }) } });
  state.tokens.cora = token("cora", { name: "Cora", kind: "pc", disposition: "ally", ownerIds: ["p2"], x: 12, y: 6 });
  state.tokens.gob = token("gob", { name: "Goblin", x: 8, y: 6 });
  return state;
}

function attachPair(name: string, setup: (s: RoomState) => void, hidden: (s: RoomState) => void, steps: readonly Step[], unshown?: OpPair["unshown"]): OpPair {
  const a = attachBase();
  setup(a);
  const b = deepClone(a);
  hidden(b);
  return { name, a, b, steps, ...(unshown ? { unshown } : {}) };
}

/** Thorn's turn of a fight with rows for Thorn, the goblin and the horse, as two DM steps. */
const fightSteps: Step[] = [
  { who: DM, op: { t: "encounter.start", entries: [{ id: "et", tokenId: "thorn", value: 20 }, { id: "eg", tokenId: "gob", value: 12 }, { id: "eh", tokenId: "horse", value: 8 }] }, note: "start" },
  { who: DM, op: { t: "encounter.next" }, note: "Thorn's turn" },
];

/** An attach as the bar makes it from the device's copy: the seat nearest the carried token, or where a dragged one stands. */
function attachFrom(carried: string, holder: string, kind: AttachKind, steer = false): (view: RoomState) => Op | null {
  return (view) => {
    const c = view.tokens[carried];
    const h = view.tokens[holder];
    if (!c || !h) return null;
    const seat = kind === "drag" ? { x: c.x, y: c.y } : seatSpot(SQUARES, c, h);
    if (!seat) return null;
    return { t: "token.attach", tokenId: carried, to: holder, kind, ...(steer ? { steer: true as const } : {}), x: seat.x, y: seat.y, elevation: kind === "drag" ? c.elevation : h.elevation };
  };
}

/** Get off as the bar finds its place: the first spot beside the holder on no creature the copy holds. */
function getOffFrom(carried: string): (view: RoomState) => Op | null {
  return (view) => {
    const c = view.tokens[carried];
    const h = c?.attached ? view.tokens[c.attached.to] : undefined;
    const scene = c ? view.scenes[c.sceneId] : undefined;
    if (!c || !h || !scene) return null;
    const others = Object.values(view.tokens).filter((t) => t.id !== c.id && t.id !== h.id && t.sceneId === c.sceneId && t.kind !== "object");
    const spot = getOffSpot(SQUARES, view.meta.settings, scene.bounds, c, h, (p) => !others.some((t) => overlaps(SQUARES, { ...c, x: p.x, y: p.y }, t)));
    return spot ? { t: "token.detach", tokenId: carried, x: spot.x, y: spot.y } : null;
  };
}

const moveHorse = (x: number, y: number, who = P1): Step => ({ who, op: { t: "token.move", tokenId: "horse", x, y }, note: `horse to ${x},${y}` });
const moveThorn = (x: number, y: number, who = P1): Step => ({ who, op: { t: "token.move", tokenId: "thorn", x, y }, note: `Thorn to ${x},${y}` });
const nudgeBoth: Step = { who: P1, op: { t: "token.moveMany", moves: [{ tokenId: "horse", x: 5, y: 4 }, { tokenId: "thorn", x: 5, y: 6 }] }, note: "two destinations" };
const rideHorse: Step = { who: P1, op: attachFrom("thorn", "horse", "ride", true), note: "Thorn rides, controlled" };
const rideFree: Step = { who: P1, op: attachFrom("thorn", "horse", "ride"), note: "Thorn rides, independent" };
const getOff: Step = { who: P1, op: getOffFrom("thorn"), note: "Thorn gets off" };
const doesntCount: Step = { who: P1, op: { t: "token.countLeg", tokenId: "thorn", counts: false }, note: "Doesn't count" };
const counts: Step = { who: P1, op: { t: "token.countLeg", tokenId: "thorn", counts: true }, note: "counts again" };
const next: Step = { who: DM, op: { t: "encounter.next" }, note: "Next" };
const endTurn: Step = { who: P1, op: (view) => ({ t: "encounter.next", from: { entry: view.encounter?.activeEntryId ?? null, round: view.encounter?.round ?? 0 } }), note: "End turn" };

/** A hidden creature of the DM's on a token, by a link of this kind. */
function hiddenOn(s: RoomState, id: string, to: string, kind: AttachKind, extra: Partial<Token> = {}): void {
  const holder = s.tokens[to]!;
  const size = extra.size ?? (kind === "perch" ? "tiny" : "medium");
  const at = kind === "drag" ? { x: holder.x - 1, y: holder.y } : { x: holder.x, y: holder.y };
  s.tokens[id] = token(id, { name: "Shade", size, ...at, elevation: holder.elevation, visibility: "dm", attached: { to, kind }, ...extra });
}

/** A torch of P1's beside Thorn, which every player sees. */
function torch(s: RoomState): void {
  s.tokens.torch = token("torch", { name: "Torch", kind: "object", size: "tiny", ownerIds: ["p1"], x: 5, y: 6.5 });
}

const grappled = (s: RoomState, hidden: boolean) => {
  s.tokens.gob = { ...s.tokens.gob!, x: 5, y: 7, actor: { inline: actor({ effects: [effect("g", { key: "grappled", ...(hidden ? { hiddenFromPlayers: true } : {}) })] }) } };
};

const ATTACH_PAIRS: OpPair[] = [
  attachPair("a hidden rider on a visible mount", () => {}, (s) => hiddenOn(s, "shade", "horse", "ride"), [
    ...fightSteps,
    rideHorse,
    moveHorse(8, 4),
    doesntCount,
    counts,
    { who: DM, op: { t: "token.move", tokenId: "horse", x: 9, y: 4 }, note: "the DM's drag" },
    getOff,
    moveThorn(9, 6),
    rideFree,
    moveHorse(10, 2),
    nudgeBoth,
    { who: P1, op: { t: "token.detach", tokenId: "thorn" }, note: "a refused Put down" },
    endTurn,
    { who: P1, op: attachFrom("thorn", "horse", "ride", true), note: "a ride off Thorn's turn" },
  ]),
  attachPair(
    "a hidden passenger under a visible holder",
    (s) => {
      torch(s);
      s.tokens.gob = { ...s.tokens.gob!, x: 4, y: 7 };
    },
    (s) => hiddenOn(s, "imp", "thorn", "perch"),
    [
      ...fightSteps,
      { who: P1, op: attachFrom("gob", "thorn", "drag"), note: "a drag refused without Grappled" },
      { who: P1, op: attachFrom("torch", "thorn", "carry"), note: "Carry the torch" },
      rideHorse,
      moveHorse(8, 2),
      nudgeBoth,
      { who: P1, op: (v) => (v.tokens.thorn?.attached ? getOffFrom("thorn")(v) : { t: "token.move", tokenId: "thorn", x: 7, y: 6 }), note: "Thorn steps down" },
      moveThorn(16, 12),
      { who: P1, op: { t: "token.detach", tokenId: "torch" }, note: "Put down the torch" },
    ],
  ),
  attachPair(
    "a passenger hidden from every player but its own player",
    () => {},
    (s) => {
      s.tokens.owl = token("owl", { name: "Owl", kind: "npc", size: "tiny", ownerIds: ["p2"], x: 4.5, y: 4.5, visibility: "dm", attached: { to: "horse", kind: "perch" } });
    },
    [...fightSteps, rideHorse, moveHorse(8, 4), nudgeBoth, getOff, endTurn],
  ),
  attachPair(
    "a hidden token between a visible holder and a hidden-from-others chain end",
    () => {},
    (s) => {
      hiddenOn(s, "shade", "horse", "ride");
      s.tokens.owl = token("owl", { name: "Owl", kind: "npc", size: "tiny", ownerIds: ["p2"], x: 4.5, y: 4.5, visibility: "dm", attached: { to: "shade", kind: "perch" } });
    },
    [...fightSteps, rideHorse, moveHorse(8, 4), moveHorse(8, 8), getOff, endTurn],
  ),
  attachPair(
    "a hidden dragged creature",
    (s) => grappled(s, false),
    (s) => hiddenOn(s, "rat", "thorn", "drag", { size: "small", y: 5 }),
    [
      ...fightSteps,
      { who: P1, op: attachFrom("gob", "thorn", "drag"), note: "Drag the goblin" },
      moveThorn(10, 6),
      // Past the wall's gap Thorn and the goblin walk free, while the rat, a row up, meets the wall unseen.
      { who: P1, op: { t: "token.move", tokenId: "thorn", x: 16, y: 10, route: [[12, 10, 0, 0], [16, 10, 0, 0]] }, note: "round the wall" },
      moveThorn(17, 10),
      { who: P1, op: { t: "token.detach", tokenId: "gob" }, note: "Let go of the goblin" },
    ],
  ),
  attachPair(
    "a hidden Grappled effect",
    (s) => (s.tokens.gob = { ...s.tokens.gob!, x: 5, y: 7 }),
    (s) => grappled(s, true),
    [
      ...fightSteps,
      { who: P1, op: attachFrom("gob", "thorn", "drag"), note: "Drag the goblin" },
      { who: P1, op: attachFrom("gob", "thorn", "carry"), note: "Carry the goblin" },
    ],
  ),
  attachPair(
    "hidden passengers that would pass a limit",
    () => {},
    (s) => {
      for (let i = 0; i < 8; i++) hiddenOn(s, `imp${i}`, "horse", "perch", { name: "Imp", x: 4 + (i % 4) * 0.5, y: 4 + Math.floor(i / 4) * 0.5 });
    },
    [...fightSteps, rideHorse, moveHorse(8, 4), getOff],
  ),
  attachPair(
    "a hidden row beside a mount's row",
    () => {},
    (s) => {
      s.tokens.lurker = token("lurker", { name: "Lurker", x: 30, y: 20, visibility: "dm" });
    },
    [
      { who: DM, op: { t: "encounter.start", entries: [{ id: "et", tokenId: "thorn", value: 20 }, { id: "eg", tokenId: "gob", value: 12 }, { id: "eh", tokenId: "horse", value: 8 }] } },
      { who: DM, op: (_v, state) => (state.tokens.lurker ? { t: "encounter.add", entries: [{ id: "el", tokenId: "lurker", value: 9, hidden: true }] } : { t: "encounter.update", entryId: "eh", patch: { inLair: false } }), note: "a hidden row joins in one room" },
      next,
      rideHorse,
      moveHorse(8, 4),
      doesntCount,
      counts,
      // The horse's row now goes right after Thorn's, and marks time.
      endTurn,
      next,
    ],
  ),
  attachPair(
    "a creature the fog withholds inside a group",
    (s) => {
      s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: true };
      reveal(s, "s1", { x: 4, y: 0, w: 36, h: 30 });
    },
    (s) => {
      s.tokens.wolf = token("wolf", { name: "Wolf", x: 3, y: 4, attached: { to: "horse", kind: "drag" } });
    },
    // The wolf walks in the fog's column, so it stays withheld.
    [...fightSteps, rideHorse, moveHorse(4, 8), moveHorse(4, 12), getOff, endTurn],
  ),
  attachPair(
    "a hidden rider's mounting in a fight, whose own row stands elsewhere in each room",
    (s) => {
      s.meta.settings = { ...s.meta.settings, revealHiddenOnTurn: false };
      s.tokens.shade = token("shade", { name: "Shade", x: 3, y: 4, visibility: "dm" });
    },
    // The second room's shade, which no player sees, rolled low.
    (s) => (s.tokens.shade = { ...s.tokens.shade!, name: "Slow shade" }),
    [
      {
        who: DM,
        op: (view) => {
          const value = view.tokens.shade?.name === "Slow shade" ? 5 : 15;
          return { t: "encounter.start", entries: [{ id: "et", tokenId: "thorn", value: 20 }, { id: "es", tokenId: "shade", value, hidden: true }, { id: "eg", tokenId: "gob", value: 12 }, { id: "eh", tokenId: "horse", value: 8 }] };
        },
        note: "start",
      },
      next,
      // The DM puts the hidden shade on the horse, controlled: the horse's row stays where the table sees it.
      { who: DM, op: { t: "token.attach", tokenId: "shade", to: "horse", kind: "ride", steer: true, x: 4, y: 4, elevation: 0 }, note: "the DM's hidden ride" },
      moveHorse(8, 4),
    ],
  ),
  attachPair(
    "a rider whose visibility flips during the round",
    (s) => {
      s.meta.settings = { ...s.meta.settings, revealHiddenOnTurn: false };
      s.tokens.shade = token("shade", { name: "Shade", x: 30, y: 20, visibility: "dm" });
    },
    (s) => {
      // A controlled ride no player sees: its turn starting hidden shares nothing.
      s.tokens.shade = { ...s.tokens.shade!, x: 4, y: 4, attached: { to: "horse", kind: "ride", steer: true } };
    },
    [
      { who: DM, op: { t: "encounter.start", entries: [{ id: "et", tokenId: "thorn", value: 20 }, { id: "es", tokenId: "shade", value: 15, hidden: true }, { id: "eg", tokenId: "gob", value: 12 }, { id: "eh", tokenId: "horse", value: 8 }] } },
      next,
      rideHorse,
      moveHorse(8, 4),
      { who: DM, op: { t: "token.update", tokenId: "thorn", patch: { visibility: "dm" } }, note: "the DM hides Thorn" },
      moveHorse(8, 8),
      endTurn,
      // Into the hidden shade's turn, on which the DM moves the horse.
      next,
      { who: DM, op: { t: "token.move", tokenId: "horse", x: 12, y: 8 }, note: "the DM moves the horse on the hidden turn" },
      next,
      next,
      // Round 2, Thorn's turn starts while he is hidden: the horse shares nothing.
      { who: DM, op: { t: "token.update", tokenId: "thorn", patch: { visibility: "all" } }, note: "the DM shows Thorn" },
      moveHorse(12, 12),
      endTurn,
      next,
      next,
      next,
      // Round 3: seen by all again, the turn starts shared.
      moveHorse(12, 16),
    ],
  ),
];

describe("public determinism: attached tokens' generators (docs/design-v1-attach.md 8.0)", () => {
  for (const p of ATTACH_PAIRS) test(p.name, () => void checkOps(p));
});

describe("the carried-object reveal (docs/design-v1-attach.md 8.0)", () => {
  /** A torch every player sees, on a hidden stalker in one room and loose where it stands in the other. */
  function rooms(): { a: RoomState; b: RoomState } {
    const a = attachBase();
    a.tokens.stalker = token("stalker", { name: "Stalker", x: 8, y: 2, visibility: "dm" });
    a.tokens.torch = token("torch", { name: "Torch", kind: "object", size: "tiny", x: 8.5, y: 2.5 });
    const b = deepClone(a);
    b.tokens.torch = { ...b.tokens.torch!, attached: { to: "stalker", kind: "carry" } };
    return { a, b };
  }

  test("the torch follows its hidden holder exactly in the room with the link, and no link reaches players", () => {
    const { a, b } = rooms();
    const op: Op = { t: "token.move", tokenId: "stalker", x: 12, y: 3 };
    const after = (state: RoomState) => {
      const r = applyOp(state, op, DM, env(5));
      assert.ok(r.ok);
      return r.state;
    };
    assert.deepEqual([after(a).tokens.torch!.x, after(a).tokens.torch!.y], [8.5, 2.5]);
    assert.deepEqual([after(b).tokens.torch!.x, after(b).tokens.torch!.y], [12.5, 3.5]);
    for (const p of [P1, P2]) {
      const copy = projectState(after(b), p, { sceneId: "s1" }).tokens.torch as Token | undefined;
      assert.equal(copy?.attached, undefined, `${p.memberId} gets no link`);
      assert.deepEqual([copy?.x, copy?.y], [12.5, 3.5]);
    }
  });

  test("every refusal, limit and answer is the same in both rooms", () => {
    const { a, b } = rooms();
    const torchTo = (to: string, kind: AttachKind): Step => ({ who: P1, op: attachFrom("torch", to, kind), note: `torch on ${to}` });
    const steps: Step[] = [
      { who: P1, op: { t: "token.move", tokenId: "torch", x: 9, y: 2 }, note: "not theirs to move" },
      { who: P1, op: { t: "token.detach", tokenId: "torch" }, note: "not attached in their copy" },
      { who: DM, op: { t: "room.update", settings: { playersMoveAny: "all" } } },
      torchTo("thorn", "carry"),
      { who: P1, op: { t: "token.move", tokenId: "torch", x: 5, y: 6.5 }, note: "beside Thorn" },
      torchTo("thorn", "carry"),
      { who: P1, op: { t: "token.move", tokenId: "thorn", x: 6, y: 6 }, note: "Thorn carries it off" },
      { who: P1, op: { t: "token.detach", tokenId: "torch" }, note: "Put down" },
    ];
    // The torch's link differs by design, so its copy is left out of the comparison until it moves off the stalker.
    checkOps({ name: "the reveal's answers", a, b, steps });
  });
});

/*
 * Traps' generators (docs/design-v1-traps.md 7): pairs of rooms that differ
 * only in hidden state, on attach's table, with unfound traps players never
 * receive. What a trap does that players observe (stops, found marks,
 * players' lines, refusals) must read only creatures and links seen by all,
 * so every player whose copy was the same before sees the same answers,
 * frames and copies, the players' trap lines among them. In the DM's own
 * ops the pairs may differ only by a hidden springing's actions, the third
 * listed reveal, so those pairs leave the build out of the comparison.
 */

type TrapRigOver = Partial<NonNullable<import("./model.ts").Trap["rig"]>>;

function trapOn(s: RoomState, id: string, zone: import("./model.ts").TrapZone, over: TrapRigOver = {}, extra: Partial<import("./model.ts").Trap> = {}): void {
  s.traps[id] = {
    id,
    rev: 0,
    sceneId: "s1",
    name: id,
    zone,
    state: "armed",
    found: false,
    rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false, message: "Click.", damage: [{ formula: "1d6", type: "fire" }], ...over },
    ...extra,
  };
}

const cells = (x: number, y: number, w = 1, h = 1) => ({ cells: [{ x, y, w, h }] });
/** A plate on Thorn's row, which stops him in both rooms. */
const plateOnRow = (s: RoomState) => trapOn(s, "plate", cells(9, 6));

function trapPair(name: string, setup: (s: RoomState) => void, hidden: (s: RoomState) => void, steps: readonly Step[], unshown?: OpPair["unshown"]): OpPair {
  return attachPair(name, setup, hidden, steps, unshown);
}

const thornAcross: Step = { who: P1, op: { t: "token.move", tokenId: "thorn", x: 13, y: 6 }, note: "Thorn across" };
const thornBack: Step = { who: P1, op: { t: "token.move", tokenId: "thorn", x: 4, y: 6 }, note: "Thorn back" };
const lurker = (x: number, y: number, extra: Partial<Token> = {}) => (s: RoomState) => {
  s.tokens.lurker = token("lurker", { name: "Lurker", x, y, visibility: "dm", ...extra });
};

const TRAP_PAIRS: OpPair[] = [
  trapPair(
    "a hidden creature dragged in Thorn's group crosses a trap only it reaches",
    (s) => {
      plateOnRow(s);
      trapOn(s, "snare", cells(7, 7), { stops: false, message: "Snap." });
    },
    // Dragged just below Thorn, so the snare on its row is the shade's alone.
    (s) => hiddenOn(s, "shade", "thorn", "drag", { x: 4, y: 7 }),
    [thornAcross, thornBack, thornAcross],
  ),
  trapPair(
    "a hidden rider on Thorn's warhorse as it crosses a trap that catches riders",
    (s) => trapOn(s, "net", cells(8, 4, 2, 2), { floor: false, hits: "zone" }),
    (s) => hiddenOn(s, "shade", "horse", "ride"),
    [moveHorse(12, 4), moveHorse(4, 4)],
  ),
  trapPair(
    "the mover's own familiar, hidden from the other players, walks over a trap the other room lacks",
    (s) => {
      plateOnRow(s);
      s.tokens.imp = token("imp", { name: "Imp", kind: "npc", size: "tiny", ownerIds: ["p1"], visibility: "dm", x: 4, y: 8 });
    },
    (s) => trapOn(s, "glyph", cells(8, 8), { message: "A glyph flares." }),
    [{ who: P1, op: { t: "token.moveMany", moves: [{ tokenId: "thorn", x: 13, y: 6 }, { tokenId: "imp", x: 12, y: 8 }] }, note: "both across" }],
  ),
  trapPair(
    "a hidden creature already on a trap Thorn also enters is in its hits in one room only",
    (s) => trapOn(s, "pit", cells(9, 5, 2, 3), { hits: "zone" }),
    (s) => lurker(10, 7)(s),
    [thornAcross],
  ),
  trapPair(
    "a hidden creature whose turn Thorn's End Turn starts stands on a plate in one room",
    (s) => {
      trapOn(s, "statue", cells(10, 2), { on: ["turnStart"], stops: false });
      lurker(2, 2)(s);
      // Revealed on its turn it would stand where every player sees it, which is no hidden difference.
      s.meta.settings.revealHiddenOnTurn = false;
    },
    (s) => (s.tokens.lurker = { ...s.tokens.lurker!, x: 10 }),
    [
      { who: DM, op: { t: "encounter.start", entries: [{ id: "et", tokenId: "thorn", value: 20 }, { id: "el", tokenId: "lurker", value: 12, hidden: true }, { id: "ec", tokenId: "cora", value: 8 }] }, note: "start" },
      { who: DM, op: { t: "encounter.next" }, note: "Thorn's turn" },
      endTurn,
      { who: DM, op: { t: "encounter.next" }, note: "Cora's turn" },
    ],
  ),
  trapPair(
    "a hidden lurker reaches the plate first in the DM's group move, beside the goblin",
    (s) => {
      trapOn(s, "plate", cells(10, 6, 1, 3));
      lurker(2, 8)(s);
    },
    (s) => (s.tokens.lurker = { ...s.tokens.lurker!, x: 9 }),
    [{ who: DM, op: { t: "token.moveMany", moves: [{ tokenId: "gob", x: 13, y: 6 }, { tokenId: "lurker", x: 13, y: 8 }] }, note: "both across" }, thornAcross],
  ),
  trapPair(
    "party vision and a hidden condition on Thorn",
    (s) => trapOn(s, "plate", cells(9, 6), { who: "party" }),
    (s) => {
      s.tokens.thorn = { ...s.tokens.thorn!, partyVision: true, actor: { inline: actor({ effects: [effect("x", { key: "poisoned", hiddenFromPlayers: true })] }) } };
    },
    [thornAcross],
  ),
  trapPair(
    "the DM's own fields of a trap: occurrences, who noticed it, both logs and a hidden springing before",
    plateOnRow,
    (s) => {
      const t = s.traps.plate!;
      const due = [{ id: "2:0", at: "2026-10-12T20:00:00.000Z", how: "enter" as const, by: ["gob"], hits: ["gob"], hidden: true as const }];
      s.traps.plate = { ...t, rig: { ...t.rig!, noticedBy: "cora", due } };
      s.trapLog = [{ id: "2:0", at: "2026-10-12T20:00:00.000Z", kind: "event", data: { type: "trap", trapId: "plate", sceneId: "s1", name: "plate", how: "enter", by: ["gob"], hits: 1, did: [], hidden: true } }];
    },
    [thornAcross, thornBack],
  ),
  trapPair(
    "a hidden goblin the DM walks over a plate that locks a door, in one room only",
    (s) => {
      const chunk = s.buildChunks[chunkKey("s1", 0, 0)]!;
      s.buildChunks[chunkKey("s1", 0, 0)] = { ...chunk, edges: { ...chunk.edges, "3,12,n": { kind: "door", state: "closed", secret: false, discovered: false } } };
      trapOn(s, "plate", cells(6, 12), { actions: [{ door: { edge: "3,12,n" }, state: "locked" }], message: "Click." });
      lurker(2, 13)(s);
    },
    (s) => (s.tokens.lurker = { ...s.tokens.lurker!, y: 12 }),
    [{ who: DM, op: { t: "token.move", tokenId: "lurker", x: 10, y: 12 }, note: "the DM's hidden drag" }, thornAcross],
    ["buildChunks", "scenes"],
  ),
  trapPair(
    "a silent stopping trap nobody found where Thorn was going, in one room only: his step keeps its Undo move in both",
    () => {},
    (s) => trapOn(s, "plate", cells(13, 6), { message: undefined, foundOnSpring: false }),
    [thornAcross, thornBack],
  ),
  trapPair(
    "Thorn walks into Grease beside a trap only one room has, which hints the DM before the area's reminder",
    (s) => {
      s.tokens.thorn = { ...s.tokens.thorn!, actor: { inline: actor({ passivePerception: 15 }) } };
      s.templates.grease = template("grease", { shape: "cube", size: 10, origin: { x: 12, y: 6, z: 0 }, spell: "Grease", triggers: ["enter"] });
    },
    // Two squares below where Thorn stops, off his path, so only its hint differs.
    (s) => trapOn(s, "wire", cells(13, 8), { notice: true, find: [{ ability: "wis", skill: "perception", dc: 10 }] }),
    [...fightSteps, thornAcross],
  ),
];

/**
 * A silent trap nobody found on Thorn's row, in one room only, whose action
 * changes nothing players see: it aims at what is already so, at a light,
 * which players see only through the party's sight, at a creature fog
 * still hides, or locks a door players see closed either way. His step's
 * Undo move must stay the same in both rooms (6.5).
 */
function unseenActionPair(what: string, setup: (s: RoomState) => void, actions: NonNullable<TrapRigOver["actions"]>): OpPair {
  return trapPair(`a silent trap only one room has ${what}: Thorn's step keeps its Undo move in both`, setup, (s) => trapOn(s, "alarm", cells(10, 6), { stops: false, message: undefined, foundOnSpring: false, actions }), [thornAcross, thornBack]);
}

const lampAt = (x: number, y: number, on: boolean) => (s: RoomState) => void (s.lights.lamp = { id: "lamp", rev: 0, sceneId: "s1", x, y, bright: 20, dim: 20, on, walls: true });

const UNSEEN_ACTION_PAIRS: OpPair[] = [
  unseenActionPair("puts out a light already out", lampAt(20, 20, false), [{ light: "lamp", on: false }]),
  unseenActionPair("lights a light already lit", lampAt(20, 20, true), [{ light: "lamp", on: true }]),
  unseenActionPair("lights a light far off", lampAt(35, 25, false), [{ light: "lamp", on: true }]),
  unseenActionPair("shows a creature everyone sees", () => {}, [{ show: { tokenId: "gob" } }]),
  unseenActionPair(
    "shows a hidden creature fog still covers",
    (s) => {
      s.scenes.s1 = { ...s.scenes.s1!, fogEnabled: true };
      reveal(s, "s1", { x: 0, y: 0, w: 40, h: 14 });
      lurker(25, 20)(s);
    },
    [{ show: { tokenId: "lurker" } }],
  ),
  unseenActionPair(
    "locks a door players see closed either way",
    (s) => {
      const chunk = s.buildChunks[chunkKey("s1", 0, 0)]!;
      s.buildChunks[chunkKey("s1", 0, 0)] = { ...chunk, edges: { ...chunk.edges, "3,12,n": { kind: "door", state: "closed", secret: false, discovered: false } } };
    },
    [{ door: { edge: "3,12,n" }, state: "locked" }],
  ),
];

describe("public determinism: traps' generators (docs/design-v1-traps.md 7)", () => {
  for (const p of UNSEEN_ACTION_PAIRS) test(p.name, () => void checkOps(p));
  for (const p of TRAP_PAIRS) test(p.name, () => void checkOps(p));
});
