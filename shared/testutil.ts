import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  ORDER_REVEALS,
  type Actor,
  type AreaTemplate,
  type CastAsk,
  type Character,
  type CompanionBlock,
  type CustomMonster,
  type DiceRoll,
  type Drawing,
  type Effect,
  type FreeWall,
  type AssetImage,
  type HandoutPage,
  type InitEntry,
  type JournalPage,
  type LogEntry,
  type LogEvent,
  type Member,
  type MoveAnyToken,
  type RollRequest,
  type RollTest,
  type AttachKind,
  type RoomState,
  type SavedEncounter,
  type SavedEncounterMonster,
  type Scene,
  type SrdImage,
  type StatBlock,
  type TerrainId,
  type Token,
  type TokenPath,
  type Trap,
  type TrapAction,
  type TrapDoorRef,
  type TrapDue,
  type TrapZone,
  type Viewer,
  type WallFeature,
} from "./model.ts";
import { wallChunk } from "./keys.ts";
import { ownsToken } from "./project.ts";
import { applyOp, type Env } from "./reducer.ts";
import { normalizeCompanionState } from "./reducer/companions.ts";
import { hpUndoRestore } from "./reducer/hpUndo.ts";
import type { Op } from "./protocol.ts";
import { ATTACH_KINDS, seatSpot } from "./rules/attach.ts";
import { encodeTile, fullTileBits, rasterizeFogOps, TILE_BYTES } from "./rules/fog.ts";

/**
 * Fixtures and generators shared by the unit tests. Nothing here runs in the
 * app. The builders mutate the state they are given, which is fine for a test
 * that sets up a fixture before handing it to the pure functions under test.
 */

export const AT = "2026-10-12T20:00:00.000Z";

export const DM: Viewer = { memberId: "dm1", role: "dm" };
export const P1: Viewer = { memberId: "p1", role: "player" };
export const P2: Viewer = { memberId: "p2", role: "player" };

export function env(seq: number): Env {
  return { seq, at: AT };
}

export function member(id: string, kind: Member["kind"] = "player"): Member {
  return { id, rev: 0, name: id, color: "#ff0000", kind, createdAt: AT };
}

export function scene(id: string, overrides: Partial<Scene> = {}): Scene {
  return {
    id,
    rev: 0,
    name: id,
    order: 0,
    bounds: { w: 40, h: 30 },
    grid: { show: true, color: "#ffffff", opacity: 0.25, lineWidth: 1 },
    background: "#2b2b31",
    fogEnabled: false,
    wallsVersion: 0,
    ...overrides,
  };
}

export function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    hp: { cur: 20, max: 20, temp: 0 },
    life: "alive",
    ac: 14,
    speeds: { walk: 30 },
    initBonus: 2,
    passivePerception: 12,
    senses: "",
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "secret plan",
    ...overrides,
  };
}

export function token(id: string, overrides: Partial<Token> = {}): Token {
  return {
    id,
    rev: 0,
    sceneId: "s1",
    kind: "monster",
    name: "Goblin",
    nameHidden: false,
    size: "medium",
    x: 3,
    y: 3,
    elevation: 0,
    rotation: 0,
    disposition: "hostile",
    visibility: "all",
    fogExempt: false,
    fogExemptAuto: false,
    locked: false,
    layer: "token",
    ownerIds: [],
    actor: { inline: actor() },
    hpVisibility: "label",
    ...overrides,
  };
}

export function character(id: string, overrides: Partial<Character> = {}): Character {
  return { id, rev: 0, ownerIds: ["p1"], name: "Hero", size: "medium", actor: actor(), ...overrides };
}

export function template(id: string, overrides: Partial<AreaTemplate> = {}): AreaTemplate {
  return {
    id,
    rev: 0,
    sceneId: "s1",
    shape: "sphere",
    size: 20,
    origin: { x: 5, y: 5, z: 0 },
    yaw: 0,
    includeOrigin: true,
    color: "#ff8800",
    ownerId: "p1",
    visibility: "all",
    ...overrides,
  };
}

export function drawing(id: string, overrides: Partial<Drawing> = {}): Drawing {
  return {
    id,
    rev: 0,
    sceneId: "s1",
    kind: "line",
    points: [0, 0, 1, 1],
    style: { stroke: "#ffffff", width: 2, opacity: 1 },
    ownerId: "p1",
    visibility: "all",
    ...overrides,
  };
}

/** A homebrew monster written for the tests, so no book's text is ever in the repository. */
export function customMonster(id: string, overrides: Partial<CustomMonster> = {}): CustomMonster {
  const ability = (score: number, save: number) => ({ score, save });
  return {
    id,
    rev: 0,
    name: "Cave Lurker",
    size: "large",
    type: "Monstrosity",
    alignment: "Unaligned",
    ac: 14,
    initiative: 2,
    hp: { average: 22, formula: "4d10" },
    speed: "30 ft., Climb 30 ft.",
    abilities: { str: ability(15, 2), dex: ability(14, 2), con: ability(12, 1), int: ability(3, -4), wis: ability(12, 3), cha: ability(6, -2) },
    skills: "Stealth +6",
    vulnerabilities: "",
    resistances: "",
    immunities: "",
    gear: "",
    senses: "Darkvision 60 ft.",
    passivePerception: 11,
    languages: "None",
    cr: "2",
    xp: 450,
    traits: [{ name: "Lurker's Secret", text: "It hides in the ceiling of the second cave." }],
    actions: [{ name: "Bite", text: "Melee Attack Roll: +4, reach 5 ft. Hit: 7 (1d10 + 2) Piercing damage." }],
    bonusActions: [],
    reactions: [],
    legendaryActions: [],
    ...overrides,
  };
}

/** A token image of the given asset, centered. */
export function imageRef(assetId: string, zoom = 1): AssetImage {
  return { assetId, crop: { cx: 0, cy: 0, zoom } };
}

/** One page of a handout: a portrait Letter page drawn at 2048 px on its long side unless sized. */
export function handoutPage(assetId: string, width = 1584, height = 2048): HandoutPage {
  return { assetId, width, height };
}

/** The DM's default image for an SRD monster, as the room stores it. */
export function srdImage(srdId: string, assetId: string, overrides: Partial<SrdImage> = {}): SrdImage {
  return { id: srdId, rev: 0, image: imageRef(assetId), ...overrides };
}

/**
 * A stat block a character keeps for its companions
 * (docs/design-v1-companion-stat-blocks.md 3.1), homebrew written for the
 * tests, with text of its own so a leak check on the room's monsters never
 * mistakes one for the other.
 */
export function companionBlock(id: string, characterId: string, overrides: Partial<CompanionBlock> = {}): CompanionBlock {
  const block = blockOf(
    customMonster(id, {
      name: "Moth Spirit",
      size: "small",
      type: "Fey",
      ac: 12,
      hp: { average: 9, formula: "2d6 + 2" },
      speed: "10 ft., Fly 40 ft. (hover)",
      senses: "Darkvision 60 ft.",
      passivePerception: 13,
      cr: "1/4",
      xp: 50,
      traits: [{ name: "Lantern Wings", text: "It sheds dim light in a 10-foot radius." }],
      actions: [{ name: "Dust", text: "Constitution Saving Throw: DC 11, one creature within 5 feet. Failure: The target has the Poisoned condition until the end of its next turn." }],
    }),
  );
  return { ...block, id, rev: 0, characterId, ...overrides };
}

/**
 * A player's open ask for saves (docs/design-v1-player-save-spell.md 5.2):
 * by default p1's Fireball for the token `thorn` over the area `a1`, cast at
 * level 3. An override set to undefined leaves its field out, so a targets
 * ask reads `{ area: undefined, targets: [...] }`.
 */
export function castAsk(id: string, overrides: Partial<CastAsk> = {}): CastAsk {
  const ask: CastAsk = { id, rev: 1, by: "p1", caster: "thorn", sceneId: "s1", spell: "Fireball", slot: 3, area: "a1", at: AT, ...overrides };
  for (const key of Object.keys(ask) as (keyof CastAsk)[]) if (ask[key] === undefined) delete ask[key];
  return ask;
}

/**
 * The table the save spell tests share (docs/design-v1-player-save-spell.md
 * 8): Thorn, p1's character, with a token `thorn` on the players' scene and
 * p1's Fireball area `a1` around it, Bree, p2's, with the token `bree`, the
 * goblin `g1` in the open and `g2` hidden from players, and p2's own area
 * `a2`. No ask is open.
 */
export function castTable(overrides: Partial<RoomState> = {}): RoomState {
  return room({
    characters: {
      "thorn-c": character("thorn-c", { name: "Thorn", ownerIds: ["p1"] }),
      "bree-c": character("bree-c", { name: "Bree", ownerIds: ["p2"] }),
    },
    tokens: {
      thorn: token("thorn", { kind: "pc", name: "Thorn", ownerIds: [], actor: { ref: "thorn-c" }, x: 4, y: 4 }),
      bree: token("bree", { kind: "pc", name: "Bree", ownerIds: [], actor: { ref: "bree-c" }, x: 6, y: 4 }),
      g1: token("g1", { name: "Goblin", number: 1, x: 5, y: 5 }),
      g2: token("g2", { name: "Goblin", number: 2, x: 5, y: 6, visibility: "dm" }),
    },
    templates: {
      a1: template("a1", { ownerId: "p1", casterId: "thorn", spell: "Fireball" }),
      a2: template("a2", { ownerId: "p2", spell: "Thunderwave" }),
    },
    ...overrides,
  });
}

/** A damage roll of the caster's, as the server logs a free roll: `8d6` for 28 Fire on `thorn` by p1, unless told otherwise. */
export function damageRoll(overrides: Partial<DiceRoll> = {}): DiceRoll {
  return { formula: "8d6", faces: [6, 5, 4, 3, 3, 3, 2, 2], total: 28, label: "Fireball damage, Fire", tokenId: "thorn", ...overrides };
}

/** A `dice` line under a tag (docs/design-v1-dice.md 5.1), by p1 to everyone unless told otherwise. */
export function diceLine(id: string, tag: string, rolls: DiceRoll[], overrides: Partial<Extract<LogEvent, { type: "dice" }>> = {}): LogEntry {
  return { id, at: AT, kind: "event", data: { type: "dice", tag, by: "p1", to: "all", rolls, ...overrides } };
}

/** A monster's stat block without its id and rev: what a create op carries beside an id. */
export function blockOf(m: CustomMonster): StatBlock {
  const { id: _id, rev: _rev, ...block } = m;
  return block;
}

export function effect(id: string, overrides: Partial<Effect> = {}): Effect {
  return { id, key: "blessed", ...overrides };
}

export function entry(id: string, overrides: Partial<InitEntry> = {}): InitEntry {
  return { id, value: 10, tieOrder: 0, hidden: false, reactionUsed: false, inLair: false, ...overrides };
}

/**
 * A room with a DM, two players, two scenes (s1 is the player scene) and
 * nothing else. Players see the whole initiative order in it, as in every
 * room from before the order setting, so a fixture's rows reach them by the
 * other rules alone. The order setting's own tests pick another.
 */
export function room(overrides: Partial<RoomState> = {}): RoomState {
  return {
    meta: { name: "Test room", settings: { ...DEFAULT_SETTINGS, playersSeeOrder: "all" }, playerSceneId: "s1", view: { follow: false, blackout: false } },
    members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2") },
    scenes: { s1: scene("s1"), s2: scene("s2", { order: 1 }) },
    buildChunks: {},
    labels: {},
    fogTiles: {},
    fogDrafts: {},
    tokens: {},
    characters: {},
    templates: {},
    drawings: {},
    encounter: null,
    encounterHistory: [],
    handouts: {},
    log: [],
    monsters: {},
    srdImages: {},
    savedEncounters: {},
    stamps: {},
    lights: {},
    exploredTiles: {},
    journal: {},
    pins: {},
    rolls: {},
    handoutDocs: {},
    companionBlocks: {},
    casts: {},
    traps: {},
    trapLog: [],
    trapSeen: [],
    ...overrides,
  };
}

/** Applies an op that must succeed and returns the new state. */
export function apply(state: RoomState, op: Op, who: Viewer = DM, seq = 1): RoomState {
  const result = applyOp(state, op, who, env(seq));
  assert.ok(result.ok, `expected ${op.t} to apply, got ${result.ok ? "" : `${result.code}: ${result.message}`}`);
  return result.state;
}

export function refused(state: RoomState, op: Op, who: Viewer = DM, seq = 1): { code: string; message: string } {
  const result = applyOp(state, op, who, env(seq));
  assert.ok(!result.ok, `expected ${op.t} to be refused`);
  return result;
}

/** Fully fogs nothing: a scene with fog enabled and no tiles has everything hidden. Reveals the given rect. */
export function reveal(state: RoomState, sceneId: string, rect: { x: number; y: number; w: number; h: number }): void {
  const s = state.scenes[sceneId]!;
  const changes = rasterizeFogOps(state.fogTiles, sceneId, s.bounds, [{ id: "r", mode: "reveal", shape: { kind: "rect", ...rect } }]);
  for (const [key, tile] of Object.entries(changes)) {
    if (tile === null) delete state.fogTiles[key];
    else state.fogTiles[key] = tile;
  }
}

export const FULL_TILE_BITS = encodeTile(fullTileBits());

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Strips revs and the log, for comparing states before an op and after its inverse. */
export function comparable(state: RoomState): unknown {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === "rev" || v === undefined) continue;
        out[k] = strip(v);
      }
      return out;
    }
    return value;
  };
  const { log: _log, ...rest } = state;
  return strip(rest);
}

