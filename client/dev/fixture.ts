import { createInitialState } from "#shared/initial.ts";
import { wallChunk } from "#shared/keys.ts";
import type { Actor, BuildChunk, Character, CustomMonster, Effect, FogTile, FreeWall, Light, Member, RoomState, Scene, Token } from "#shared/model.ts";
import { TILE_SUB } from "#shared/rules/fog.ts";
import { encodeTileFrom } from "../lib/fogTiles.ts";
import { FIXTURE_MAP } from "./placeholders.ts";

/**
 * A room to look at in development (`/dev/room`), with no server: one
 * calibrated map scene with fog, a prep scene, tokens of every size, effects
 * that overflow, an elevation in each direction, a hidden token, a token
 * under the fog, a running encounter whose active creature has moved since
 * its turn began, and a little chat.
 *
 * Never imported by production code: App.tsx loads it behind
 * import.meta.env.DEV, so the build drops it. The page runs it through a
 * LocalServer (localServer.ts), so players see the real projection.
 */

const T0 = "2026-10-12T19:00:00.000Z";

export const FIXTURE_IDS = {
  dm: "m-dm",
  thorn: "m-thorn",
  vex: "m-vex",
  cave: "s-cave",
  crypt: "s-crypt",
  thornChar: "c-thorn",
  vexChar: "c-vex",
};

const member = (id: string, name: string, color: string, kind: Member["kind"]): Member => ({
  id,
  rev: 1,
  name,
  color,
  kind,
  createdAt: T0,
});

function actor(hp: [number, number, number?], effects: Partial<Effect>[] = [], patch: Partial<Actor> = {}): Actor {
  return {
    hp: { cur: hp[0], max: hp[1], temp: hp[2] ?? 0 },
    life: "alive",
    ac: 13,
    speeds: { walk: 30 },
    initBonus: 2,
    passivePerception: 12,
    senses: "",
    effects: effects.map((e, i) => ({ id: `e${i}`, key: "custom", ...e }) as Effect),
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "Secret DM note",
    ...patch,
  };
}

let nextToken = 0;
function token(patch: Partial<Token> & Pick<Token, "name" | "x" | "y" | "actor">): Token {
  nextToken++;
  return {
    id: `t-${String(nextToken).padStart(2, "0")}`,
    rev: 1,
    sceneId: FIXTURE_IDS.cave,
    kind: "monster",
    nameHidden: false,
    size: "medium",
    elevation: 0,
    rotation: 0,
    disposition: "hostile",
    visibility: "all",
    fogExempt: false,
    fogExemptAuto: false,
    locked: false,
    layer: "token",
    ownerIds: [],
    hpVisibility: "label",
    ...patch,
  };
}

/** Revealed sub-cells, in scene sub-cell coordinates: the party's rooms and a round clearing. */
function revealed(x: number, y: number): boolean {
  const cx = x / 4;
  const cy = y / 4;
  if (cx >= 1 && cx < 16 && cy >= 1 && cy < 13) return true;
  if (cx >= 15 && cx < 25 && cy >= 3 && cy < 13) return true;
  return Math.hypot(cx - 6, cy - 15.5) < 2.6;
}

function fogTiles(sceneId: string, bounds: { w: number; h: number }, mode: "normal" | "corrupt"): Record<string, FogTile> {
  const tiles: Record<string, FogTile> = {};
  const nx = Math.ceil(bounds.w / 16);
  const ny = Math.ceil(bounds.h / 16);
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      const bits =
        mode === "corrupt" ? "this is not a tile" : encodeTileFrom((sx, sy) => revealed(tx * TILE_SUB + sx, ty * TILE_SUB + sy));
      tiles[`${sceneId}:${tx},${ty}`] = { sceneId, tx, ty, rev: 1, bits };
    }
  }
  // A tile that cannot decode, where the reveal would otherwise show the
  // round clearing's lower edge: the gate must keep it fogged.
  if (mode === "normal") tiles[`${sceneId}:0,1`] = { sceneId, tx: 0, ty: 1, rev: 1, bits: "corrupt!" };
  return tiles;
}

export type FixtureOptions = { fog: "normal" | "off" | "corrupt" | "none"; blackout: boolean; areas?: boolean; walls?: boolean; text?: boolean; melee?: boolean };

