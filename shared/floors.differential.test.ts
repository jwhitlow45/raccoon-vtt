import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkOps, checkPair, dragged, type Apart, type Drag, type OpPair } from "./differential.ts";
import type { MapVideo, RoomState, Scene, Viewer } from "./model.ts";
import { projectState } from "./project.ts";
import type { Op } from "./protocol.ts";
import { DM, P1, P2, actor, apply, character, member, room, scene, token, trap } from "./testutil.ts";

/**
 * Several floors' generators for the shared differential test
 * (docs/design/design-v1-floors.md 15, lane FLR-B): pairs of rooms, one with a
 * floor of the players' scene they have not reached and one without it,
 * and a pair whose rooms differ only in what the DM did on such a floor.
 * Every recipient each pair names must start equal and observe the same of
 * every op after: every player, the one who owns nothing and a table
 * display, but a hidden creature's owner, who holds its floor and is
 * compared apart from it.
 *
 * The tower stands on Ground floor, where the players start and Thorn
 * (p1's), Bree (p2's) and a goblin stand. p3 owns nothing.
 */
const P3: Viewer = { memberId: "p3", role: "player" };
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const EVERYONE: readonly Viewer[] = [P1, P2, P3, DISPLAY];

type FloorSpec = { id: string; name: string; reached?: true };

const video = (assetId: string): MapVideo => ({ assetId, widthPx: 700, heightPx: 700, container: "webm", video: "vp09.00.40.08", fps: 30, durationMs: 1000, kbps: 100 });

/** The tower with these floors bottom first, its main floor Ground. One floor alone is a scene without floors. */
function tower(floors: readonly FloorSpec[]): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2"), p3: member("p3") } });
  s.meta.playerSceneId = "ground";
  s.scenes = { road: scene("road", { name: "Road", order: 1 }) };
  for (const [level, f] of floors.entries()) {
    s.scenes[f.id] = scene(f.id, { name: "Tower", ...(floors.length > 1 ? { floor: { of: "ground", level, name: f.name, height: 10 } } : {}) });
    if (f.reached) s.openFloors = { ...s.openFloors, [f.id]: { sceneId: f.id, rev: 1 } };
  }
  s.characters.c1 = character("c1", { name: "Thorn", ownerIds: ["p1"] });
  s.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", sceneId: "ground", actor: { ref: "c1" }, disposition: "ally", x: 2, y: 5 });
  s.tokens.bree = token("bree", { kind: "pc", name: "Bree", sceneId: "ground", ownerIds: ["p2"], disposition: "ally", x: 2, y: 10 });
  s.tokens.goblin = token("goblin", { sceneId: "ground", name: "Goblin", x: 8, y: 5 });
  return s;
}

/** What the DM set up on a floor players have not reached: a map with its video, weather, a build, creatures, notes and a found trap. */
function furnish(s: RoomState, id: string): RoomState {
  s.scenes[id] = {
    ...s.scenes[id]!,
    map: { assetId: `${id}-map`, widthPx: 700, heightPx: 700, cellPx: 70, originPx: { x: 0, y: 0 }, video: video(`${id}-video`) },
    weather: { kind: "rain", heavy: true, wind: "strong", toward: 90 },
    fogEnabled: true,
  };
  s.buildChunks[`${id}:0,0`] = { sceneId: id, cx: 0, cy: 0, rev: 1, cells: { "1,1": "stone" }, edges: { "2,1,n": { kind: "wall" } } };
  s.tokens[`${id}-dragon`] = token(`${id}-dragon`, { sceneId: id, name: "Dragon", fogExempt: true });
  s.labels[`${id}-label`] = { id: `${id}-label`, rev: 0, sceneId: id, x: 2, y: 2, text: "Hoard", size: 1 };
  s.pins[`${id}-pin`] = { id: `${id}-pin`, rev: 0, sceneId: id, x: 5, y: 5, label: "Lair", color: "#ffffff", visibility: "all" };
  s.traps[`${id}-trap`] = trap(`${id}-trap`, { sceneId: id, found: true });
  return s;
}

/** p1's familiar, which the DM hid, on a floor only p1 so holds. */
function familiar(s: RoomState, id: string): RoomState {
  s.tokens.owl = token("owl", { sceneId: id, kind: "npc", name: "Owl", ownerIds: ["p1"], visibility: "dm" });
  return s;
}

/**
 * p1's copy without the floor only one room has: its record and everything
 * on it, with the other floors' levels counted again among those left, and
 * no `floor` once one floor is left, as a room without it projects.
 */