/** mulberry32: a tiny seeded generator, so a failing property test can be replayed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(r: () => number, items: readonly T[]): T {
  return items[Math.floor(r() * items.length)]!;
}

export function chance(r: () => number, p: number): boolean {
  return r() < p;
}

export function int(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

const EFFECT_KEYS = ["blessed", "poisoned", "invisible", "concentrating", "unconscious", "custom", "surprised", "readied"] as const;

function randomEffects(r: () => number, entryIds: string[], tokenIds: string[]): Effect[] {
  const out: Effect[] = [];
  const n = int(r, 0, 3);
  for (let i = 0; i < n; i++) {
    const e: Effect = { id: `e${i}`, key: pick(r, EFFECT_KEYS) };
    if (chance(r, 0.3)) e.hiddenFromPlayers = true;
    if (e.key === "concentrating") e.spell = "Bless";
    if (e.key === "readied") {
      // A Ready action's trigger, shown to every player now and then.
      e.label = "when the door opens";
      if (chance(r, 0.3)) e.triggerShown = true;
    }
    if (chance(r, 0.4)) {
      const anchor =
        entryIds.length > 0 && chance(r, 0.6)
          ? { entryId: pick(r, entryIds) }
          : tokenIds.length > 0
            ? { tokenId: pick(r, tokenIds) }
            : { characterId: "c0" };
      e.duration = { remaining: int(r, 1, 3), boundary: pick(r, ["turnStart", "turnEnd"] as const), anchor };
    }
    out.push(e);
  }
  return out;
}

/**
 * A random but internally consistent room: members, two scenes with fog in
 * every state, tokens of every visibility, owners and exemption, characters,
 * templates, drawings, secret doors, fog tiles, a draft, an encounter with
 * hidden rows and a history, handouts and a log of every kind. Dangling
 * references are added on purpose, because projection must survive them.
 */
export function randomState(r: () => number): RoomState {
  const state = room();
  state.meta.settings.pcHpVisibleToParty = chance(r, 0.5);
  state.meta.settings.playersSeeAoeOfOthers = chance(r, 0.5);
  state.meta.settings.playersMoveAny = pick<MoveAnyToken>(r, ["none", "all", ["p1"], ["p2", "p1"]]);
  state.meta.settings.playersApplyDamage = chance(r, 0.5);
  state.meta.settings.revealHiddenOnTurn = chance(r, 0.7);
  state.meta.settings.skipDefeated = chance(r, 0.7);
  state.meta.settings.monsterInitScore = chance(r, 0.3);
  state.meta.playerSceneId = pick(r, ["s1", "s1", "s2"]);
  state.scenes.s1!.fogEnabled = chance(r, 0.6);
  state.scenes.s2!.fogEnabled = chance(r, 0.6);
  state.scenes.s1!.bounds = { w: 36, h: 36 };
  state.scenes.s2!.bounds = { w: 20, h: 20 };
  if (chance(r, 0.5)) state.scenes.s1!.map = { assetId: "map-s1", widthPx: 1000, heightPx: 800, cellPx: 50, originPx: { x: 0, y: 0 } };

  const characterIds: string[] = [];
  for (let i = 0; i < int(r, 1, 3); i++) {
    const id = `c${i}`;
    characterIds.push(id);
    const c = character(id, { ownerIds: pick(r, [["p1"], ["p2"], ["p1", "p2"], []]), name: `Hero ${i}` });
    c.actor.hp = { cur: int(r, 0, 20), max: 20, temp: int(r, 0, 5) };
    c.actor.life = c.actor.hp.cur === 0 ? pick(r, ["dying", "stable", "dead"] as const) : "alive";
    if (chance(r, 0.5)) c.defaultImage = { assetId: `img-${id}`, crop: { cx: 0, cy: 0, zoom: 1 } };
    // Without drawing from r, so the rest of every random room stays as it was.
    if (i !== 1) c.level = 3 + 4 * i;
    if (i !== 0) c.knownForms = i === 1 ? ["wolf", "owl"] : ["black-bear"];
    state.characters[id] = c;
  }

  const tokenIds: string[] = [];
  for (let i = 0; i < int(r, 2, 12); i++) {
    const id = `t${i}`;
    tokenIds.push(id);
    const sceneId = pick(r, ["s1", "s1", "s2"]);
    const kind = pick(r, ["pc", "monster", "monster", "npc", "object"] as const);
    const t = token(id, {
      sceneId,
      kind,
      name: kind === "pc" ? `PC ${i}` : pick(r, ["Goblin", "Orc", "Wolf"]),
      visibility: pick(r, ["all", "all", "dm"] as const),
      // A DM may own a creature too, which does not make it a player's.
      ownerIds: pick(r, [[], [], ["p1"], ["p2"], ["dm1"]]),
      fogExempt: chance(r, 0.2),
      fogExemptAuto: chance(r, 0.2),
      locked: chance(r, 0.2),
      nameHidden: chance(r, 0.3),
      publicName: chance(r, 0.5) ? "Something" : undefined,
      size: pick(r, ["tiny", "medium", "large", "custom"] as const),
      x: int(r, 0, 30),
      y: int(r, 0, 30),
      hpVisibility: pick(r, ["hidden", "label", "bar", "exact"] as const),
      number: chance(r, 0.3) ? int(r, 1, 5) : undefined,
      image: chance(r, 0.5) ? { assetId: `img-${id}`, crop: { cx: 0, cy: 0, zoom: 1 } } : undefined,
    });
    if (t.size === "custom") {
      t.w = 1.5;
      t.h = 2;
    }
    if (chance(r, 0.3)) t.notes = "A note for everyone";
    if (chance(r, 0.3)) t.altImages = [{ assetId: `alt-${id}`, crop: { cx: 0, cy: 0, zoom: 1 } }];
    if (t.publicName === undefined) delete t.publicName;
    if (t.number === undefined) delete t.number;
    if (t.image === undefined) delete t.image;
    if (kind === "pc" && chance(r, 0.7)) {
      t.actor = { ref: chance(r, 0.9) ? pick(r, characterIds) : "missing-character" };
    } else {
      const a = actor({ hp: { cur: int(r, 0, 20), max: 20, temp: int(r, 0, 5) }, initScore: 12 });
      a.life = a.hp.cur === 0 ? pick(r, ["dying", "stable", "dead"] as const) : "alive";
      if (chance(r, 0.3)) a.legendary = { actionsMax: 3, actionsUsed: int(r, 0, 3), resistMax: 3, resistUsed: 0 };
      t.actor = { inline: a };
    }
    state.tokens[id] = t;
  }

  // Fog: a few revealed rectangles per fogged scene, so some tokens sit in the dark and some in the light.
  for (const sceneId of ["s1", "s2"]) {
    for (let i = 0; i < int(r, 0, 3); i++) {
      reveal(state, sceneId, { x: int(r, 0, 25), y: int(r, 0, 25), w: int(r, 1, 8), h: int(r, 1, 8) });
    }
  }
  if (chance(r, 0.5)) {
    state.fogDrafts.s1 = { sceneId: "s1", rev: 0, ops: [{ id: "d1", mode: "reveal", shape: { kind: "rect", x: 1, y: 1, w: 3, h: 3 } }] };
  }

  for (let i = 0; i < int(r, 0, 6); i++) {
    const id = `a${i}`;
    const t = template(id, {
      sceneId: pick(r, ["s1", "s2"]),
      ownerId: pick(r, ["dm1", "p1", "p2"]),
      visibility: pick(r, ["all", "all", "dm"] as const),
    });
    if (chance(r, 0.4)) t.attachedTo = chance(r, 0.9) ? pick(r, tokenIds) : "missing-token";
    if (chance(r, 0.4)) t.casterId = chance(r, 0.9) ? pick(r, tokenIds) : "missing-token";
    if (chance(r, 0.2)) t.footprint = { w: pick(r, [0.5, 1, 2]), h: pick(r, [1, 2]), elevation: int(r, 0, 3) * 5, height: pick(r, [5, 7.5, 10]) };
    state.templates[id] = t;
  }

  for (let i = 0; i < int(r, 0, 4); i++) {
    const id = `d${i}`;
    state.drawings[id] = drawing(id, {
      sceneId: pick(r, ["s1", "s2"]),
      ownerId: pick(r, ["dm1", "p1", "p2"]),
      visibility: pick(r, ["all", "dm"] as const),
    });
  }

  for (let i = 0; i < int(r, 0, 2); i++) {
    const sceneId = pick(r, ["s1", "s2"]);
    state.buildChunks[`${sceneId}:${i},0`] = {
      sceneId,
      cx: i,
      cy: 0,
      rev: 0,
      cells: { [`${i * 16},0`]: "stone", [`${i * 16 + 1},0`]: "wood" },
      edges: {
        [`${i * 16},0,n`]: { kind: "door", state: "closed", secret: chance(r, 0.5), discovered: chance(r, 0.5) },
        [`${i * 16},0,w`]: { kind: "wall" },
      },
    };
    state.labels[`l${i}`] = { id: `l${i}`, rev: 0, sceneId, x: int(r, 0, 30) + 0.5, y: int(r, 0, 30) + 0.5, text: pick(r, ["Hall", "", "A long passage north"]), size: pick(r, [0.5, 1, 3]) };
  }

  const entryIds: string[] = [];
  if (chance(r, 0.7)) {
    const entries: InitEntry[] = [];
    const used = new Set<string>();
    for (let i = 0; i < int(r, 1, 6); i++) {
      const id = `n${i}`;
      entryIds.push(id);
      const e = entry(id, { value: pick(r, [20, 15, 15, 10, null]), tieOrder: i, hidden: chance(r, 0.3) });
      const choice = r();
      if (choice < 0.7 && tokenIds.length > 0) {
        const tokenId = pick(r, tokenIds);
        if (used.has(tokenId)) continue;
        used.add(tokenId);
        e.tokenId = tokenId;
        e.groupKey = state.tokens[tokenId]!.name;
      } else if (choice < 0.85) {
        e.characterId = pick(r, characterIds);
      } else {
        e.label = "Lair action";
      }
      if (chance(r, 0.3)) e.advantage = pick(r, ["adv", "dis"] as const);
      entries.push(e);
    }
    state.encounter = {
      rev: 0,
      round: int(r, 1, 3),
      activeEntryId: entries.length > 0 && chance(r, 0.8) ? pick(r, entries).id : null,
      entries,
    };
    if (chance(r, 0.5)) {
      state.encounterHistory = [{ encounter: deepClone(state.encounter), effects: {}, revealed: [], at: AT }];
    }
  }

  // Effects, now that entries exist to anchor to.
  for (const c of Object.values(state.characters)) c.actor.effects = randomEffects(r, entryIds, tokenIds);
  for (const t of Object.values(state.tokens)) if ("inline" in t.actor) t.actor.inline.effects = randomEffects(r, entryIds, tokenIds);

  for (let i = 0; i < int(r, 0, 3); i++) {
    const id = `h${i}`;
    state.handouts[id] = { id, rev: 0, assetId: `img-${id}`, title: "Map", to: pick(r, ["all", ["p1"], ["p2"], ["dm1"]]), shownAt: AT };
    // The second is a handout of pages (docs/design-v1-pdf-handouts.md 3.1), with no draw of its own so the seeds keep what they hold.
    if (i === 1) state.handouts[id]!.pages = [handoutPage(`img-${id}`), handoutPage(`img-${id}-2`)];
  }
  // A document in the DM's library, sharing a page with the second handout as a shown document would.
  state.handoutDocs.d0 = { id: "d0", rev: 0, title: "Strange letter", pages: [handoutPage("img-h1"), handoutPage("img-h1-2"), handoutPage("img-d0-3")], createdAt: AT };

  for (let i = 0; i < int(r, 0, 3); i++) {
    const id = `m${i}`;
    state.monsters[id] = customMonster(id, {
      name: pick(r, ["Cave Lurker", "Bog Hag", "Goblin"]),
      ...(chance(r, 0.3) ? { sizeAlt: "small" as const, xpInLair: 700 } : {}),
      ...(chance(r, 0.5) ? { defaultImage: imageRef(`img-${id}`) } : {}),
    });
  }

  for (const srdId of ["goblin-warrior", "bandit", "owlbear"]) {
    if (chance(r, 0.4)) state.srdImages[srdId] = srdImage(srdId, `img-srd-${srdId}`);
  }

  const log: LogEntry[] = [];
  let n = 0;
  const push = (e: Omit<LogEntry, "id" | "at">) => log.push({ id: `${1}:${n++}`, at: AT, ...e });
  push({ kind: "chat", from: "p1", text: "hello" });
  push({ kind: "whisper", from: "p1", to: ["p2"], text: "psst" });
  push({ kind: "whisper", from: "p2", to: ["dm1"], text: "dm only" });
  push({ kind: "whisper", from: "dm1", to: ["p1"], text: "from dm" });
  for (const tokenId of tokenIds) {
    // Most entries were seen by everyone when written. The rest happened while the creature was out of sight.
    const seen = () => (chance(r, 0.7) ? { seen: true as const } : {});
    if (chance(r, 0.5)) push({ kind: "event", data: { type: "hp", tokenId, ...seen(), change: "damage", amount: 7, label: "Bloodied" } });
    if (chance(r, 0.3)) push({ kind: "event", data: { type: "concentration", tokenId, ...seen(), dc: 10, spell: "Bless", ...(chance(r, 0.3) ? { hidden: true as const } : {}) } });
    if (chance(r, 0.3)) push({ kind: "event", data: { type: "life", tokenId, ...seen(), life: "dying" } });
    if (chance(r, 0.3)) push({ kind: "event", data: { type: "effect", tokenId, ...seen(), key: "poisoned", action: "add", ...(chance(r, 0.3) ? { hidden: true as const } : {}) } });
    if (chance(r, 0.2)) push({ kind: "event", data: { type: "deathSave", tokenId, ...seen(), ok: 1, fail: 0 } });
  }
  for (const characterId of characterIds) {
    if (chance(r, 0.5)) push({ kind: "event", data: { type: "hp", characterId, change: "heal", amount: 5, label: "Healthy" } });
  }
  for (const entryId of entryIds) if (chance(r, 0.5)) push({ kind: "event", data: { type: "turn", entryId, round: 1, ...(chance(r, 0.7) ? { seen: true as const } : {}) } });
  // Take-backs, each naming the row it resumed, seen or not then.
  for (const entryId of entryIds) {
    if (!chance(r, 0.3)) continue;
    push({ kind: "event", data: { type: "turn", entryId, round: 1, back: true, seen: true, to: pick(r, entryIds), ...(chance(r, 0.5) ? { toSeen: true as const } : {}) } });
  }
  for (const handoutId of Object.keys(state.handouts)) push({ kind: "event", data: { type: "handout", handoutId } });
  push({ kind: "event", data: { type: "member", memberId: "p1", action: "join" } });
  push({ kind: "event", data: { type: "member", memberId: "ghost", action: "join" } });
  push({ kind: "event", data: { type: "hp", tokenId: "missing-token", change: "damage", amount: 1 } });
  push({ kind: "event", data: { type: "encounter", action: "start" } });
  state.log = log;
  // Now and then the players are behind a blackout, which withholds the whole table from them.
  state.meta.view.blackout = chance(r, 0.15);

  // Later additions draw last, so every seed still gives the rooms above.
  addTurnStart(r, state);
  addKeptRulers(r, state);
  for (const t of Object.values(state.tokens)) if (chance(r, 0.2)) t.rangeRings = pick(r, [[30], [30, 60, 120], [5, 1000]]);
  addPaths(r, state);
  // Cones and lines aimed up or down.
  for (const t of Object.values(state.templates)) {
    if (!chance(r, 0.3)) continue;
    t.shape = pick(r, ["cone", "line"] as const);
    t.pitch = pick(r, [-90, -30, 15, 45, 90]);
  }
  addAreaReminders(r, state);
  addHpLines(r, state);
  addSavedEncounters(r, state);
  addMapThings(r, state);
  addVisionThings(r, state);
  addDmTools(r, state);
  addCompanions(r, state);
  addCompanionBlocks(state);
  addOrderReveal(r, state);
  addCasts(r, state);
  addTraps(r, state);
  return state;
}