export function createFixtureState(options: FixtureOptions): RoomState {
  nextToken = 0;
  // The color a new room gives its DM (server/auth/http.ts DM_COLOR).
  const dm = member(FIXTURE_IDS.dm, "DM", "#f7df00", "dm");
  const state = createInitialState({ roomName: "The Owlbear's Den", dm, now: T0 });

  state.members[FIXTURE_IDS.thorn] = member(FIXTURE_IDS.thorn, "Thorn", "#3e8ef7", "player");
  state.members[FIXTURE_IDS.vex] = member(FIXTURE_IDS.vex, "Vex", "#30a46c", "player");

  const cave: Scene = {
    id: FIXTURE_IDS.cave,
    rev: 1,
    name: "Owlbear cave",
    order: 0,
    bounds: { w: 30, h: 20 },
    map: { assetId: "fixture-map", ...FIXTURE_MAP },
    grid: { show: true, color: "#ffd27a", opacity: 0.35, lineWidth: 1 },
    background: "#1b1b20",
    fogEnabled: options.fog !== "off",
    wallsVersion: 0,
  };
  const crypt: Scene = {
    id: FIXTURE_IDS.crypt,
    rev: 1,
    name: "Prep: the crypt",
    order: 1,
    bounds: { w: 20, h: 20 },
    grid: { show: true, color: "#ffffff", opacity: 0.2, lineWidth: 1 },
    background: "#2b2b31",
    fogEnabled: false,
    wallsVersion: 0,
  };
  state.scenes = { [cave.id]: cave, [crypt.id]: crypt };
  state.meta.playerSceneId = cave.id;
  state.meta.view.blackout = options.blackout;
  if (options.fog === "normal" || options.fog === "corrupt") state.fogTiles = fogTiles(cave.id, cave.bounds, options.fog);

  const thornChar: Character = {
    id: FIXTURE_IDS.thornChar,
    rev: 1,
    ownerIds: [FIXTURE_IDS.thorn],
    name: "Thorn",
    size: "medium",
    defaultImage: { assetId: "fixture-thorn", crop: { cx: 0.5, cy: 0.5, zoom: 1 } },
    actor: actor([18, 24, 5], [{ key: "concentrating", spell: "Bless" }, { key: "blessed" }], { ac: 16 }),
  };
  const vexChar: Character = {
    id: FIXTURE_IDS.vexChar,
    rev: 1,
    ownerIds: [FIXTURE_IDS.vex],
    name: "Vex",
    size: "small",
    actor: actor([9, 21], [{ key: "flying" }], { ac: 14 }),
  };
  state.characters = { [thornChar.id]: thornChar, [vexChar.id]: vexChar };

  const list: Token[] = [
    token({
      name: "Thorn",
      kind: "pc",
      x: 5,
      y: 5,
      disposition: "ally",
      ownerIds: [FIXTURE_IDS.thorn],
      hpVisibility: "exact",
      image: { assetId: "fixture-thorn", crop: { cx: 0.5, cy: 0.5, zoom: 1 } },
      actor: { ref: thornChar.id },
    }),
    token({
      name: "Vex",
      kind: "pc",
      size: "small",
      x: 7,
      y: 7,
      elevation: 30,
      disposition: "ally",
      ownerIds: [FIXTURE_IDS.vex],
      hpVisibility: "exact",
      actor: { ref: vexChar.id },
    }),
    token({
      name: "Goblin",
      number: 1,
      x: 12,
      y: 6,
      image: { assetId: "fixture-goblin", crop: { cx: 0.5, cy: 0.5, zoom: 1.3 } },
      actor: { inline: actor([3, 7], [{ key: "poisoned" }, { key: "prone" }]) },
    }),
    token({
      name: "Goblin",
      number: 2,
      x: 13,
      y: 9,
      visibility: "dm",
      image: { assetId: "fixture-goblin", crop: { cx: 0.5, cy: 0.5, zoom: 1 } },
      actor: { inline: actor([7, 7]) },
    }),
    token({
      name: "Goblin",
      number: 3,
      x: 10,
      y: 10,
      image: { assetId: "fixture-goblin", crop: { cx: 0.5, cy: 0.5, zoom: 1 } },
      actor: { inline: actor([0, 7], [], { life: "dead" }) },
    }),
    token({
      name: "Owlbear",
      size: "large",
      x: 18,
      y: 9,
      hpVisibility: "bar",
      image: { assetId: "fixture-owlbear", crop: { cx: 0.5, cy: 0.5, zoom: 1 } },
      actor: {
        inline: actor([40, 59], [
          { key: "frightened" },
          { key: "restrained" },
          { key: "exhaustion", level: 2 },
          { key: "grappled" },
          { key: "custom", label: "Marked by Vex", glyph: "MV", color: "#0f766e" },
        ]),
      },
    }),
    token({
      name: "Rat",
      size: "tiny",
      x: 8.5,
      y: 11.5,
      disposition: "neutral",
      hpVisibility: "bar",
      actor: { inline: actor([1, 2]) },
    }),
    token({
      name: "Purple Worm",
      size: "gargantuan",
      x: 24,
      y: 14,
      elevation: -20,
      hpVisibility: "hidden",
      actor: { inline: actor([247, 247]) },
    }),
    token({
      name: "Treasure chest",
      kind: "object",
      layer: "object",
      x: 3,
      y: 2,
      disposition: "neutral",
      hpVisibility: "hidden",
      locked: true,
      actor: { inline: actor([10, 10]) },
    }),
    token({
      name: "Stone giant",
      nameHidden: true,
      publicName: "Huge figure",
      size: "huge",
      x: 21,
      y: 3,
      hpVisibility: "label",
      fogExempt: true,
      actor: { inline: actor([126, 126]) },
    }),
  ];
  state.tokens = Object.fromEntries(list.map((t) => [t.id, t]));

  const byName = (name: string, n?: number) => list.find((t) => t.name === name && t.number === n)!.id;
  state.encounter = {
    rev: 1,
    round: 2,
    activeEntryId: "i-thorn",
    entries: [
      { id: "i-thorn", tokenId: byName("Thorn"), value: 18, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false },
      { id: "i-gob1", tokenId: byName("Goblin", 1), value: 15, tieOrder: 0, groupKey: "goblin", hidden: false, reactionUsed: false, inLair: false },
      { id: "i-owl", tokenId: byName("Owlbear"), value: 12, tieOrder: 0, hidden: false, reactionUsed: true, inLair: false },
      { id: "i-vex", tokenId: byName("Vex"), value: 9, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false },
    ],
    turnStart: { entryId: "i-thorn", tokenId: byName("Thorn"), sceneId: cave.id, x: 2, y: 4, elevation: 0, seen: true, seq: 1 },
  };
  // Thorn's turn so far: two drops, which the trail draws and "Moved" adds up.
  state.tokens[byName("Thorn")]!.path = {
    turn: 1,
    stops: [
      { x: 2, y: 4, elevation: 0, seen: true },
      { x: 4, y: 3, elevation: 0, seen: true },
      { x: 5, y: 5, elevation: 0, seen: true },
    ],
  };
  state.log = [
    { id: "1:0", at: T0, kind: "chat", from: FIXTURE_IDS.thorn, text: "I hold the door." },
    { id: "2:0", at: T0, kind: "chat", from: FIXTURE_IDS.dm, text: "Something large shifts in the dark." },
    { id: "3:0", at: T0, kind: "whisper", from: FIXTURE_IDS.vex, to: [FIXTURE_IDS.dm], text: "Can I see the ceiling?" },
  ];
  state.monsters = { [MIRE_GLOOM.id]: MIRE_GLOOM };
  if (options.areas) {
    // Placed areas of the DM's and of Vex's, to see what a player who owns neither may do with them.
    const area = (id: string, ownerId: string, color: string, origin: { x: number; y: number }, yaw: number) => ({
      id,
      rev: 1,
      sceneId: cave.id,
      shape: "cone" as const,
      size: 30,
      origin: { ...origin, z: 0 },
      yaw,
      includeOrigin: false,
      color,
      ownerId,
      visibility: "all" as const,
    });
    state.templates = {
      "a-dm": area("a-dm", FIXTURE_IDS.dm, "#f38400", { x: 9, y: 6 }, 0),
      "a-vex": area("a-vex", FIXTURE_IDS.vex, "#a855f7", { x: 6, y: 9 }, 90),
    };
  }
  if (options.walls) {
    for (const chunk of freeWallChunks(cave.id)) state.buildChunks[`${chunk.sceneId}:${chunk.cx},${chunk.cy}`] = chunk;
    state.lights = fixtureLights(cave.id);
  }
  if (options.text) textStress(state);
  if (options.melee) meleeGuardians(state);
  return state;
}

