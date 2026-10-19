import { describe, test } from "node:test";
import { checkPair, type Drag, type Pair } from "./differential.ts";
import { chunkKey } from "./keys.ts";
import type { BuildChunk, EdgeFeature, RoomState, TerrainId } from "./model.ts";
import { DM, P1, actor, deepClone, effect, entry, reveal, room, template, token } from "./testutil.ts";

/**
 * Movement's generators for the shared differential test
 * (docs/design-v1-movement.md 12, "Public determinism"): each a pair of
 * rooms that differ only in what players cannot see, with the same drags
 * by the DM and by a player, through a room cut by a wall along x = 6 that
 * leaves a gap below y = 12. The hero is P1's, the goblin the DM's.
 *
 * Attach's generators (hidden holders, dragged and carried creatures,
 * passengers) join when attached tokens are built.
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