/** A trap with every rig field the projection and limits read, at its smallest. */
export function trap(id: string, overrides: Partial<Trap> = {}): Trap {
  return {
    id,
    rev: 0,
    sceneId: "s1",
    name: "Hidden Pit",
    zone: { cells: [{ x: 4, y: 4, w: 2, h: 2 }] },
    state: "armed",
    found: false,
    rig: { on: ["enter"], who: "any", floor: true, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false },
    ...overrides,
  };
}

/**
 * Traps (docs/design-v1-traps.md 6.1): on either scene, squares, wires and
 * doors (secret ones among them), found or not, armed, sprung or disarmed,
 * with actions naming lights, stamps and tokens (some gone), occurrences
 * naming creatures seen or hidden, and both trap logs with their lines.
 */
function addTraps(r: () => number, state: RoomState): void {
  const tokenIds = [...Object.keys(state.tokens), "missing-token"];
  const doorsOf = (sceneId: string): TrapDoorRef[] => {
    const out: TrapDoorRef[] = [];
    for (const chunk of Object.values(state.buildChunks)) {
      if (chunk.sceneId !== sceneId) continue;
      for (const [edge, f] of Object.entries(chunk.edges)) if (f.kind === "door") out.push({ edge });
      for (const w of chunk.walls ?? []) if (w.f.kind === "door") out.push({ cx: chunk.cx, cy: chunk.cy, id: w.id });
    }
    return out.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  };
  const count = int(r, 0, 4);
  for (let i = 0; i < count; i++) {
    const id = `trap${i}`;
    const sceneId = pick(r, ["s1", "s1", "s2"]);
    const doors = doorsOf(sceneId);
    const kind = int(r, 0, 3);
    let zone: TrapZone;
    if (kind === 2 && doors.length > 0) zone = { door: pick(r, doors) };
    else if (kind === 1) {
      const ax = int(r, 0, 18);
      const ay = int(r, 0, 18);
      zone = { wire: { a: [ax, ay], b: [ax + int(r, 1, 3), ay + pick(r, [0, 0, 0.5, 1])] } };
    } else zone = { cells: Array.from({ length: int(r, 1, 2) }, () => ({ x: int(r, 0, 16), y: int(r, 0, 16), w: int(r, 1, 3), h: int(r, 1, 3) })) };
    const actions: TrapAction[] = [];
    for (let a = 0; a < int(r, 0, 3); a++) {
      const lights = Object.values(state.lights).filter((l) => l.sceneId === sceneId);
      const stamps = Object.values(state.stamps).filter((st) => st.sceneId === sceneId);
      switch (int(r, 0, 3)) {
        case 0:
          if (doors.length > 0) actions.push({ door: pick(r, doors), state: pick(r, ["open", "closed", "locked"] as const) });
          break;
        case 1:
          actions.push({ light: lights.length > 0 && chance(r, 0.8) ? pick(r, lights).id : "missing-light", on: chance(r, 0.5) });
          break;
        case 2:
          actions.push({ show: { tokenId: pick(r, tokenIds) } });
          break;
        default:
          actions.push({ show: { stampId: stamps.length > 0 && chance(r, 0.8) ? pick(r, stamps).id : "missing-stamp" } });
      }
    }
    const due: TrapDue[] = [];
    for (let d = 0; d < int(r, 0, 2); d++) {
      const occurrence: TrapDue = { id: `${50 + i}:${d}`, at: AT, how: pick(r, ["enter", "leave", "cross", "open", "hand"] as const), by: [pick(r, tokenIds)], hits: [...new Set([pick(r, tokenIds), pick(r, tokenIds)])].sort() };
      if (chance(r, 0.5)) occurrence.perceived = true;
      else if (chance(r, 0.5)) occurrence.hidden = true;
      if (chance(r, 0.3)) occurrence.acted = true;
      if (chance(r, 0.2)) occurrence.more = 2;
      due.push(occurrence);
    }
    const t = trap(id, {
      rev: int(r, 0, 4),
      sceneId,
      name: pick(r, ["Hidden Pit", "Poison Darts", "Collapsing Roof"]),
      zone,
      state: pick(r, ["armed", "armed", "sprung", "disarmed"] as const),
      found: chance(r, 0.4),
    });
    const rig = t.rig!;
    if ("cells" in zone) {
      rig.on = pick(r, [["enter"], ["enter", "turnStart"], ["leave"]] as const).slice();
      if (chance(r, 0.3)) rig.pit = { floor: -10 };
      rig.hits = pick(r, ["trigger", "zone"] as const);
    } else rig.on = [];
    rig.who = pick(r, ["party", "others", "any"] as const);
    rig.actions = actions;
    if (chance(r, 0.5)) rig.message = "A click underfoot.";
    if (chance(r, 0.4)) rig.sound = pick(r, ["click", "rumble", "crash"] as const);
    if (chance(r, 0.5)) rig.usesLeft = int(r, 0, 3);
    if (chance(r, 0.4)) rig.save = { ability: "dex", dc: 15, onPass: "half" };
    if (chance(r, 0.4)) rig.damage = [{ formula: "2d10", type: "bludgeoning" }];
    if (chance(r, 0.4)) rig.find = [{ ability: "wis", skill: "perception", dc: 15, what: "the lid" }];
    if (chance(r, 0.3)) rig.noticedBy = pick(r, tokenIds);
    if (due.length > 0) rig.due = due;
    state.traps[id] = t;
  }
  // The DM's lines, and the players' lines naming creatures seen or hidden.
  const traps = Object.keys(state.traps);
  for (let i = 0; i < int(r, 0, 3); i++) {
    const trapId = traps.length > 0 ? pick(r, traps) : "gone-trap";
    const data: LogEvent = chance(r, 0.7)
      ? { type: "trap", trapId, name: "Hidden Pit", how: pick(r, ["enter", "hand"] as const), by: [pick(r, tokenIds)], hits: int(r, 0, 3), did: [], ...(chance(r, 0.5) ? { seen: [0] } : {}) }
      : { type: "trapNotice", trapId, tokenId: pick(r, tokenIds), passive: 16, dc: 15 };
    state.trapLog.push({ id: `60:${i}`, at: AT, kind: "event", data });
  }
  for (let i = 0; i < int(r, 0, 3); i++) {
    const by = [...new Set(Array.from({ length: int(r, 0, 3) }, () => pick(r, tokenIds)))];
    state.trapSeen.push({ id: `61:${i}`, at: AT, kind: "event", data: { type: "trapSeen", by, ...(chance(r, 0.3) ? { more: 1 } : {}), message: "A click underfoot.", ...(chance(r, 0.5) ? { sound: "click" as const } : {}) } });
  }
}

/**
 * Players' asks for saves (docs/design-v1-player-save-spell.md 5.2), each
 * with its line, and the lines of asks closed before: for any token, a gone
 * one now and then, over an area or targets some of which are hidden or
 * gone, with a damage roll whose line is now and then Secret, or rolled by
 * another player, and whose results the ask now and then holds.
 */
function addCasts(r: () => number, state: RoomState): void {
  const tokenIds = Object.keys(state.tokens);
  const templateIds = Object.keys(state.templates);
  if (tokenIds.length === 0) return;
  let dice = 0;
  // After every dice line, in the log's own order of ids.
  const lines: LogEvent[] = [];
  for (let i = 0; i < int(r, 0, 3); i++) {
    const id = `k${i}`;
    const by = pick(r, ["p1", "p2"]);
    const caster = chance(r, 0.9) ? pick(r, tokenIds) : "missing-token";
    const ask: CastAsk = { id, rev: 1, by, caster, sceneId: state.tokens[caster]?.sceneId ?? "s1", spell: pick(r, ["Fireball", "Hold Person", "Sacred Flame"]), at: AT };
    if (chance(r, 0.5)) ask.slot = int(r, 1, 9);
    if (templateIds.length > 0 && chance(r, 0.5)) ask.area = chance(r, 0.9) ? pick(r, templateIds) : "missing-template";
    else {
      ask.targets = [...new Set(Array.from({ length: int(r, 1, 4) }, () => (chance(r, 0.9) ? pick(r, tokenIds) : "missing-token")))];
      ask.roll = "spells:Hold Person";
    }
    if (chance(r, 0.6)) {
      const tag = `dmg-${id}`;
      ask.damage = { tag, parts: 1 };
      const roll = damageRoll({ label: `${ask.spell} damage, Fire`, tokenId: caster, ...(chance(r, 0.6) ? { seen: true as const } : {}) });
      state.log.push(diceLine(`8:${dice++}`, tag, [roll], { by: chance(r, 0.85) ? by : pick(r, ["p1", "p2", "dm1"]), to: chance(r, 0.4) ? "dm" : "all", batch: `batch${id}xxxxxxxxx`.slice(0, 16) }));
      if (chance(r, 0.8)) ask.rolled = [{ formula: roll.formula, total: roll.total, type: "fire" }];
    }
    state.casts[id] = ask;
    lines.push({ type: "cast", castId: id, tokenId: caster, spell: ask.spell, ...(ask.slot !== undefined ? { slot: ask.slot } : {}) });
  }
  for (let i = 0; i < int(r, 0, 2); i++) {
    const end = pick(r, ["done", "dismissed", "withdrawn"] as const);
    lines.push({ type: "cast", castId: `closed${i}`, tokenId: pick(r, tokenIds), spell: "Fireball", slot: 3, end });
  }
  // Damage rolls no ask names yet, which a random ask may take.
  for (let i = 0; i < int(r, 0, 3); i++) {
    const by = pick(r, ["p1", "p2"]);
    const own = tokenIds.filter((id) => ownsToken(state, { memberId: by, role: "player" }, state.tokens[id]!));
    const tokenId = own.length > 0 && chance(r, 0.8) ? pick(r, own) : pick(r, tokenIds);
    state.log.push(diceLine(`8:${dice++}`, `free-${i}`, [damageRoll({ tokenId, ...(chance(r, 0.3) ? { crit: "doubleDice" as const } : {}) })], { by, to: chance(r, 0.4) ? "dm" : "all" }));
  }
  lines.forEach((data, i) => state.log.push({ id: `9:${i}`, at: AT, kind: "event", data }));
}

/** The order setting (docs/design-v1-combat-flow.md 11), and rows whose turn has come in the fight and its saved steps. */
function addOrderReveal(r: () => number, state: RoomState): void {
  state.meta.settings.playersSeeOrder = pick(r, ORDER_REVEALS);
  const mark = (entries: InitEntry[]) => {
    for (const e of entries) if (chance(r, 0.4)) e.hadTurn = true;
  };
  if (state.encounter) mark(state.encounter.entries);
  for (const step of state.encounterHistory) mark(step.encounter.entries);
}

/**
 * Companion stat blocks (docs/design-v1-companion-stat-blocks.md 3.1), with
 * no draw of their own so the seeds keep what they hold: the first
 * character keeps one with a picture and one copied from the SRD, and the
 * second one more.
 */