/**
 * Board text at its worst (`text=1`): long names, one long word, six packed
 * kobolds, a pack of twenty goblin archers with one picture between them,
 * Large and Huge creatures, a long area name and a long map label.
 */
function textStress(state: RoomState): void {
  const list = Object.values(state.tokens);
  const find = (name: string, n?: number) => list.find((t) => t.name === name && t.number === n)!;
  find("Thorn").name = "Thorn Ironfoot";
  for (const n of [1, 2, 3]) find("Goblin", n).name = "Goblin Warrior";
  find("Owlbear").name = "Owlbear Matriarch of the Thornwood";
  const giant = find("Stone giant");
  giant.name = "Stone Giant Dreamwalker of the Frostfell Peaks";
  giant.publicName = "Huge figure looming in the dark";
  // A packed crowd in the party's room: six numbered kobolds two rows deep, and odd names beside them.
  const kobold = (n: number, x: number, y: number, effects: Partial<Effect>[] = [], elevation = 0) =>
    token({ name: "Kobold Scale Sorcerer", number: n, x, y, elevation, hpVisibility: "label", actor: { inline: actor([n === 2 ? 3 : 9, 9], effects) } });
  list.push(
    kobold(1, 2, 8, [{ key: "poisoned" }]),
    kobold(2, 3, 8),
    kobold(3, 4, 8, [], 10),
    kobold(4, 2, 9),
    kobold(5, 3, 9, [{ key: "prone" }, { key: "frightened" }]),
    kobold(6, 4, 9),
    token({ name: "Grand Inquisitor Malachar the Unrelenting, Scourge of the Seven Shattered Kingdoms", x: 6, y: 9, hpVisibility: "label", actor: { inline: actor([30, 30]) } }),
    token({ name: "Bartholomewsworthingtonshire", x: 7, y: 9, disposition: "neutral", hpVisibility: "label", actor: { inline: actor([5, 10]) } }),
    token({ name: "Aaaaaaarrrrrrrggggghhhhhhhhhhhhhhhhhhhhh", x: 13, y: 11, hpVisibility: "label", actor: { inline: actor([5, 10]) } }),
    token({ name: "Pip", x: 8, y: 9, disposition: "ally", kind: "npc", hpVisibility: "label", actor: { inline: actor([4, 4]) } }),
    token({ name: "Young Black Dragon", size: "large", x: 11, y: 3, elevation: 20, hpVisibility: "label", actor: { inline: actor([50, 127], [{ key: "frightened" }]) } }),
  );
  // Twenty archers sharing one picture, four rows deep, so only their numbers tell them apart.
  for (let n = 1; n <= 20; n++) {
    list.push(
      token({
        name: "Goblin Archer",
        number: n,
        x: 20 + ((n - 1) % 5),
        y: 9 + Math.floor((n - 1) / 5),
        hpVisibility: "label",
        image: { assetId: "fixture-goblin", crop: { cx: 0.5, cy: 0.5, zoom: 1 } },
        actor: { inline: actor([n % 4 === 2 ? 3 : 7, 7]) },
      }),
    );
  }
  state.tokens = Object.fromEntries(list.map((t) => [t.id, t]));
  state.templates = {
    "a-long": {
      id: "a-long",
      rev: 1,
      sceneId: FIXTURE_IDS.cave,
      shape: "sphere",
      size: 10,
      origin: { x: 19, y: 6, z: 0 },
      yaw: 0,
      includeOrigin: false,
      color: "#a855f7",
      ownerId: FIXTURE_IDS.vex,
      visibility: "all",
      label: "Spirit Guardians of the Morninglord, radiant, half on a save",
    } as RoomState["templates"][string],
  };
  state.labels = {
    "lb-long": { id: "lb-long", rev: 1, sceneId: FIXTURE_IDS.cave, x: 8, y: 1.5, text: "The Drowned Chapel of Saint Ostrava (flooded, difficult terrain)", size: 0.6 },
  };
}

