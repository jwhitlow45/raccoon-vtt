import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkKey } from "../keys.ts";
import type { EdgeFeature, PathStop, RoomState, Token } from "../model.ts";
import { projectState } from "../project.ts";
import { P1, actor, effect, reveal, room, template, token } from "../testutil.ts";
import { legGeometry, publicCounters } from "./path.ts";
import { findRoute } from "./walk.ts";
import { creatureWay, groupWalkWorld, halvedAt, publicWorld, speedAreas, type PublicWorld, type WorldOptions } from "./walkWorld.ts";
import { ownWalk } from "./movement.ts";

/** The public world a route is searched in (docs/design-v1-movement.md 4.3 and 5.5). */

const seenSet = new Set<never>();

describe("creatures in the way (4.3)", () => {
  const hero = token("hero", { kind: "pc", disposition: "ally" });
  test("an ally's and a Tiny creature's space cost nothing, another's is difficult, and one the mover cannot pass blocks", () => {
    assert.equal(creatureWay(hero, token("a", { disposition: "ally" }), seenSet, true), "free");
    assert.equal(creatureWay(hero, token("t", { size: "tiny" }), seenSet, true), "free");
    assert.equal(creatureWay(hero, token("g"), seenSet, true), "blocked");
    assert.equal(creatureWay(hero, token("g"), new Set(["unconscious"]), true), "difficult", "Incapacitated by an effect players see");
    assert.equal(creatureWay(hero, token("ogre", { size: "huge" }), seenSet, true), "difficult", "two sizes apart");
    assert.equal(creatureWay(hero, token("ogre", { size: "large" }), seenSet, true), "blocked", "one size apart");
    assert.equal(creatureWay(token("n", { disposition: "neutral" }), token("m", { disposition: "neutral" }), seenSet, true), "free", "two neutral creatures are allies");
    assert.equal(creatureWay(hero, token("g"), seenSet, false), "difficult", "nothing is in the way where moves are not stopped");
  });

  test("only creatures players see count, as their copy shows them, the same on the DM's device as on a player's", () => {
    const state = room({
      tokens: {
        hero: token("hero", { kind: "pc", disposition: "ally", ownerIds: ["p1"], x: 2, y: 2 }),
        seen: token("seen", { x: 5, y: 2 }),
        hidden: token("hidden", { x: 6, y: 2, visibility: "dm" }),
        dead: token("dead", { x: 7, y: 2, actor: { inline: actor({ life: "dead" }) } }),
        knocked: token("knocked", { x: 8, y: 2, actor: { inline: actor({ effects: [effect("e1", { key: "unconscious", hiddenFromPlayers: true })] }) } }),
        crate: token("crate", { kind: "object", x: 9, y: 2 }),
      },
    });
    state.scenes.s1 = { ...state.scenes.s1!, blockMovement: true };
    const onDm = publicWorld(state, ownWalk(state.tokens.hero!), { role: "dm" });
    const view = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
    const onPlayer = publicWorld(view, ownWalk(view.tokens.hero!), { role: "player" });
    assert.deepEqual(onDm.spaces.map((s) => s.id), ["knocked", "seen"]);
    assert.deepEqual(onDm.input.creatures, onPlayer.input.creatures);
    assert.deepEqual(onDm.input.creatures.map((c) => c.way), ["blocked", "blocked"], "an Unconscious the DM hid does not let the hero through");
  });
});

describe("ground, areas and Prone as players get them (5.5)", () => {
  test("a party member's walk keeps to ground players have seen, on both devices, and a DM's monster reads all of it", () => {
    const state = room({ tokens: { hero: token("hero", { kind: "pc", ownerIds: ["p1"], x: 2, y: 2 }), gob: token("gob", { x: 3, y: 3 }) } });
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true };
    reveal(state, "s1", { x: 0, y: 0, w: 10, h: 10 });
    const dmHero = publicWorld(state, ownWalk(state.tokens.hero!), { role: "dm" }).input.seen!;
    const view = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
    const playerHero = publicWorld(view, ownWalk(view.tokens.hero!), { role: "player" }).input.seen!;
    for (const [x, y] of [[5, 5], [12, 5], [9, 9], [10, 9]] as const) assert.equal(dmHero(x, y), playerHero(x, y), `${x}, ${y}`);
    assert.equal(dmHero(12, 5), false);
    assert.equal(publicWorld(state, ownWalk(state.tokens.gob!), { role: "dm" }).input.seen, null);
  });

  test("an area that slows: DM-only, another player's unseen, or on a hidden token is left out, a hidden caster leaves it slowing everyone", () => {
    const base = (): RoomState =>
      room({
        tokens: { hero: token("hero", { kind: "pc", disposition: "ally", ownerIds: ["p1"], x: 2, y: 2 }), druid: token("druid", { disposition: "ally", x: 20, y: 20 }) },
        templates: { web: template("web", { shape: "cube", size: 10, origin: { x: 5, y: 5, z: 0 }, ownerId: "dm1", slows: { kind: "difficult" } }) },
      });
    const areasOf = (state: RoomState) => publicWorld(state, ownWalk(state.tokens.hero!), { role: "dm" }).input.areas;
    assert.equal(areasOf(base()).length, 1);
    const dmOnly = base();
    dmOnly.templates.web = { ...dmOnly.templates.web!, visibility: "dm" };
    assert.equal(areasOf(dmOnly).length, 0);
    const others = base();
    others.meta = { ...others.meta, settings: { ...others.meta.settings, playersSeeAoeOfOthers: false } };
    others.templates.web = { ...others.templates.web!, ownerId: "p2" };
    assert.equal(areasOf(others).length, 0, "players get another player's area only where they see others' areas");
    const foes = base();
    foes.templates.web = { ...foes.templates.web!, casterId: "druid", slows: { kind: "difficult", foes: true } };
    assert.equal(areasOf(foes).length, 0, "the caster's ally walks through");
    foes.tokens.druid = { ...foes.tokens.druid!, visibility: "dm" };
    assert.equal(areasOf(foes).length, 1, "with the caster hidden, it slows everyone");
    const quarter = base();
    quarter.templates.web = { ...quarter.templates.web!, slows: { kind: "quarter" } };
    assert.equal(areasOf(quarter)[0]!.extra, 3);
  });

  test("Prone counts only where players receive it", () => {
    const prone = (hidden: boolean) => {
      const gob = token("gob", { actor: { inline: actor({ effects: [effect("e1", { key: "prone", hiddenFromPlayers: hidden })] }) } });
      return publicWorld(room({ tokens: { gob } }), ownWalk(gob), { role: "dm" }).input.prone;
    };
    assert.equal(prone(false), true);
    assert.equal(prone(true), false);
  });
});