function addCompanionBlocks(state: RoomState): void {
  const [first, second] = Object.keys(state.characters).sort();
  if (first !== undefined) {
    state.companionBlocks.cb0 = companionBlock("cb0", first, { defaultImage: imageRef("img-cb0") });
    state.companionBlocks.cb1 = companionBlock("cb1", first, { name: "Owl", size: "tiny", type: "Beast", fromSrd: "owl" });
  }
  if (second !== undefined) state.companionBlocks.cb2 = companionBlock("cb2", second, { name: "Wolf", size: "medium", type: "Beast" });
  // Companions in turn link one of their character's blocks, an SRD block, a block deleted since, or none.
  const companions = Object.values(state.tokens)
    .filter((t) => t.companion !== undefined && "inline" in t.actor)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  companions.forEach((t, i) => {
    const actor = (t.actor as { inline: Actor }).inline;
    const own = Object.keys(state.companionBlocks).find((id) => state.companionBlocks[id]!.characterId === t.companion!.of);
    if (i % 4 === 0 && own !== undefined) actor.blockId = own;
    else if (i % 4 === 1) actor.srdId = "owl";
    else if (i % 4 === 2) actor.blockId = "cb-deleted";
  });
}

/**
 * Companions (docs/design-v1-combat-flow.md 3.6): creatures and effects of
 * random characters, of every turn an effect may take, owned as their
 * characters are and never numbered, a `shared` one's Reaction spent now
 * and then. The rows of those that act on their character's turn leave the
 * fight and its history, as the rules keep them, and saved steps name the
 * Reactions their Next cleared.
 */
function addCompanions(r: () => number, state: RoomState): void {
  const characterIds = Object.keys(state.characters);
  if (characterIds.length === 0) return;
  for (const token of Object.values(state.tokens)) {
    if (token.kind === "pc" || !("inline" in token.actor) || !chance(r, 0.3)) continue;
    const of = pick(r, characterIds);
    const turn = token.kind === "object" ? pick(r, ["shared", "none"] as const) : pick(r, ["own", "shared", "none"] as const);
    token.companion = { of, turn, ...(turn === "shared" && chance(r, 0.5) ? { reactionUsed: true as const } : {}) };
    token.ownerIds = [...state.characters[of]!.ownerIds];
    delete token.number;
  }
  Object.assign(state, normalizeCompanionState(state));
  const shared = Object.values(state.tokens).filter((t) => t.companion?.turn === "shared").map((t) => t.id);
  for (const step of state.encounterHistory) {
    if (shared.length > 0 && chance(r, 0.5)) step.companionReactions = [pick(r, shared)];
  }
}

const BLOCK_IDS = ["blockaaaaaaa", "blockbbbbbbb", "blockccccccc", "blockddddddd"] as const;
const ROLL_TESTS: RollTest[] = [
  { kind: "save", choices: [{ ability: "dex" }] },
  { kind: "save", choices: [{ ability: "str" }, { ability: "dex" }] },
  { kind: "check", choices: [{ ability: "wis", skill: "perception" }] },
  { kind: "check", choices: [{ ability: "str", skill: "athletics" }, { ability: "dex", skill: "acrobatics" }] },
];

/** A journal page of each kind of reader, with plain, hidden and revealed blocks (docs/design-v1-dm-tools.md 3.7). */
function randomPage(r: () => number, id: string): JournalPage {
  const blocks = BLOCK_IDS.slice(0, int(r, 0, 4)).map((blockId) => {
    const kind = int(r, 0, 2);
    return kind === 0 ? { id: blockId, text: `Plain ${blockId}` } : { id: blockId, text: `Secret ${blockId} of ${id}`, secret: { revealed: kind === 2 } };
  });
  const page: JournalPage = { id, rev: int(r, 0, 5), title: `Page ${id}`, access: pick(r, ["dm", "all", { member: "p1" }, { member: "p2" }, { member: "ghost" }] as const), blocks };
  if (chance(r, 0.3)) page.folder = "Lore";
  return page;
}

/**
 * Wave 5's state (docs/design-v1-dm-tools.md): journal pages of every
 * reader, pins with and without pages (one naming a page that is gone, which
 * projection must survive), roll requests under both switches with answers,
 * marks and replaced answers, their log lines, the drawing setting, links to
 * room monsters, and shipped icons.
 */
function addDmTools(r: () => number, state: RoomState): void {
  const pageIds: string[] = [];
  for (let i = 0; i < int(r, 0, 4); i++) {
    const id = `pg${i}`;
    pageIds.push(id);
    state.journal[id] = randomPage(r, id);
  }
  for (let i = 0; i < int(r, 0, 4); i++) {
    const id = `pin${i}`;
    state.pins[id] = { id, rev: int(r, 0, 3), sceneId: pick(r, ["s1", "s2"]), x: int(r, 0, 30) + 0.5, y: int(r, 0, 30) + 0.5, color: "#ff8800", visibility: pick(r, ["all", "all", "dm"] as const) };
    if (chance(r, 0.6)) state.pins[id]!.pageId = chance(r, 0.9) && pageIds.length > 0 ? pick(r, pageIds) : "missing-page";
    if (chance(r, 0.5)) state.pins[id]!.label = "Here";
  }
  const creatures: ({ tokenId: string } | { characterId: string })[] = [
    ...Object.keys(state.characters).map((characterId) => ({ characterId })),
    ...Object.keys(state.tokens).map((tokenId) => ({ tokenId })),
    { tokenId: "missing-token" },
  ];
  const marks: LogEvent[] = [];
  for (let i = 0; i < int(r, 0, 3); i++) {
    const id = `r${i}`;
    const targets = [...new Map(Array.from({ length: int(r, 1, 4) }, () => pick(r, creatures)).map((t) => [JSON.stringify(t), t])).values()].map((t) => {
      const answer = int(r, 0, 4);
      const target: RollRequest["targets"][number] = { ...t };
      // A save failed without rolling, the player's own choice (RollAnswer.noRoll).
      if (answer === 4) Object.assign(target, { result: "fail", noRoll: true, by: pick(r, ["p1", "p2"]) });
      if (answer >= 1 && answer <= 3) {
        target.total = int(r, -2, 25);
        target.by = pick(r, ["p1", "p2", "dm1"]);
      }
      if (answer === 2 || answer === 3) target.result = pick(r, ["pass", "fail"] as const);
      if (answer === 3) target.previous = { total: int(r, 1, 20), result: pick(r, ["pass", "fail"] as const) };
      return target;
    });
    const request: RollRequest = { id, rev: int(r, 1, 6), test: pick(r, ROLL_TESTS), dcShown: chance(r, 0.5), resultShown: chance(r, 0.5), at: AT, targets };
    if (chance(r, 0.7)) request.dc = int(r, 5, 25);
    if (chance(r, 0.3)) request.note = "against the poison";
    state.rolls[id] = request;
    const first = targets[0];
    if (first) {
      const line: LogEvent = { type: "roll", test: request.test, ...("tokenId" in first ? { tokenId: first.tokenId! } : { characterId: first.characterId! }) };
      if (first.total !== undefined) line.total = first.total;
      if (first.result !== undefined) line.result = first.result;
      if (first.noRoll) line.noRoll = true;
      if (request.dc !== undefined) {
        line.dc = request.dc;
        if (request.dcShown) line.dcShown = true;
      }
      if (request.resultShown) line.resultShown = true;
      state.log.push({ id: `5:${i}`, at: AT, kind: "event", data: line });
      // The DM's bare mark on a creature still waiting: a result alone, which no player's answer writes.
      if (first.total === undefined && first.result === undefined) marks.push({ ...line, result: "pass" });
    }
  }
  // After every request's line, in the log's own order of ids.
  marks.forEach((data, i) => state.log.push({ id: `6:${i}`, at: AT, kind: "event", data }));
  if (chance(r, 0.5)) state.meta.settings.playersDraw = pick(r, ["none", "all", ["p1"]] as const);
  for (const t of Object.values(state.tokens)) {
    if ("inline" in t.actor && chance(r, 0.3)) t.actor.inline.monsterId = pick(r, ["m0", "missing-monster"]);
    if (chance(r, 0.2)) t.image = { icon: pick(r, ["lorc/wolf-head", "delapouite/goblin-head"]), color: "#336699" };
  }
  for (const c of Object.values(state.characters)) if (chance(r, 0.2)) c.actor.monsterId = "m0";
}

/**
 * Wave 5's ops (docs/design-v1-dm-tools.md): for the DM, journal pages and
 * reveals, pins, roll requests with answers, marks, reopens and closes,
 * group edits and the drawing setting. For a player, answers, owners' group
 * edits and conditions on several creatures.
 */
function dmToolOp(r: () => number, state: RoomState, who: Viewer, ctx: { anyToken: () => string; target: () => { tokenId: string } | { characterId: string }; seqId: string }): Op {
  const pageIds = Object.keys(state.journal);
  const anyPage = () => (pageIds.length > 0 ? pick(r, pageIds) : "missing-page");
  const rollIds = Object.keys(state.rolls);
  const anyRoll = () => (rollIds.length > 0 ? pick(r, rollIds) : "missing-roll");
  const answerTarget = (rollId: string): { tokenId: string } | { characterId: string } => {
    const targets = state.rolls[rollId]?.targets ?? [];
    if (targets.length === 0 || !chance(r, 0.9)) return ctx.target();
    const t = pick(r, targets);
    return t.tokenId !== undefined ? { tokenId: t.tokenId } : { characterId: t.characterId! };
  };
  const tokens = [...new Set(Array.from({ length: int(r, 1, 3) }, ctx.anyToken))];
  if (who.role === "player") {
    switch (int(r, 0, 3)) {
      case 0:
      case 1: {
        const rollId = anyRoll();
        return chance(r, 0.8)
          ? { t: "roll.answer", rollId, target: answerTarget(rollId), total: int(r, -2, 25), ...(chance(r, 0.3) ? { choice: 0 as const } : {}), tag: ctx.seqId }
          : { t: "roll.answer", rollId, target: answerTarget(rollId), result: "fail", tag: ctx.seqId };
      }
      case 2:
        return { t: "token.updateMany", tokenIds: tokens, patch: chance(r, 0.5) ? { light: chance(r, 0.7) ? { bright: 20, dim: 20 } : null } : { image: { icon: "lorc/wolf-head", color: "#123456" } } };
      default:
        return { t: "actor.effects", add: tokens.map((tokenId, i) => ({ target: { tokenId }, effect: { id: `${ctx.seqId}-${i}`, key: "frightened" as const } })) };
    }
  }
  switch (int(r, 0, 13)) {
    case 0:
      return {
        t: "journal.create",
        page: {
          id: ctx.seqId,
          title: "New page",
          access: pick(r, ["dm", "all", { member: "p1" }, { member: "p2" }] as const),
          blocks: [
            { id: BLOCK_IDS[0], text: "Open" },
            { id: BLOCK_IDS[1], text: "Hush", secret: true },
          ],
        },
      };
    case 1:
      return { t: "journal.update", pageId: anyPage(), patch: chance(r, 0.5) ? { access: pick(r, ["dm", "all", { member: "p1" }, { member: "p2" }] as const) } : { blocks: [{ id: BLOCK_IDS[1], text: `Rewritten ${ctx.seqId}`, secret: true }, { id: BLOCK_IDS[2], text: "Open again" }] } };
    case 2: {
      const pageId = anyPage();
      const secret = state.journal[pageId]?.blocks.find((b) => b.secret);
      return { t: "journal.reveal", pageId, blockId: secret?.id ?? BLOCK_IDS[0], revealed: chance(r, 0.6) };
    }
    case 3:
      return { t: "journal.delete", pageId: anyPage() };
    case 4:
      return { t: "pin.put", pin: { id: chance(r, 0.5) ? ctx.seqId : pick(r, ["pin0", "pin1"]), sceneId: pick(r, ["s1", "s2"]), x: int(r, 0, 30) + 0.5, y: int(r, 0, 30) + 0.5, color: "#ff8800", visibility: pick(r, ["all", "dm"] as const), ...(chance(r, 0.6) ? { pageId: anyPage() } : {}) } };
    case 5:
      return { t: "pin.remove", pinId: pick(r, ["pin0", "pin1", "pin2"]) };
    case 6:
      return { t: "roll.ask", request: { id: ctx.seqId, test: pick(r, ROLL_TESTS), ...(chance(r, 0.7) ? { dc: int(r, 5, 25) } : {}), dcShown: chance(r, 0.5), resultShown: chance(r, 0.5), targets: [...new Map([ctx.target(), ctx.target()].map((t) => [JSON.stringify(t), t])).values()] } };
    case 7: {
      const rollId = anyRoll();
      return { t: "roll.answer", rollId, target: answerTarget(rollId), ...(chance(r, 0.5) ? { total: int(r, 0, 25) } : { result: pick(r, ["pass", "fail"] as const) }), tag: ctx.seqId };
    }
    case 8: {
      const rollId = anyRoll();
      return { t: "roll.reopen", rollId, target: answerTarget(rollId) };
    }
    case 9:
      return { t: "roll.close", rollIds: [anyRoll()] };
    case 10:
      return { t: "token.updateMany", tokenIds: tokens, patch: pick(r, [{ visibility: "dm" as const }, { visibility: "all" as const }, { ownerIds: ["p1"] }, { ownerIds: [] }, { hpVisibility: "exact" as const }, { image: { icon: "lorc/wolf-head", color: "#336699" } }]) };
    case 11:
      return { t: "token.deleteMany", tokenIds: tokens };
    case 12:
      return { t: "actor.effects", add: tokens.map((tokenId, i) => ({ target: { tokenId }, effect: { id: `${ctx.seqId}-${i}`, key: "frightened" as const, hiddenFromPlayers: chance(r, 0.3) ? true : undefined } })) };
    default:
      return { t: "room.update", settings: { playersDraw: pick(r, ["none", "all", ["p1"], ["p2"]] as const) } };
  }
}