/**
 * Spirit Guardians around Thorn with goblins in melee above and below him
 * (`melee=1`), where the area's name has to find room between them.
 */
function meleeGuardians(state: RoomState): void {
  const thorn = Object.values(state.tokens).find((t) => t.kind === "pc" && t.ownerIds.includes(FIXTURE_IDS.thorn))!;
  for (const [n, dy] of [[1, -1], [2, 1]] as const) {
    const t = token({ name: "Goblin Skirmisher", number: n, x: thorn.x, y: thorn.y + dy, hpVisibility: "label", actor: { inline: actor([7, 7]) } });
    t.id = `t-melee-${n}`;
    state.tokens[t.id] = t;
  }
  state.templates["a-guardians"] = {
    id: "a-guardians",
    rev: 1,
    sceneId: FIXTURE_IDS.cave,
    shape: "emanation",
    size: 15,
    origin: { x: thorn.x + 0.5, y: thorn.y + 0.5, z: 0 },
    yaw: 0,
    attachedTo: thorn.id,
    includeOrigin: false,
    color: "#eab308",
    ownerId: FIXTURE_IDS.thorn,
    visibility: "all",
    spell: "Spirit Guardians",
  } as RoomState["templates"][string];
}

/**
 * Walls, doors and windows off the grid, and lights, as a Universal VTT
 * import leaves them (docs/design-v1-maps-vision.md sections 2.2 and 3.6):
 * a slanted room with a window and a door, then a locked door, an open one
 * and a hidden secret one. Every coordinate is on the 1/64 cell lattice.
 */