describe("Speed changes (4.2)", () => {
  test("Spirit Guardians halves the Speed of the caster's enemies inside it, never the caster's own", () => {
    const state = room({
      tokens: { cleric: token("cleric", { kind: "pc", disposition: "ally", ownerIds: ["p1"], x: 10, y: 10 }), gob: token("gob", { x: 2, y: 10 }) },
      templates: { sg: template("sg", { shape: "emanation", size: 15, attachedTo: "cleric", casterId: "cleric", includeOrigin: false, ownerId: "p1", slows: { kind: "halfSpeed", foes: true } }) },
    });
    const areas = speedAreas(state, state.tokens.gob!, { role: "dm" });
    const gob = state.tokens.gob!;
    assert.equal(halvedAt(areas, { ...gob, x: 2, y: 10, elevation: 0 }), null);
    assert.equal(halvedAt(areas, { ...gob, x: 8, y: 10, elevation: 0 })?.id, "sg");
    assert.equal(halvedAt(areas, { ...gob, x: 8, y: 10, elevation: 40 }), null, "in three dimensions");
    assert.equal(speedAreas(state, state.tokens.cleric!, { role: "dm" }).halfSpeed.length, 0);
  });

  test("a creature is in a Half Speed area by the footprint it has there, squeezed where it squeezes", () => {
    // A Large ogre whose full footprint just reaches the cleric's 15 ft emanation, and whose squeezed one does not.
    const state = room({
      tokens: { cleric: token("cleric", { kind: "pc", disposition: "ally", ownerIds: ["p1"], x: 10, y: 10 }), ogre: token("ogre", { size: "large", x: 5.5, y: 10 }) },
      templates: { sg: template("sg", { shape: "emanation", size: 15, attachedTo: "cleric", casterId: "cleric", includeOrigin: false, ownerId: "p1", slows: { kind: "halfSpeed", foes: true } }) },
    });
    const areas = speedAreas(state, state.tokens.ogre!, { role: "dm" });
    assert.equal(halvedAt(areas, state.tokens.ogre!)?.id, "sg");
    assert.equal(halvedAt(areas, { ...state.tokens.ogre!, squeeze: true }), null);
  });
});

describe("the counters a route starts from (5.5, History)", () => {
  const gob = token("gob");
  const rules = { feetPerCell: 5, diagonal: "fiveTen" as const };
  const stop = (x: number, y: number, more: Partial<PathStop> = {}): PathStop => ({ x, y, elevation: 0, ...more });
  test("only counted legs players who do not own the creature saw whole, read from their corners", () => {
    const stops = [stop(0, 0, { seen: true }), stop(1, 1, { seen: true, routeSeen: true, diag: [1, 0] }), stop(2, 2, { diag: [1, 0] }), stop(5, 2, { seen: true, routeSeen: true, via: [3, 3], diag: [1, 0] })];
    assert.deepEqual(publicCounters(gob, stops, rules, true), { h: 1, v: 0 }, "the leg into the unseen stop and the one out of it do not count");
    const owners = stops.map(({ seen: _seen, ...s }) => s);
    assert.deepEqual(publicCounters(gob, owners, rules, false), { h: 3, v: 0 }, "an owner's copy marks the legs seen whole with routeSeen alone, the last one's two diagonals by its corner");
    assert.deepEqual(legGeometry(gob, stop(2, 2), stop(5, 2, { via: [3, 3] }), rules, { h: 0, v: 0 }), { moved: 20, cost: 20, diag: [2, 0] }, "5 ft, then 10 ft and 5 ft past the corner");
  });
});