/** Explored bits: a few random rectangles of cells revealed in one tile, never empty. */
function randomExploredBits(r: () => number): string {
  const bytes = new Uint8Array(TILE_BYTES);
  for (let n = 0; n < int(r, 1, 3); n++) {
    const x0 = int(r, 0, 12);
    const y0 = int(r, 0, 12);
    const w = int(r, 1, 4);
    const h = int(r, 1, 4);
    for (let sy = y0 * 4; sy < (y0 + h) * 4; sy++) {
      for (let sx = x0 * 4; sx < (x0 + w) * 4; sx++) {
        const i = sy * 64 + sx;
        bytes[i >> 3] = bytes[i >> 3]! | (1 << (i & 7));
      }
    }
  }
  return encodeTile(bytes);
}

/**
 * Wave 4's data (docs/design-v1-maps-vision.md section 4): scenes with party
 * vision on or off, movement blocked or not, the party's explored layer on
 * tiles the DM's fog holds and on tiles it does not, a vision scene whose
 * vision was turned off after exploring, heights and stairs in chunks,
 * squeezed tokens, carried lights and party members, a phase that brings
 * night, and the DM's teleport lines.
 */
function addVisionThings(r: () => number, state: RoomState): void {
  for (const scene of Object.values(state.scenes)) {
    if (chance(r, 0.5)) scene.vision = { on: chance(r, 0.7), light: pick(r, ["bright", "dim", "dark"] as const) };
    if (chance(r, 0.5)) scene.blockMovement = chance(r, 0.7);
    const across = Math.ceil(scene.bounds.w / 16);
    const down = Math.ceil(scene.bounds.h / 16);
    for (let i = 0; i < int(r, 0, 3); i++) {
      const tx = int(r, 0, across - 1);
      const ty = int(r, 0, down - 1);
      state.exploredTiles[`${scene.id}:${tx},${ty}`] = { sceneId: scene.id, tx, ty, rev: int(r, 1, 9), bits: randomExploredBits(r) };
    }
  }
  for (const chunk of Object.values(state.buildChunks)) {
    if (chance(r, 0.4)) {
      const heights = new Uint8Array(TILE_BYTES);
      for (let i = 0; i < 20; i++) heights[int(r, 0, 255) * 2] = pick(r, [5, 10, 20]);
      chunk.heights = encodeTile(heights);
    }
    if (chance(r, 0.3)) chunk.up = Array.from({ length: 256 }, () => (chance(r, 0.1) ? pick(r, ["a", "n", "e", "s", "w"]) : ".")).join("");
  }
  for (const t of Object.values(state.tokens)) {
    if (t.size === "large" && chance(r, 0.3)) t.squeeze = true;
    if (chance(r, 0.25)) t.light = { bright: pick(r, [5, 20, 30]), dim: pick(r, [5, 20, 30]) };
    if (t.kind !== "pc" && chance(r, 0.15)) t.partyVision = true;
  }
  const s1 = state.scenes.s1!;
  if (s1.phases && chance(r, 0.5)) s1.phases = s1.phases.map((phase, i) => (i === 1 ? { ...phase, light: "dark" } : phase));
  const tokenIds = Object.keys(state.tokens);
  for (let i = 0; i < int(r, 0, 2) && tokenIds.length > 0; i++) {
    state.log.push({ id: `4:${i}`, at: AT, kind: "event", data: { type: "teleport", tokenId: pick(r, tokenIds), past: pick(r, ["wall", "ledge"] as const) } });
  }
}

/** A door of any state, secret and found or not, now and then, or a wall or a window. */
function randomWallFeature(r: () => number): WallFeature {
  if (chance(r, 0.4)) return pick(r, [{ kind: "wall" }, { kind: "window" }] as const);
  return { kind: "door", state: pick(r, ["open", "closed", "locked"] as const), secret: chance(r, 0.5), discovered: chance(r, 0.4) };
}

/** A free wall on the 1/64 lattice, at most a few cells long, inside a scene of at least 20 cells a side. */
function randomFreeWall(r: () => number, id: string): FreeWall {
  const x = int(r, 0, 18 * 64) / 64;
  const y = int(r, 0, 18 * 64) / 64;
  return { id, a: [x, y], b: [x + int(r, 1, 128) / 64, y + int(r, 0, 128) / 64], f: randomWallFeature(r) };
}

const OVERLAYS: TerrainId[] = ["water", "difficult", "stairs", "pillar"];

/**
 * Wave 3's map data (docs/design-v1-maps-vision.md section 3): each scene's
 * automatic walls rule, free walls with secret and locked doors, overlay
 * terrain beside secret edge doors, across a chunk border too, stamps
 * hidden or not and under fog or not, lights, a folder and a thumbnail, and
 * phases on a scene with a map, whose other images and names are the DM's.
 */
function addMapThings(r: () => number, state: RoomState): void {
  for (const scene of Object.values(state.scenes)) {
    const rule = pick(r, [undefined, "all", "floor", "off"] as const);
    if (rule !== undefined) scene.autoWalls = rule;
    if (chance(r, 0.4)) scene.folder = "Folder-Act-One";
    if (chance(r, 0.4)) scene.thumb = `thumb-${scene.id}`;
    const id = scene.id;
    for (const [cx, cy] of [
      [0, 0],
      [1, 0],
    ] as const) {
      if (!chance(r, 0.6)) continue;
      const key = `${id}:${cx},${cy}`;
      const chunk = state.buildChunks[key] ?? { sceneId: id, cx, cy, rev: 0, cells: {}, edges: {} };
      const cells = { ...chunk.cells };
      const edges = { ...chunk.edges };
      // A secret door between cells of every kind, the chunk border at x = 16 included.
      const x = cx * 16 + int(r, 0, 3);
      const y = int(r, 2, 6);
      const paint = (cell: string) => {
        const choice = int(r, 0, 2);
        if (choice === 0) delete cells[cell];
        else cells[cell] = choice === 1 ? "stone" : pick(r, OVERLAYS);
      };
      paint(`${x},${y}`);
      paint(`${x - 1},${y}`);
      paint(`${x},${y - 1}`);
      if (x - 1 >= 0) edges[`${x},${y},w`] = { kind: "door", state: pick(r, ["closed", "locked"] as const), secret: true, discovered: chance(r, 0.3) };
      edges[`${x},${y},n`] = { kind: "door", state: "closed", secret: true, discovered: false };
      const walls: FreeWall[] = [];
      for (let i = 0; i < int(r, 0, 4); i++) {
        const w = randomFreeWall(r, `fw${cx}${i}`.padEnd(12, "x"));
        const at = wallChunk(w);
        if (at.cx === cx && at.cy === cy) walls.push(w);
      }
      const next = { ...chunk, cells, edges };
      if (walls.length > 0) next.walls = walls;
      state.buildChunks[key] = next;
    }
    for (let i = 0; i < int(r, 0, 4); i++) {
      const stampId = `stamp-${id}-${i}`;
      state.stamps[stampId] = {
        id: stampId,
        rev: 0,
        sceneId: id,
        art: chance(r, 0.5) ? { key: "oak-tree" } : { assetId: `img-stamp-${id}-${i}` },
        x: int(r, 0, 38) / 2,
        y: int(r, 0, 38) / 2,
        w: pick(r, [0.5, 1, 2.5]),
        h: pick(r, [0.5, 1, 3]),
        rotation: pick(r, [0, 45, 90, -30]),
        z: i,
        visibility: pick(r, ["all", "all", "dm"] as const),
      };
    }
    for (let i = 0; i < int(r, 0, 2); i++) {
      const lightId = `light-${id}-${i}`;
      state.lights[lightId] = { id: lightId, rev: 0, sceneId: id, x: int(r, 0, 19 * 4) / 4, y: int(r, 0, 19 * 4) / 4, bright: 20, dim: 20, on: chance(r, 0.7), walls: chance(r, 0.5), label: "Light-Brazier" };
    }
  }
  const s1 = state.scenes.s1!;
  if (s1.map && chance(r, 0.6)) {
    const day = { id: "ph-day", name: "Phase-Day", assetId: s1.map.assetId, widthPx: s1.map.widthPx, heightPx: s1.map.heightPx };
    const fire = { id: "ph-fire", name: "Phase-On-Fire", assetId: "map-s1-fire", widthPx: s1.map.widthPx * 2, heightPx: s1.map.heightPx * 2 };
    s1.phases = [day, fire];
    s1.phaseId = "ph-day";
    s1.phaseGrid = { refWidthPx: s1.map.widthPx, refHeightPx: s1.map.heightPx, cellPx: s1.map.cellPx, originPx: s1.map.originPx };
  }
}

/**
 * Paths (rules/path.ts): the turn under way named by a seq most of the
 * time, the active creature's path of it more often than not, and paths of
 * earlier turns on other tokens. Stops are seen or not, and later legs now
 * and then uncounted or joined through an unseen stop.
 */
function addPaths(r: () => number, state: RoomState): void {
  const start = state.encounter?.turnStart;
  if (start && chance(r, 0.8)) start.seq = int(r, 1, 50);
  for (const t of Object.values(state.tokens)) {
    const active = start?.seq !== undefined && start.tokenId === t.id;
    if (!chance(r, active ? 0.8 : 0.3)) continue;
    const stops = Array.from({ length: int(r, 1, 5) }, (_, i) => ({
      x: int(r, 0, 30),
      y: int(r, 0, 30),
      elevation: pick(r, [0, 0, 10]),
      ...(i > 0 && chance(r, 0.3) ? { uncounted: true as const } : {}),
      ...(chance(r, 0.6) ? { seen: true as const } : {}),
      ...(i > 0 && chance(r, 0.2) ? { joinedUnseen: true as const } : {}),
    }));
    t.path = { turn: active && chance(r, 0.8) ? start.seq! : int(r, 51, 99), stops };
  }
}

/**
 * Areas that remind the table when they hit a creature again, and the
 * lines they wrote: about creatures seen or not, areas hidden or not, and
 * now and then an area or a creature that is gone.
 */
function addAreaReminders(r: () => number, state: RoomState): void {
  const templateIds = Object.keys(state.templates);
  const tokenIds = Object.keys(state.tokens);
  for (const id of templateIds) if (chance(r, 0.5)) state.templates[id]!.triggers = pick(r, [["enter", "turnEnd"], ["turnStart"], ["enter"]] as const).slice();
  if (tokenIds.length === 0) return;
  for (let i = 0; i < int(r, 0, 4); i++) {
    const data: LogEvent = {
      type: "area",
      templateId: templateIds.length > 0 && chance(r, 0.9) ? pick(r, templateIds) : "missing-template",
      tokenId: chance(r, 0.9) ? pick(r, tokenIds) : "missing-token",
      trigger: pick(r, ["enter", "turnStart", "turnEnd"] as const),
      area: "Spirit Guardians",
      ...(chance(r, 0.3) ? { moved: true as const } : {}),
      ...(chance(r, 0.7) ? { seen: true as const } : {}),
      ...(chance(r, 0.2) ? { hidden: true as const } : {}),
    };
    state.log.push({ id: `2:${i}`, at: AT, kind: "event", data });
  }
}

/**
 * HP lines as the reducer writes them now: what was left, what the change
 * replaced (hidden effects included), now and then the DM taking one back,
 * and rests. They come after the area lines in the log, so their ids do too,
 * since writing a log line keeps the log in id order (keys.ts writeEntity).
 */
function addHpLines(r: () => number, state: RoomState): void {
  const vitals = (cur: number) => ({ hp: { cur, max: 20, temp: 0 }, life: "alive" as const, deathSaves: { ok: 0, fail: 0 } });
  let n = 0;
  for (const tokenId of Object.keys(state.tokens)) {
    if (!chance(r, 0.4)) continue;
    const id = `3:${n++}`;
    const seen = chance(r, 0.7) ? { seen: true as const } : {};
    const removed = chance(r, 0.4) ? [{ id: "conc", key: "concentrating" as const, spell: "Bless", hiddenFromPlayers: true }] : undefined;
    state.log.push({
      id,
      at: AT,
      kind: "event",
      data: { type: "hp", tokenId, ...seen, change: "damage", amount: 5, label: "Bloodied", left: { cur: 9, max: 20, temp: 0 }, revert: { before: vitals(14), after: vitals(9), ...(removed ? { removed } : {}) } },
    });
    if (chance(r, 0.3)) {
      state.log.push({ id: `3:${n++}`, at: AT, kind: "event", data: { type: "hp", tokenId, ...seen, change: "damage", amount: 5, back: true, of: id, left: { cur: 14, max: 20, temp: 0 }, label: "Healthy" } });
    }
    if (chance(r, 0.2)) {
      state.log.push({ id: `3:${n++}`, at: AT, kind: "event", data: { type: "rest", tokenId, ...seen, kind: "short", amount: 4, left: { cur: 18, max: 20, temp: 0 }, label: "Healthy" } });
    }
  }
}