function freeWallChunks(sceneId: string): BuildChunk[] {
  const door = (state: "open" | "closed" | "locked", secret = false) => ({ kind: "door", state, secret, discovered: false }) as const;
  const walls: FreeWall[] = [
    { id: "fixtureWal01", a: [8.5, 2.25], b: [12.5, 1.5], f: { kind: "wall" } },
    { id: "fixtureWal02", a: [12.5, 1.5], b: [15.5, 4], f: { kind: "wall" } },
    { id: "fixtureWal03", a: [15.5, 4], b: [15.25, 5], f: { kind: "wall" } },
    { id: "fixtureWin04", a: [15.25, 5], b: [15, 6], f: { kind: "window" } },
    { id: "fixtureWal05", a: [15, 6], b: [14, 8.5], f: { kind: "wall" } },
    { id: "fixtureWal06", a: [14, 8.5], b: [12, 8.25], f: { kind: "wall" } },
    { id: "fixtureDoo07", a: [12, 8.25], b: [11, 8.125], f: door("closed") },
    { id: "fixtureWal08", a: [11, 8.125], b: [9, 7.875], f: { kind: "wall" } },
    { id: "fixtureWal09", a: [9, 7.875], b: [8.5, 2.25], f: { kind: "wall" } },
    { id: "fixtureDoo10", a: [17.5, 9.5], b: [18.5, 10.25], f: door("locked") },
    { id: "fixtureDoo11", a: [19.5, 12], b: [20.5, 12.5], f: door("open") },
    { id: "fixtureDoo12", a: [6.5, 2.5], b: [7.25, 3.5], f: door("closed", true) },
  ];
  const chunks = new Map<string, BuildChunk>();
  for (const wall of walls) {
    const { cx, cy } = wallChunk(wall);
    const key = `${cx},${cy}`;
    const chunk = chunks.get(key) ?? { sceneId, cx, cy, rev: 1, cells: {}, edges: {}, walls: [] };
    chunk.walls!.push(wall);
    chunks.set(key, chunk);
  }
  return [...chunks.values()];
}

function fixtureLights(sceneId: string): Record<string, Light> {
  const light = (id: string, x: number, y: number, bright: number, dim: number, patch: Partial<Light> = {}): Light => ({
    id,
    rev: 1,
    sceneId,
    x,
    y,
    bright,
    dim,
    on: true,
    walls: true,
    ...patch,
  });
  return {
    "l-torch": light("l-torch", 10.5, 5, 20, 20, { label: "Torch" }),
    "l-lamp": light("l-lamp", 13.25, 3.5, 15, 30),
    "l-candle": light("l-candle", 20, 14, 5, 5, { on: false }),
  };
}

/** A homebrew monster of the room's own, written for the fixture, so no book's text is in the repository. */
const MIRE_GLOOM: CustomMonster = {
  id: "mon-mire-gloom",
  rev: 1,
  name: "Mire Gloom",
  size: "large",
  type: "Monstrosity",
  alignment: "Neutral Evil",
  ac: 13,
  initiative: 1,
  hp: { average: 45, formula: "6d10 + 12" },
  speed: "20 ft., Swim 40 ft.",
  abilities: {
    str: { score: 17, save: 3 },
    dex: { score: 12, save: 1 },
    con: { score: 15, save: 4 },
    int: { score: 6, save: -2 },
    wis: { score: 13, save: 1 },
    cha: { score: 8, save: -1 },
  },
  skills: "Stealth +5",
  vulnerabilities: "",
  resistances: "Cold",
  immunities: "",
  gear: "",
  senses: "Darkvision 60 ft.",
  passivePerception: 11,
  languages: "None",
  cr: "3",
  xp: 700,
  traits: [{ name: "Fog Shroud", text: "The gloom has Advantage on Dexterity (Stealth) checks made in fog or murky water." }],
  actions: [
    { name: "Multiattack", text: "The gloom makes two Lash attacks." },
    { name: "Lash", text: "Melee Attack Roll: +5, reach 10 ft. Hit: 10 (2d6 + 3) Bludgeoning damage." },
  ],
  bonusActions: [],
  reactions: [{ name: "Sink Away", text: "Trigger: A creature the gloom can see hits it with an attack. Response: The gloom moves up to half its Swim Speed." }],
  legendaryActions: [],
};