describe("the same public world on every device (5.5, review MV-O-1 and MV-O-10)", () => {
  /**
   * A room cut by a wall along x = 6 down to y = 12, an unfound secret door
   * in it left open beside Plant Growth, fog over a patch of the gap, a
   * creature the DM hid in it, a DM-only web, and a Prone the DM hid on the
   * goblin. The hero is P1's.
   */
  function busy(): RoomState {
    const edges: Record<string, EdgeFeature> = { "6,5,w": { kind: "door", state: "open", secret: true, discovered: false } };
    for (let y = 0; y < 12; y++) if (y !== 5) edges[`6,${y},w`] = { kind: "wall" };
    const state = room({
      tokens: {
        hero: token("hero", { kind: "pc", disposition: "ally", ownerIds: ["p1"], x: 2, y: 5 }),
        gob: token("gob", { x: 2, y: 8, actor: { inline: actor({ effects: [effect("e1", { key: "prone", hiddenFromPlayers: true })] }) } }),
        lurker: token("lurker", { x: 7, y: 13, visibility: "dm" }),
      },
      templates: {
        pg: template("pg", { shape: "sphere", size: 15, origin: { x: 5, y: 5, z: 0 }, ownerId: "dm1", slows: { kind: "quarter" } }),
        web: template("web", { shape: "cube", size: 10, origin: { x: 8, y: 14, z: 0 }, ownerId: "dm1", visibility: "dm", slows: { kind: "difficult" } }),
      },
    });
    state.buildChunks[chunkKey("s1", 0, 0)] = { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges };
    state.scenes.s1 = { ...state.scenes.s1!, blockMovement: true, autoWalls: "off", fogEnabled: true };
    reveal(state, "s1", { x: 0, y: 0, w: 40, h: 12 });
    reveal(state, "s1", { x: 0, y: 12, w: 5, h: 18 });
    reveal(state, "s1", { x: 8, y: 12, w: 32, h: 18 });
    return state;
  }

  /** What a world holds, functions read at every square, so two can be compared whole. */
  function whole(w: PublicWorld, bounds: { w: number; h: number }) {
    const { build: _build, seen, token, ...rest } = w.input;
    const ground = seen ? Array.from({ length: bounds.h }, (_, y) => Array.from({ length: bounds.w }, (_, x) => (seen(x, y) ? 1 : 0)).join("")) : null;
    // The walker as it stands: a player's copy of its own token leaves out what the DM keeps private.
    const at = { size: token.size, x: token.x, y: token.y, elevation: token.elevation };
    return { ...rest, token: at, seen: ground, spaces: w.spaces, halfSpeed: w.halfSpeed.map((t) => t.id) };
  }

  const targets = [
    { x: 9, y: 5 },
    { x: 9, y: 8 },
    { x: 10, y: 14 },
    { x: 3, y: 20 },
  ];

  function agree(walker: string, opts: WorldOptions = {}, setup?: (s: RoomState) => void, grouped = false) {
    const state = busy();
    setup?.(state);
    const view = projectState(state, P1, { sceneId: "s1" }) as unknown as RoomState;
    const build = (s: RoomState, role: "dm" | "player") => (grouped ? groupWalkWorld(s, ownWalk(s.tokens[walker] as Token), { role }) : publicWorld(s, ownWalk(s.tokens[walker] as Token), { role }, [], opts));
    const onDm = build(state, "dm");
    const onPlayer = build(view, "player");
    const bounds = state.scenes.s1!.bounds;
    assert.deepEqual(whole(onDm, bounds), whole(onPlayer, bounds), `${walker}: the world`);
    for (const to of targets) {
      const route = (w: PublicWorld) => {
        const r = findRoute(w.input, to);
        return r === null || r === "none" ? r : r.pieces;
      };
      assert.deepEqual(route(onDm), route(onPlayer), `${walker} to ${to.x}, ${to.y}`);
    }
  }

  test("a party member's drag reads the same world and finds the same routes on the DM's device as on a player's", () => {
    agree("hero");
  });

  test("so does a shared ruler on a monster, which keeps to ground players have seen", () => {
    agree("gob", { creatures: false, seenGround: true });
  });

  test("so does the DM's drag of a monster carrying the hero, which keeps to ground players have seen (docs/design-v1-attach.md 9)", () => {
    agree("gob", {}, (s) => {
      s.tokens.gob = { ...s.tokens.gob!, size: "large" };
      s.tokens.hero = { ...s.tokens.hero!, x: 2, y: 8, attached: { to: "gob", kind: "ride" } };
    }, true);
  });

  test("so does a drag whose hidden passenger carries a creature players see: only links every player sees take it out of the way", () => {
    agree("hero", {}, (s) => {
      s.tokens.imp = token("imp", { name: "Imp", size: "tiny", x: 3, y: 5, visibility: "dm", attached: { to: "hero", kind: "drag" } });
      s.tokens.wolf = token("wolf", { name: "Wolf", x: 4, y: 5, attached: { to: "imp", kind: "carry" } });
    }, true);
  });
});