/** Encounters the DM built ahead: SRD monsters, the room's own (some deleted since), and a party now and then. */
function addSavedEncounters(r: () => number, state: RoomState): void {
  const monsterIds = Object.keys(state.monsters);
  for (let i = 0; i < int(r, 0, 3); i++) {
    const id = `enc${i}`;
    const monsters: SavedEncounterMonster[] = [{ srdId: pick(r, ["goblin-warrior", "bandit", "owlbear"]), count: int(r, 1, 6) }];
    if (chance(r, 0.6)) monsters.push({ monsterId: monsterIds.length > 0 && chance(r, 0.8) ? pick(r, monsterIds) : "deleted-monster", count: int(r, 1, 3), inLair: chance(r, 0.3) });
    const encounter: SavedEncounter = { id, rev: 0, name: pick(r, ["Ambush at the ford", "Crypt guards"]), monsters };
    if (chance(r, 0.4)) encounter.party = [{ count: int(r, 1, 5), level: int(r, 1, 20) }];
    state.savedEncounters[id] = encounter;
  }
}

/** Kept rulers, each stop free or on a token of either scene, a missing one now and then. */
function addKeptRulers(r: () => number, state: RoomState): void {
  const tokenIds = Object.keys(state.tokens);
  for (let i = 0; i < int(r, 0, 3); i++) {
    const id = `k${i}`;
    const stops = int(r, 2, 4);
    const anchors = Array.from({ length: stops }, () => (tokenIds.length > 0 && chance(r, 0.4) ? (chance(r, 0.9) ? pick(r, tokenIds) : "missing-token") : null));
    state.drawings[id] = drawing(id, {
      kind: "ruler",
      sceneId: pick(r, ["s1", "s2"]),
      ownerId: pick(r, ["dm1", "p1", "p2"]),
      visibility: pick(r, ["all", "all", "dm"] as const),
      points: Array.from({ length: stops * 2 }, () => int(r, 0, 30) + 0.5),
      ...(anchors.some((a) => a !== null) ? { anchors } : {}),
    });
  }
}

/**
 * Where the active row's creature began its turn: usually where it stands,
 * sometimes moved since, on another scene since, or for a row that is no
 * longer the active one, and marked seen or not either way.
 */
function addTurnStart(r: () => number, state: RoomState): void {
  const encounter = state.encounter;
  const active = encounter?.entries.find((e) => e.id === encounter.activeEntryId);
  if (!encounter || !active?.tokenId || !chance(r, 0.8)) return;
  const t = state.tokens[active.tokenId];
  if (!t) return;
  encounter.turnStart = {
    entryId: chance(r, 0.9) ? active.id : "n-other",
    tokenId: t.id,
    sceneId: chance(r, 0.9) ? t.sceneId : "s-elsewhere",
    x: chance(r, 0.5) ? t.x : int(r, 0, 30),
    y: chance(r, 0.5) ? t.y : int(r, 0, 30),
    elevation: pick(r, [0, 0, 10]),
    ...(chance(r, 0.6) ? { seen: true as const } : {}),
  };
}

/** A random, mostly valid op from the DM's or a player's point of view, for the fan-out invariant. */
export function randomOp(r: () => number, state: RoomState, who: Viewer): Op {
  const tokens = Object.values(state.tokens);
  const tokenIds = tokens.map((t) => t.id);
  const characterIds = Object.keys(state.characters);
  const templateIds = Object.keys(state.templates);
  const drawingIds = Object.keys(state.drawings);
  const monsterIds = Object.keys(state.monsters);
  const anyMonster = () => (monsterIds.length > 0 ? pick(r, monsterIds) : "missing-monster");
  const encounterIds = Object.keys(state.savedEncounters);
  const anyEncounter = () => (encounterIds.length > 0 ? pick(r, encounterIds) : "missing-encounter");
  const entries = state.encounter?.entries ?? [];
  const anyToken = () => (tokenIds.length > 0 ? pick(r, tokenIds) : "missing-token");
  const anyCharacter = () => (characterIds.length > 0 ? pick(r, characterIds) : "missing-character");
  const target = (): { tokenId: string } | { characterId: string } => (chance(r, 0.7) ? { tokenId: anyToken() } : { characterId: anyCharacter() });
  const sceneId = pick(r, ["s1", "s2"]);
  const n = int(r, 0, 99);
  const seqId = `${who.memberId}-${Math.floor(r() * 1e9)}`;
  /** A kept ruler of two or three stops, each on a token (seen or not, or gone) or free. */
  const keptRuler = (ownerId: string, on: string): Op => {
    const anchors = Array.from({ length: int(r, 2, 3) }, () => (chance(r, 0.6) ? anyToken() : null));
    const { rev: _rev, ...d } = drawing(seqId, {
      kind: "ruler",
      sceneId: on,
      points: anchors.flatMap(() => [int(r, 0, 30) + 0.5, int(r, 0, 30) + 0.5]),
      ownerId,
      visibility: who.role === "dm" ? pick(r, ["all", "dm"] as const) : "all",
      ...(anchors.some((a) => a !== null) ? { anchors } : {}),
    });
    return { t: "drawing.create", drawing: d };
  };

  /** Whether the active creature's last move counts, which only the DM and its owners may say. */
  const countLeg = (): Op => ({ t: "token.countLeg", tokenId: state.encounter?.turnStart?.tokenId ?? anyToken(), counts: chance(r, 0.5) });

  // The tracker's ops (features sections 7, 10 and 15), about one draw in five.
  if (chance(r, 0.2)) return trackerOp(r, state, who, { anyToken, target, seqId });
  // Wave 5's journal, pins, rolls and group edits (docs/design-v1-dm-tools.md), about one in six.
  if (chance(r, 0.16)) return dmToolOp(r, state, who, { anyToken, target, seqId });
  // Companions (docs/design-v1-combat-flow.md 3.6), about one in twelve.
  if (chance(r, 0.08)) return companionOp(r, state, who, { anyToken, anyCharacter, seqId });
  // Asks for saves (docs/design-v1-player-save-spell.md 5.3), about one in sixteen.
  if (chance(r, 0.06)) return castOp(r, state, who, { anyToken, seqId });
  // Attached tokens (docs/design-v1-attach.md), about one in fourteen.
  if (chance(r, 0.07)) return attachOp(r, state, anyToken);
  // Traps (docs/design-v1-traps.md), about one in sixteen.
  if (chance(r, 0.06)) return trapOp(r, state, anyToken, seqId);

  if (who.role === "player") {
    // Wave 4's moves, doors and lights, now and then.
    if (n >= 90) return visionOp(r, state, state.meta.playerSceneId ?? "s1", who, anyToken);
    switch (n % 11) {
      case 0:
        return { t: "token.move", tokenId: anyToken(), x: int(r, 0, 30), y: int(r, 0, 30) };
      case 1:
        return { t: "actor.hp", target: target(), change: { kind: "damage", amount: int(r, 1, 12) } };
      case 2:
        return { t: "actor.hp", target: target(), change: { kind: "heal", amount: int(r, 1, 12) } };
      case 3: {
        const { rev: _rev, ...d } = drawing(seqId, { ownerId: who.memberId, sceneId: state.meta.playerSceneId ?? "s1" });
        return { t: "drawing.create", drawing: d };
      }
      case 4:
        return { t: "log.whisper", to: [pick(r, ["dm1", "p1", "p2"])], text: "secret" };
      case 5:
        return { t: "actor.effect.add", target: target(), effect: { id: seqId, key: "poisoned", duration: { mode: "turnEnd", of: { tokenId: anyToken() } } } };
      case 6:
        return { t: "encounter.next" };
      case 7:
        return keptRuler(who.memberId, state.meta.playerSceneId ?? "s1");
      case 8:
        return { t: "token.update", tokenId: anyToken(), patch: chance(r, 0.5) ? { rangeRings: pick(r, [[], [30], [30, 120]]) } : { notes: chance(r, 0.8) ? "Smells of smoke" : null } };
      case 9:
        return countLeg();
      default:
        return { t: "log.chat", text: "hi" };
    }
  }

  // Wave 3's map ops, a tenth of the DM's draws, and wave 4's another tenth.
  if (n >= 90) return mapOp(r, state, sceneId, seqId);
  if (n >= 80) return visionOp(r, state, sceneId, who, anyToken);

  switch (n % 50) {
    case 0:
      return { t: "token.move", tokenId: anyToken(), x: int(r, 0, 34), y: int(r, 0, 34) };
    case 1:
      return { t: "token.update", tokenId: anyToken(), patch: { visibility: pick(r, ["all", "dm"] as const) } };
    case 2:
      return { t: "token.update", tokenId: anyToken(), patch: { ownerIds: pick(r, [[], ["p1"], ["p2"], ["dm1"]]) } };
    case 3:
      return { t: "token.update", tokenId: anyToken(), patch: { fogExempt: chance(r, 0.5), nameHidden: chance(r, 0.5) } };
    case 4:
      return { t: "token.update", tokenId: anyToken(), patch: { hpVisibility: pick(r, ["hidden", "label", "bar", "exact"] as const) } };
    case 5:
      return { t: "token.delete", tokenId: anyToken() };
    case 6:
      return { t: "actor.hp", target: target(), change: { kind: "damage", amount: int(r, 1, 25), crit: chance(r, 0.2) } };
    case 7:
      return { t: "actor.hp", target: target(), change: { kind: "heal", amount: int(r, 1, 10) } };
    case 8:
      return { t: "actor.effect.add", target: target(), effect: { id: seqId, key: pick(r, EFFECT_KEYS), duration: chance(r, 0.5) ? { mode: pick(r, ["turnStart", "turnEnd"] as const), of: { tokenId: anyToken() } } : undefined, hiddenFromPlayers: chance(r, 0.3) ? true : undefined } };
    case 9:
      return { t: "encounter.next" };
    case 10:
      return { t: "encounter.prev" };
    case 11:
      return state.encounter
        ? { t: "encounter.add", entries: [{ id: seqId, tokenId: anyToken(), hidden: chance(r, 0.4) }] }
        : { t: "encounter.start", entries: tokenIds.slice(0, 3).map((id, i) => ({ id: `${seqId}-${i}`, tokenId: id, value: int(r, 1, 20), hidden: chance(r, 0.3) })) };
    case 12:
      return entries.length > 0 ? { t: "encounter.remove", entryIds: [pick(r, entries).id] } : { t: "encounter.end" };
    case 13:
      return entries.length > 0 ? { t: "encounter.update", entryId: pick(r, entries).id, patch: { hidden: chance(r, 0.5) } } : { t: "log.chat", text: "x" };
    case 14:
      return { t: "fog.live", sceneId, ops: [{ id: seqId, mode: pick(r, ["reveal", "hide"] as const), shape: { kind: "rect", x: int(r, 0, 20), y: int(r, 0, 20), w: int(r, 1, 10), h: int(r, 1, 10) } }] };
    case 15:
      return { t: "scene.update", sceneId, patch: { fogEnabled: chance(r, 0.5) } };
    case 16:
      return { t: "room.setPlayerScene", sceneId };
    case 17:
      return { t: "room.update", settings: { pcHpVisibleToParty: chance(r, 0.5), playersSeeAoeOfOthers: chance(r, 0.5), playersSeeOrder: pick(r, ORDER_REVEALS) } };
    case 18:
      return { t: "template.create", template: { id: seqId, sceneId, shape: "sphere", size: 20, origin: { x: 2, y: 2, z: 0 }, yaw: 0, includeOrigin: true, color: "#ff0000", ownerId: pick(r, ["dm1", "p1"]), visibility: pick(r, ["all", "dm"] as const), attachedTo: chance(r, 0.5) ? anyToken() : undefined, casterId: chance(r, 0.5) ? anyToken() : undefined } };
    case 19:
      return templateIds.length > 0
        ? {
            t: "template.update",
            templateId: pick(r, templateIds),
            patch: {
              visibility: pick(r, ["all", "dm"] as const),
              attachedTo: chance(r, 0.5) ? anyToken() : null,
              ...(chance(r, 0.4) ? { triggers: chance(r, 0.8) ? (["enter", "turnEnd"] as ("enter" | "turnEnd")[]) : null } : {}),
              ...(chance(r, 0.3) ? { origin: { x: int(r, 0, 30), y: int(r, 0, 30), z: 0 } } : {}),
            },
          }
        : { t: "log.chat", text: "y" };
    case 20:
      return drawingIds.length > 0 ? { t: "drawing.delete", drawingId: pick(r, drawingIds) } : { t: "drawing.clear", sceneId, scope: "all" };
    case 21:
      return {
        t: "handout.show",
        handout: { id: seqId, ...(n < 50 ? { assetId: "img-h" } : { pages: [handoutPage("img-h"), handoutPage("img-h-2")] }), title: "Letter", to: pick(r, ["all", ["p1"], ["p2"]]) },
      };
    case 22: {
      if (n < 50) return { t: "log.whisper", to: [pick(r, ["p1", "p2"])], text: "dm whisper" };
      // A document saved or deleted in turn, with no draw of its own.
      const docIds = Object.keys(state.handoutDocs);
      return docIds[0] !== undefined && docIds.length % 2 === 1
        ? { t: "handoutDoc.delete", docId: docIds[0] }
        : { t: "handoutDoc.create", doc: { id: seqId, title: "Strange letter", pages: [handoutPage("img-h"), handoutPage("img-h-2")] } };
    }
    case 23:
      return { t: "character.update", characterId: anyCharacter(), patch: { ownerIds: pick(r, [[], ["p1"], ["p2"]]) } };
    case 24: {
      // Doors on chunk borders and the floor across them: a player's chunk reads the cells beside its north and west borders.
      const kind = int(r, 0, 2);
      if (kind === 0) {
        const feature = { kind: "door", state: pick(r, ["open", "closed", "locked"] as const), secret: chance(r, 0.5), discovered: chance(r, 0.5) } as const;
        return { t: "build.edge", sceneId, edges: [{ key: pick(r, ["0,0,n", "16,3,w", "3,16,n"]), feature }] };
      }
      const cells = [pick(r, ["15,3", "16,3", "3,15", "3,16"])];
      return kind === 1 ? { t: "build.paint", sceneId, terrain: "stone", cells } : { t: "build.erase", sceneId, cells };
    }
    case 25:
      return { t: "token.create", token: { id: seqId, sceneId, kind: pick(r, ["monster", "pc"] as const), name: "Goblin", size: "medium", x: int(r, 0, 20), y: int(r, 0, 20), actor: { inline: actor() }, visibility: pick(r, ["all", "dm"] as const), ownerIds: pick(r, [[], ["p1"]]) } };
    case 26:
      return { t: "token.update", tokenId: anyToken(), patch: { sceneId: pick(r, ["s1", "s2"]) } };
    case 27:
      return { t: "actor.life", target: target(), life: pick(r, ["alive", "dead", "dying"] as const) };
    case 28:
      return { t: "fog.reset", sceneId, to: pick(r, ["hidden", "revealed"] as const) };
    case 29:
      return { t: "build.label", sceneId, labelId: pick(r, ["l0", "l1", seqId]), label: chance(r, 0.8) ? { x: int(r, 0, 30), y: int(r, 0, 30), text: "Trap", size: pick(r, [1, 2]) } : null };
    case 30:
      return { t: "monster.create", monster: { id: seqId, ...blockOf(customMonster(seqId, { name: pick(r, ["Cave Lurker", "Mire Wight"]) })) } };
    case 31:
      return { t: "monster.update", monsterId: anyMonster(), patch: { ac: int(r, 10, 20), sizeAlt: chance(r, 0.5) ? "small" : null } };
    case 32:
      return { t: "monster.delete", monsterId: anyMonster() };
    case 33:
      return { t: "view.blackout", blackout: chance(r, 0.5) };
    case 34:
      return { t: "monster.update", monsterId: anyMonster(), patch: { defaultImage: chance(r, 0.7) ? imageRef(`img-${seqId}`) : null } };
    case 35:
      return { t: "monster.setSrdImage", srdId: pick(r, ["goblin-warrior", "bandit", "owlbear"]), image: chance(r, 0.7) ? imageRef(`img-${seqId}`) : null };
    case 36:
      return keptRuler(pick(r, ["dm1", "p1"]), sceneId);
    case 37:
      return { t: "token.update", tokenId: anyToken(), patch: { notes: chance(r, 0.8) ? "Watch the door" : null } };
    case 38:
      return { t: "token.update", tokenId: anyToken(), patch: { altImages: chance(r, 0.7) ? [imageRef(`img-alt-${seqId}`)] : null } };
    case 39:
      return { t: "token.update", tokenId: anyToken(), patch: { rangeRings: pick(r, [[], [30], [30, 60, 120], [5, 1000]]) } };
    case 40:
      return { t: "room.update", settings: { playersMoveAny: pick(r, ["none", "all", ["p1"], ["p2"], ["p1", "p2"]] as const) } };
    case 41: {
      // The active creature's moves on its turn are recorded on its path, which players get only in part.
      const active = state.encounter?.turnStart?.tokenId;
      return { t: "token.move", tokenId: active && chance(r, 0.8) ? active : anyToken(), x: int(r, 0, 34), y: int(r, 0, 34), elevation: chance(r, 0.3) ? pick(r, [0, 10]) : undefined };
    }
    case 42:
      return countLeg();
    case 43: {
      // An area's damage: distinct creatures, hidden and fogged ones included, full or half.
      const ids = [...new Set(Array.from({ length: int(r, 1, 4) }, anyToken))];
      return { t: "actor.damageMany", hits: ids.map((tokenId) => ({ target: { tokenId }, amount: pick(r, [14, 7]) })) };
    }
    case 44: {
      // Into an area, so the areas that hit on entering remind the table.
      const area = templateIds.length > 0 ? state.templates[pick(r, templateIds)]! : undefined;
      return area ? { t: "token.move", tokenId: anyToken(), x: Math.floor(area.origin.x), y: Math.floor(area.origin.y) } : { t: "encounter.next" };
    }
    case 45:
      return { t: "savedEncounter.create", encounter: { id: seqId, name: "Wolves", monsters: [{ srdId: "wolf", count: int(r, 1, 8) }, ...(monsterIds.length > 0 ? [{ monsterId: anyMonster(), count: 1 }] : [])] } };
    case 46:
      return { t: "savedEncounter.update", encounterId: anyEncounter(), patch: chance(r, 0.5) ? { name: "Renamed", party: chance(r, 0.5) ? [{ count: 4, level: int(r, 1, 20) }] : null } : { monsters: [{ srdId: "owlbear", count: 1, inLair: chance(r, 0.5) }] } };
    case 47:
      return { t: "savedEncounter.delete", encounterId: anyEncounter() };
    case 48: {
      const characterId = anyCharacter();
      const level = chance(r, 0.8) ? int(r, 1, 20) : null;
      // A Druid's known forms ride along, read from the level drawn rather than from r, so every other random op stays as it was.
      return { t: "character.update", characterId, patch: { level, knownForms: level === null ? [] : ["wolf", "owl", "black-bear"].slice(0, level % 4) } };
    }
    default:
      return { t: "member.update", memberId: "dm1", name: `DM ${int(r, 1, 9)}` };
  }
}