function withoutFloor(extra: string): Apart["strip"] {
  return (copy) => {
    const out: Record<string, unknown> = { ...copy };
    const scenes: Record<string, Scene> = { ...(copy.scenes as Record<string, Scene>) };
    delete scenes[extra];
    const floors = Object.values(scenes).filter((s) => s.floor !== undefined).sort((a, b) => a.floor!.level - b.floor!.level);
    for (const [level, s] of floors.entries()) {
      const { floor, ...rest } = s;
      scenes[s.id] = floors.length < 2 ? rest : { ...rest, floor: { ...floor!, level } };
    }
    out.scenes = scenes;
    for (const field of ["tokens", "labels", "stamps", "pins", "traps", "templates", "drawings"]) {
      out[field] = Object.fromEntries(Object.entries((copy[field] ?? {}) as Record<string, { sceneId: string }>).filter(([, v]) => v.sceneId !== extra));
    }
    for (const field of ["buildChunks", "fogTiles", "sight", "fogAll", "sightAll"]) {
      if (copy[field] === undefined) continue;
      out[field] = Object.fromEntries(Object.entries(copy[field] as Record<string, unknown>).filter(([key]) => !key.startsWith(`${extra}:`)));
    }
    return out;
  };
}

function dragStep(drag: Drag, note: string): OpPair["steps"][number] {
  return { who: drag.who, op: (_view, state) => dragged(state, drag)?.op ?? null, note };
}

/** A turn of play on Ground: a walk, a fight, a hit, a word, the goblin's move and Bree's walk. */
const PLAY: OpPair["steps"] = [
  dragStep({ who: P1, tokenId: "thorn", to: { x: 4, y: 5 } }, "Thorn walks"),
  { who: DM, op: { t: "encounter.start", entries: [{ id: "et", tokenId: "thorn", value: 20 }, { id: "eg", tokenId: "goblin", value: 15 }, { id: "eb", tokenId: "bree", value: 10 }] } as Op, note: "a fight" },
  { who: DM, op: { t: "encounter.next" } },
  { who: DM, op: { t: "actor.hp", target: { tokenId: "goblin" }, change: { kind: "damage", amount: 3 } }, note: "a hit" },
  { who: P2, op: { t: "log.chat", text: "On my way" } },
  { who: DM, op: { t: "encounter.next" } },
  { who: DM, op: { t: "token.move", tokenId: "goblin", x: 9, y: 6 }, note: "the goblin moves" },
  dragStep({ who: P2, tokenId: "bree", to: { x: 3, y: 9 } }, "Bree walks"),
];

const GROUND: FloorSpec = { id: "ground", name: "Ground floor" };
const UPPER: FloorSpec = { id: "upper", name: "Upper floor", reached: true };

/** The tower with an unopened floor where `at` says, and the same tower without it. */
const PLACES: readonly { where: string; extra: FloorSpec; at: number; rest: readonly FloorSpec[] }[] = [
  { where: "below", extra: { id: "cellar", name: "Cellar" }, at: 0, rest: [GROUND] },
  { where: "between", extra: { id: "middle", name: "Middle floor" }, at: 1, rest: [GROUND, UPPER] },
  { where: "above", extra: { id: "attic", name: "Attic" }, at: 2, rest: [GROUND, UPPER] },
];

/** Every step of PLAY applied in both rooms, so a pair never passes by refusing alike. */
function played(end: { a: RoomState; b: RoomState }): void {
  for (const state of [end.a, end.b]) {
    assert.deepEqual([state.tokens.thorn?.x, state.tokens.goblin?.x, state.tokens.bree?.y], [4, 9, 9], "the walks and the move");
    assert.equal(state.encounter?.activeEntryId, "eg", "the fight came to the goblin's turn");
    assert.ok(state.log.some((e) => e.kind === "chat" && e.text === "On my way"));
  }
}

function withExtra(place: (typeof PLACES)[number]): RoomState {
  const floors = [...place.rest];
  floors.splice(place.at, 0, place.extra);
  return furnish(tower(floors), place.extra.id);
}