/**
 * The DM's wave 3 map ops: free walls with secret and locked doors, overlay
 * paint beside them, stamps, lights, automatic walls, folders, thumbnails,
 * phases, border edges and duplicates.
 */
function mapOp(r: () => number, state: RoomState, sceneId: string, seqId: string): Op {
  const wallId = seqId.replace(/[^A-Za-z0-9]/g, "").slice(-12).padStart(12, "w");
  const existingWall = Object.values(state.buildChunks).flatMap((c) => (c.sceneId === sceneId ? (c.walls ?? []).map((w) => ({ cx: c.cx, cy: c.cy, id: w.id })) : []));
  const stampIds = Object.values(state.stamps).filter((st) => st.sceneId === sceneId).map((st) => st.id);
  const lightIds = Object.values(state.lights).filter((l) => l.sceneId === sceneId).map((l) => l.id);
  const scene = state.scenes[sceneId];
  switch (int(r, 0, 11)) {
    case 0:
      return { t: "build.walls", sceneId, put: [randomFreeWall(r, wallId)] };
    case 1:
      return existingWall.length > 0 ? { t: "build.walls", sceneId, remove: [pick(r, existingWall)] } : { t: "build.walls", sceneId, put: [randomFreeWall(r, wallId)] };
    case 2:
      return { t: "build.paint", sceneId, terrain: pick(r, [...OVERLAYS, "stone"] as TerrainId[]), cells: [pick(r, ["15,3", "16,3", "1,3", "2,4", "17,2"])] };
    case 3:
      return {
        t: "build.stamps",
        sceneId,
        put: [{ id: `stamp-${seqId}`, art: chance(r, 0.5) ? { key: "crate" } : { assetId: `img-stamp-${seqId}` }, x: int(r, 0, 38) / 2, y: int(r, 0, 38) / 2, w: 1, h: 2, rotation: pick(r, [0, 90, 30]), z: 1, visibility: pick(r, ["all", "dm"] as const) }],
        ...(stampIds.length > 0 && chance(r, 0.4) ? { remove: [pick(r, stampIds)] } : {}),
      };
    case 4:
      return { t: "build.lights", sceneId, put: [{ id: `light-${seqId}`, x: int(r, 0, 76) / 4, y: int(r, 0, 76) / 4, bright: 20, dim: 20, on: true, walls: true }], ...(lightIds.length > 0 && chance(r, 0.4) ? { remove: [pick(r, lightIds)] } : {}) };
    case 5:
      return { t: "scene.update", sceneId, patch: { autoWalls: pick(r, ["all", "floor", "off"] as const) } };
    case 6:
      return { t: "scene.update", sceneId, patch: chance(r, 0.5) ? { folder: chance(r, 0.7) ? "Folder-Act-Two" : null } : { thumb: chance(r, 0.8) ? `thumb-${seqId}` : null } };
    case 7: {
      if (!scene?.map) return { t: "scene.setMap", sceneId, map: { assetId: "map-new", widthPx: 1000, heightPx: 800, cellPx: 50, originPx: { x: 0, y: 0 } } };
      const map = scene.map;
      const current = scene.phases ?? [{ id: "ph-a", name: "Phase-Day", assetId: map.assetId, widthPx: map.widthPx, heightPx: map.heightPx }];
      const extra = { id: `ph-${seqId}`, name: "Phase-Flooded", assetId: `map-${seqId}`, widthPx: map.widthPx * 2, heightPx: map.heightPx * 2 };
      return { t: "scene.update", sceneId, patch: { phases: chance(r, 0.7) ? [...current, extra].slice(-8) : current.slice(1).concat(current.slice(0, 1)) } };
    }
    case 8: {
      const phases = scene?.phases ?? [];
      return phases.length > 0 ? { t: "scene.setPhase", sceneId, phaseId: pick(r, phases).id } : { t: "scene.setGrid", sceneId, cellPx: 60, originPx: { x: 5, y: 5 } };
    }
    case 9:
      return { t: "build.edge", sceneId, edges: [{ key: pick(r, ["20,3,w", "3,20,n", "0,3,w"]), feature: randomWallFeature(r) }] };
    case 10:
      return { t: "scene.duplicate", sceneId, newSceneId: `copy-${seqId}`, name: "Copy", include: { creatures: chance(r, 0.5), characters: chance(r, 0.5), fog: chance(r, 0.5), drawings: chance(r, 0.5) } };
    default:
      return chance(r, 0.5) ? { t: "build.erase", sceneId, cells: [pick(r, ["15,3", "2,2", "5,5"])] } : { t: "scene.setMap", sceneId, map: null };
  }
}

/**
 * Wave 4's ops (docs/design-v1-maps-vision.md section 4): vision turned on
 * and off with its light, movement blocking, doors, heights and stairs
 * under tokens, squeezes and teleports, carried lights and party members,
 * and the server's explore, on vision scenes and others.
 */
function visionOp(r: () => number, state: RoomState, sceneId: string, who: Viewer, anyToken: () => string): Op {
  const doors = Object.values(state.buildChunks).flatMap((c) =>
    c.sceneId !== sceneId ? [] : [...Object.entries(c.edges).flatMap(([edge, f]) => (f.kind === "door" ? [{ edge }] : [])), ...(c.walls ?? []).flatMap((w) => (w.f.kind === "door" ? [{ cx: c.cx, cy: c.cy, id: w.id }] : []))],
  );
  const door = () => (doors.length > 0 ? pick(r, doors) : { edge: "0,0,n" });
  const cells = () => Array.from({ length: int(r, 1, 6) }, () => `${int(r, 0, 19)},${int(r, 0, 19)}`);
  if (who.role === "player") {
    switch (int(r, 0, 3)) {
      case 0:
        return { t: "token.move", tokenId: anyToken(), x: int(r, 0, 30), y: int(r, 0, 30), teleport: pick(r, ["wall", "ledge"] as const) };
      case 1:
        return { t: "door.set", sceneId, door: door(), state: pick(r, ["open", "closed"] as const) };
      case 2:
        return { t: "token.update", tokenId: anyToken(), patch: { light: chance(r, 0.7) ? { bright: 20, dim: 20 } : null } };
      default:
        return { t: "token.move", tokenId: anyToken(), x: int(r, 0, 30) + 0.5, y: int(r, 0, 30), squeeze: true };
    }
  }
  switch (int(r, 0, 9)) {
    case 0:
      return { t: "scene.update", sceneId, patch: { vision: { on: chance(r, 0.6), light: pick(r, ["bright", "dim", "dark"] as const) } } };
    case 1:
      return { t: "scene.update", sceneId, patch: { blockMovement: chance(r, 0.5) } };
    case 2:
      return { t: "door.set", sceneId, door: door(), state: pick(r, ["open", "closed", "locked"] as const), ...(chance(r, 0.4) ? { found: chance(r, 0.5) } : {}) };
    case 3:
      return { t: "build.height", sceneId, cells: cells(), height: pick(r, [0, 5, 10, -5]) };
    case 4:
      return { t: "build.stairs", sceneId, cells: cells(), up: pick(r, [null, "a", "n", "e", "s", "w"] as const) };
    case 5:
      return { t: "token.update", tokenId: anyToken(), patch: chance(r, 0.5) ? { partyVision: chance(r, 0.5) } : { light: chance(r, 0.7) ? { bright: 30, dim: 30 } : null } };
    case 6:
      return { t: "token.move", tokenId: anyToken(), x: int(r, 0, 30), y: int(r, 0, 30), ...(chance(r, 0.5) ? { squeeze: true as const } : { teleport: "wall" as const }) };
    case 7: {
      // The server's explore: bits only added, on the player scene or any other.
      const scene = state.scenes[sceneId];
      const across = scene ? Math.ceil(scene.bounds.w / 16) : 1;
      const down = scene ? Math.ceil(scene.bounds.h / 16) : 1;
      return { t: "sys.explore", sceneId, tiles: [{ tx: int(r, 0, across - 1), ty: int(r, 0, down - 1), bits: randomExploredBits(r) }] };
    }
    case 8:
      return { t: "fog.live", sceneId, ops: [{ id: `hide-${int(r, 0, 1e6)}`, mode: "hide", shape: { kind: "rect", x: int(r, 0, 20), y: int(r, 0, 20), w: int(r, 1, 12), h: int(r, 1, 12) } }] };
    default:
      return { t: "fog.reset", sceneId, to: "hidden" };
  }
}