describe("an unopened floor of the players' scene sends nothing (design 8, 14)", () => {
  for (const place of PLACES) {
    test(`one ${place.where} the floors players hold: every player and the display observe the same of every op`, () => {
      played(checkOps({ name: `an unopened floor ${place.where}`, a: withExtra(place), b: tower(place.rest), equal: EVERYONE, steps: PLAY }, undefined, 50));
    });

    test(`one ${place.where}, where p1's hidden familiar stands: the others observe the same, and p1 too apart from that floor`, () => {
      const a = familiar(withExtra(place), place.extra.id);
      const own = projectState(a, P1, { sceneId: null });
      assert.ok(own.scenes[place.extra.id] && own.tokens.owl, "p1 holds the familiar's floor, so the strip has something to take out");
      played(checkOps({ name: `a familiar on the floor ${place.where}`, a, b: tower(place.rest), equal: [P2, P3, DISPLAY], apart: [{ who: P1, strip: withoutFloor(place.extra.id) }], steps: PLAY }, undefined, 50));
    });
  }
});

describe("a pair compares exactly the recipients it names", () => {
  test("a named recipient whose copies differ fails the pair, as does one compared apart with nothing taken out", () => {
    const place = PLACES[2]!;
    const a = familiar(withExtra(place), place.extra.id);
    const b = tower(place.rest);
    assert.throws(() => checkOps({ name: "p1 named", a, b, equal: EVERYONE, steps: PLAY }, undefined, 50), /p1's copies do not start equal/);
    assert.throws(() => checkOps({ name: "p1 apart", a, b, equal: [P2], apart: [{ who: P1, strip: (copy) => copy }], steps: PLAY }, undefined, 50), /p1's copies do not start equal/);
  });
});

describe("what the DM did on an unopened floor (a history pair)", () => {
  test("a creature made, hurt and moved there and a trap set: every player and the display observe the same of every op after", () => {
    const b = furnish(tower([GROUND, UPPER, { id: "attic", name: "Attic" }]), "attic");
    const history: Op[] = [
      { t: "token.create", token: { id: "lurker", sceneId: "attic", kind: "monster", name: "Lurker", size: "medium", x: 3, y: 3, actor: { inline: actor() } } } as Op,
      { t: "actor.hp", target: { tokenId: "lurker" }, change: { kind: "damage", amount: 4 } },
      { t: "actor.hp", target: { tokenId: "attic-dragon" }, change: { kind: "heal", amount: 1 } },
      { t: "token.update", tokenId: "lurker", patch: { x: 6, name: "Lurker in the dark" } },
      { t: "token.update", tokenId: "attic-dragon", patch: { visibility: "dm" } },
    ];
    let a = b;
    for (const [i, op] of history.entries()) a = apply(a, op, DM, i + 1);
    assert.ok(a.log.length > b.log.length, "the history wrote lines only the DM reads");
    played(checkOps({ name: "the DM's work upstairs", a, b, equal: EVERYONE, steps: PLAY }, undefined, 50));
  });
});

describe("a drag on a floor no player sees (FLRBUILD-PRIV-03)", () => {
  /**
   * The Attic, which nobody reached, holds p1's owl, which the DM hid, so
   * p1 holds it, and a pony dragging a cart, which the room lets p1 move.
   * One room also holds a goblin the DM hid there.
   */
  function stable(goblin: boolean): RoomState {
    const s = tower([GROUND, UPPER, { id: "attic", name: "Attic" }]);
    s.meta.settings = { ...s.meta.settings, playersMoveAny: ["p1"] };
    s.tokens.owl = token("owl", { sceneId: "attic", kind: "npc", name: "Owl", ownerIds: ["p1"], visibility: "dm", x: 2, y: 12 });
    s.tokens.pony = token("pony", { sceneId: "attic", kind: "npc", name: "Pony", x: 6, y: 6 });
    s.tokens.cart = token("cart", { sceneId: "attic", kind: "object", layer: "object", name: "Cart", x: 5, y: 6, attached: { to: "pony", kind: "drag" } });
    if (goblin) s.tokens.goblin2 = token("goblin2", { sceneId: "attic", name: "Goblin", visibility: "dm", x: 12, y: 12 });
    return s;
  }

  test("p1's drag there, held only through the owl, and the DM's count the pony's group as the server does: no member seen by every player", () => {
    const a = stable(true);
    const view = projectState(a, P1, { sceneId: null });
    assert.ok(view.tokens.pony && view.tokens.cart, "p1 sees the pony and its cart");
    checkPair({
      name: "the pony on the Attic",
      a,
      b: stable(false),
      drags: [
        { who: P1, tokenId: "pony", to: { x: 9, y: 6 } },
        { who: DM, tokenId: "pony", to: { x: 9, y: 8 } },
      ],
    });
  });
});