/** Ready actions, spent reactions, HP lines taken back, rests and the turn timer, from either role. */
/**
 * A companion op, by the DM or a player: making one beside a character's
 * token, changing its turn, kind or character, detaching it, its own
 * Reaction, Dismiss, and a character's new owners, which reach its
 * companions.
 */
/**
 * Links of every kind, mostly at the seat the bar would pick or where a
 * dragged creature stands, so they hold often enough to be carried, a move
 * beside a holder that sets up a drag, and Get off, Put down and Let go.
 */
function wireFrom(x: number, length: number): TrapZone {
  return { wire: { a: [x, 2], b: [x + length, 2] } };
}

function trapOp(r: () => number, state: RoomState, anyToken: () => string, seqId: string): Op {
  const ids = Object.keys(state.traps);
  const anyTrap = () => (ids.length > 0 && chance(r, 0.9) ? pick(r, ids) : "missing-trap");
  const anyDue = (trapId: string) => {
    const due = state.traps[trapId]?.rig?.due ?? [];
    return due.length > 0 && chance(r, 0.85) ? pick(r, due).id : "9:9";
  };
  switch (int(r, 0, 6)) {
    case 0:
    case 1: {
      const { id: _id, rev: _rev, state: _state, rig, ...rest } = trap(seqId.replace(/[^A-Za-z0-9_-]/g, "-"), { sceneId: pick(r, ["s1", "s2"]), found: chance(r, 0.3) });
      const zone: TrapZone = chance(r, 0.7) ? { cells: [{ x: int(r, 0, 16), y: int(r, 0, 16), w: int(r, 1, 3), h: int(r, 1, 3) }] } : wireFrom(int(r, 0, 15), int(r, 1, 4));
      const { noticedBy: _n, due: _d, usesLeft: _u, ...input } = rig!;
      if ("wire" in zone) input.on = [];
      if (chance(r, 0.3)) input.actions = [{ show: { tokenId: anyToken() } }];
      return { t: "trap.create", trap: { id: seqId.replace(/[^A-Za-z0-9_-]/g, "-"), ...rest, zone, rig: input } };
    }
    case 2: {
      const patch = pick(r, [{ state: "armed" }, { state: "disarmed" }, { state: "sprung" }, { found: true }, { found: false }, { name: "Renamed trap" }, { rig: { message: "Snap!" } }, { rig: { usesLeft: null } }] as const);
      return { t: "trap.update", trapId: anyTrap(), patch: patch as never };
    }
    case 3:
      return { t: "trap.delete", trapId: anyTrap() };
    case 4: {
      const trapId = anyTrap();
      return { t: "trap.act", trapId, due: anyDue(trapId) };
    }
    default: {
      const trapId = anyTrap();
      return { t: "trap.settle", trapId, due: anyDue(trapId), ...(chance(r, 0.5) ? { sprung: true } : {}) };
    }
  }
}

function attachOp(r: () => number, state: RoomState, anyToken: () => string): Op {
  const carried = state.tokens[anyToken()];
  // Mostly a holder on the carried token's scene, and a kind its size allows, so links are made often.
  const near = Object.values(state.tokens).filter((t) => carried && t.id !== carried.id && t.sceneId === carried.sceneId);
  const holder = near.length > 0 && chance(r, 0.9) ? pick(r, near) : state.tokens[anyToken()];
  if (!carried || !holder) return { t: "token.detach", tokenId: anyToken() };
  const fitting: AttachKind = carried.kind === "object" ? "carry" : carried.size === "tiny" ? "perch" : holder.kind === "object" ? "carry" : "ride";
  const kind = chance(r, 0.7) ? fitting : pick(r, ATTACH_KINDS);
  switch (int(r, 0, 6)) {
    case 0:
      return { t: "token.move", tokenId: carried.id, x: Math.max(0, holder.x - 1), y: holder.y };
    case 1:
      return { t: "token.detach", tokenId: carried.id, x: holder.x + int(r, -1, 2), y: Math.max(0, holder.y - 1) };
    case 2:
      return { t: "token.detach", tokenId: carried.id };
    default: {
      const seat = kind === "drag" ? carried : (seatSpot(carried, holder) ?? holder);
      const steer = kind === "ride" ? chance(r, 0.6) : chance(r, 0.05);
      return { t: "token.attach", tokenId: carried.id, to: holder.id, kind, ...(steer ? { steer: true as const } : {}), x: seat.x, y: seat.y, elevation: kind === "drag" ? carried.elevation : holder.elevation };
    }
  }
}

function companionOp(r: () => number, state: RoomState, who: Viewer, helpers: { anyToken(): string; anyCharacter(): string; seqId: string }): Op {
  const companions = Object.values(state.tokens).filter((t) => t.companion !== undefined);
  const anyCompanion = () => (companions.length > 0 && chance(r, 0.8) ? pick(r, companions).id : helpers.anyToken());
  const link = () => ({ of: helpers.anyCharacter(), turn: pick(r, ["own", "shared", "none"] as const) });
  switch (int(r, 0, 8)) {
    case 0: {
      const of = helpers.anyCharacter();
      const beside = Object.values(state.tokens).find((t) => "ref" in t.actor && t.actor.ref === of);
      const effect = chance(r, 0.4);
      const a = actor({ hp: effect ? { cur: 0, max: 0, temp: 0 } : { cur: 9, max: 9, temp: 0 }, ac: effect ? 0 : 13, dmNotes: "" });
      return {
        t: "token.create",
        token: {
          id: helpers.seqId,
          sceneId: beside?.sceneId ?? "s1",
          kind: effect ? "object" : "npc",
          name: effect ? "Spiritual Weapon" : "Wildfire Spirit",
          size: "small",
          x: (beside?.x ?? 3) + 1,
          y: beside?.y ?? 3,
          layer: "token",
          actor: { inline: a },
          companion: { of, turn: effect ? pick(r, ["shared", "none"] as const) : pick(r, ["own", "shared", "none"] as const) },
        },
      };
    }
    case 1:
      return { t: "token.update", tokenId: anyCompanion(), patch: { companion: chance(r, 0.15) ? null : link() } };
    case 2:
      return { t: "token.update", tokenId: anyCompanion(), patch: { companionReaction: chance(r, 0.6) } };
    case 3:
      return { t: "token.update", tokenId: anyCompanion(), patch: chance(r, 0.5) ? { kind: pick(r, ["npc", "object"] as const) } : { name: "Renamed spirit" } };
    case 4:
      return { t: "token.delete", tokenId: anyCompanion() };
    case 5:
      return { t: "character.update", characterId: helpers.anyCharacter(), patch: { ownerIds: pick(r, [[], ["p1"], ["p2"], ["p1", "p2"]]) } };
    case 7:
      return companionBlockOp(r, state, helpers);
    case 8: {
      // A link set, changed or cleared: one of its character's blocks, maybe another's, an SRD block, or none.
      const blocks = Object.keys(state.companionBlocks);
      const actorPatch = pick(r, [
        { blockId: blocks.length > 0 ? pick(r, blocks) : "missing-block" },
        { srdId: "wolf" },
        { blockId: null },
        { srdId: null, blockId: null },
      ]);
      return { t: "token.update", tokenId: anyCompanion(), patch: { actor: actorPatch } };
    }
    default:
      // Next clears the Reactions of the landing row's companions, and a player's End Turn too.
      return who.role === "dm" ? { t: "encounter.next" } : { t: "encounter.next", from: { entry: state.encounter?.activeEntryId ?? null, round: state.encounter?.round ?? 1 } };
  }
}

/** A character's stat block saved, edited or deleted, by anyone, of a character they may or may not own. */
/**
 * A player's ask for saves for one of their creatures, or any, over an area
 * of theirs or targets, with a damage roll's tag from the log now and then,
 * and their withdrawals. The DM's resolves, dismissals and outcomes that
 * close an ask, of an open one or one that is gone.
 */
function castOp(r: () => number, state: RoomState, who: Viewer, helpers: { anyToken(): string; seqId: string }): Op {
  const askIds = Object.keys(state.casts);
  const anyAsk = () => (askIds.length > 0 && chance(r, 0.9) ? pick(r, askIds) : "missing-ask");
  if (who.role === "player") {
    if (chance(r, 0.3)) return { t: "cast.close", castId: anyAsk(), end: chance(r, 0.9) ? "withdrawn" : "dismissed" };
    const sceneId = state.meta.playerSceneId ?? "s1";
    const own = Object.values(state.tokens).filter((t) => t.sceneId === sceneId && (t.ownerIds.includes(who.memberId) || ("ref" in t.actor && state.characters[t.actor.ref]?.ownerIds.includes(who.memberId))));
    const caster = own.length > 0 && chance(r, 0.8) ? pick(r, own).id : helpers.anyToken();
    const areas = Object.values(state.templates).filter((t) => t.ownerId === who.memberId && t.sceneId === sceneId);
    const rolls = state.log.flatMap((e) => (e.data?.type === "dice" && e.data.tag !== undefined && e.data.by === who.memberId ? [{ tag: e.data.tag, tokenId: e.data.rolls[0]?.tokenId }] : []));
    const roll = rolls.length > 0 && chance(r, 0.6) ? pick(r, rolls) : undefined;
    const pickArea = areas.length > 0 && chance(r, 0.5);
    return {
      t: "cast.ask",
      cast: {
        id: helpers.seqId,
        // The roll's own creature now and then, so its results go with the ask.
        caster: roll?.tokenId !== undefined && chance(r, 0.7) ? roll.tokenId : caster,
        sceneId,
        spell: pick(r, ["Fireball", "Hold Person"]),
        ...(chance(r, 0.5) ? { slot: int(r, 3, 9) } : {}),
        ...(pickArea ? { area: pick(r, areas).id } : { targets: [...new Set([helpers.anyToken(), helpers.anyToken()])], roll: "spells:Hold Person" }),
        ...(roll ? { damage: { tag: roll.tag, parts: 1 } } : {}),
      },
    };
  }
  if (chance(r, 0.5)) return { t: "cast.close", castId: anyAsk(), end: chance(r, 0.6) ? "done" : "dismissed" };
  const castId = anyAsk();
  return { t: "actor.outcome", plan: helpers.seqId, label: state.casts[castId]?.spell ?? "Fireball", cast: castId, targets: [{ target: { tokenId: helpers.anyToken() }, amount: int(r, 1, 12) }] };
}

function companionBlockOp(r: () => number, state: RoomState, helpers: { anyCharacter(): string; seqId: string }): Op {
  const blocks = Object.keys(state.companionBlocks);
  const anyBlock = () => (blocks.length > 0 && chance(r, 0.9) ? pick(r, blocks) : "missing-block");
  switch (int(r, 0, 2)) {
    case 0: {
      const { rev: _rev, ...block } = companionBlock(helpers.seqId, helpers.anyCharacter(), chance(r, 0.3) ? { fromSrd: "owl" } : {});
      return { t: "companionBlock.create", block };
    }
    case 1:
      return { t: "companionBlock.update", blockId: anyBlock(), patch: chance(r, 0.5) ? { ac: int(r, 10, 20) } : { defaultImage: chance(r, 0.7) ? imageRef(`img-${helpers.seqId}`) : null } };
    default:
      return { t: "companionBlock.delete", blockId: anyBlock() };
  }
}

function trackerOp(
  r: () => number,
  state: RoomState,
  who: Viewer,
  helpers: { anyToken(): string; target(): { tokenId: string } | { characterId: string }; seqId: string },
): Op {
  const entries = state.encounter?.entries ?? [];
  const anyEntry = () => (entries.length > 0 ? pick(r, entries).id : "missing-entry");
  switch (int(r, 0, 4)) {
    case 4:
      return { t: "room.update", settings: { turnTimerSec: pick(r, [0, 30, 60, 300]) } };
    case 3:
      return chance(r, 0.5)
        ? { t: "actor.rest", target: helpers.target(), kind: "long" }
        : { t: "actor.rest", target: helpers.target(), kind: "short", heal: int(r, 0, 12) };
    case 2: {
      // The DM taking an HP line back, built as the server builds it.
      const lines = state.log.filter((e) => e.data?.type === "hp" && e.data.revert !== undefined);
      const line = lines.length > 0 ? pick(r, lines) : undefined;
      const built = line && who.role === "dm" ? hpUndoRestore(state, line.id) : undefined;
      if (!line || !built?.ok) return { t: "actor.hp", target: helpers.target(), change: { kind: "damage", amount: int(r, 1, 6) } };
      return { t: "sys.restore", entries: built.entries, from: "undo", deps: true, undid: line.id };
    }
    case 0: {
      const of = entries.length > 0 && chance(r, 0.8) ? { entryId: anyEntry() } : { tokenId: helpers.anyToken() };
      const hidden = who.role === "dm" && chance(r, 0.3) ? { hiddenFromPlayers: true } : {};
      const shown = who.role === "dm" && chance(r, 0.3) ? { triggerShown: true } : {};
      return { t: "actor.effect.add", target: helpers.target(), effect: { id: helpers.seqId, key: "readied", label: "if the door opens", duration: { mode: "turnStart", of }, ...hidden, ...shown } };
    }
    default:
      return { t: "encounter.update", entryId: anyEntry(), patch: { reactionUsed: chance(r, 0.6) } };
  }
}

/**
 * A path without what each leg took and its bends (docs/design-v1-movement.md
 * 6.2), for tests of the marks a stop carries, which read as they did
 * before walking routes. The route tests check those fields themselves.
 */
export function withoutWalked(path: TokenPath | undefined): TokenPath | undefined {
  if (!path) return path;
  return {
    turn: path.turn,
    stops: path.stops.map(({ moved: _m, cost: _c, diag: _d, via: _v, routeSeen: _r, ...rest }) => rest),
  };
}
