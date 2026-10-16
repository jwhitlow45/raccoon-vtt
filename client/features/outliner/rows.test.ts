import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BuildChunk, Drawing, Light, Pin, Stamp } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { character, reveal, room, scene, template, token } from "#shared/testutil.ts";
import { filterRows, frameRect, listItems, outlineRows, ROW_PX, windowRange, type OutlineRow } from "./rows.ts";

const stamp = (id: string, o: Partial<Stamp> = {}): Stamp => ({ id, rev: 0, sceneId: "s1", art: { key: "chest" }, x: 20, y: 20, w: 1, h: 1, rotation: 0, z: 0, visibility: "all", ...o });
const pin = (id: string, o: Partial<Pin> = {}): Pin => ({ id, rev: 0, sceneId: "s1", x: 4.5, y: 4.5, color: "#ff0000", visibility: "all", ...o });
const light = (id: string): Light => ({ id, rev: 0, sceneId: "s1", x: 6, y: 6, bright: 20, dim: 20, on: true, label: "Brazier" }) as Light;
const drawing = (id: string, o: Partial<Drawing> = {}): Drawing => ({
  id,
  rev: 0,
  sceneId: "s1",
  kind: "line",
  points: [1, 1, 6, 3],
  style: { stroke: "#fff", width: 2, opacity: 1 },
  ownerId: "p1",
  visibility: "all",
  ...o,
});
const chunk = (edges: BuildChunk["edges"], walls?: BuildChunk["walls"]): BuildChunk => ({ sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges, ...(walls ? { walls } : {}) });

function byKey(rows: OutlineRow[]): Map<string, OutlineRow> {
  return new Map(rows.map((r) => [r.key, r]));
}

describe("the scene outliner's rows", () => {
  test("every kind is listed in its group with what players get of it, read through the projection", () => {
    const state = room({
      scenes: { s1: scene("s1", { fogEnabled: true }), s2: scene("s2") },
      tokens: {
        seen: token("seen", { name: "Goblin", number: 1, x: 2, y: 2 }),
        dark: token("dark", { name: "Ogre", x: 30, y: 20 }),
        hid: token("hid", { name: "Assassin", x: 2, y: 3, visibility: "dm" }),
        hero: token("hero", { name: "Thorn", kind: "pc", x: 31, y: 21, ownerIds: ["p1"] }),
        other: token("other", { sceneId: "s2" }),
      },
      labels: { l1: { id: "l1", rev: 0, sceneId: "s1", x: 3, y: 3, text: "Trap", size: 1 }, l2: { id: "l2", rev: 0, sceneId: "s1", x: 30, y: 25, text: "Lair", size: 1 } },
      stamps: { st1: stamp("st1", { x: 3, y: 2 }), st2: stamp("st2", { x: 3, y: 2, visibility: "dm" }), st3: stamp("st3") },
      lights: { li1: light("li1") },
      templates: { a1: template("a1", { visibility: "dm", label: "Darkness" }), a2: template("a2", { ownerId: "p1", spell: "Fireball" }) },
      drawings: { d1: drawing("d1"), d2: drawing("d2", { kind: "text", text: "Here be dragons", visibility: "dm", ownerId: "dm1" }) },
      buildChunks: {
        "s1:0,0": chunk(
          { "4,4,n": { kind: "door", state: "locked", secret: true, discovered: false }, "5,4,n": { kind: "door", state: "open", secret: false, discovered: false }, "6,4,w": { kind: "window" }, "7,4,n": { kind: "wall" } },
          [{ id: "fw1", a: [8, 8], b: [9.5, 8], f: { kind: "door", state: "closed", secret: true, discovered: true } }],
        ),
      },
    });
    state.meta.settings.playersSeeAoeOfOthers = false;
    reveal(state, "s1", { x: 0, y: 0, w: 10, h: 10 });
    const rows = outlineRows(state, "s1");
    const r = byKey(rows);
    assert.equal(r.get("token:other"), undefined, "only the scene in view");
    assert.equal(r.get("token:seen")?.name, "Goblin 1");
    assert.equal(r.get("token:seen")?.mark, null);
    assert.equal(r.get("token:dark")?.mark, "Under fog");
    assert.equal(r.get("token:hid")?.mark, "Hidden");
    assert.equal(r.get("token:hero")?.mark, null, "the party is never under the fog");
    assert.equal(r.get("label:l1")?.mark, null);
    assert.equal(r.get("label:l2")?.mark, "Under fog");
    assert.equal(r.get("stamp:st1")?.name, "Chest");
    assert.equal(r.get("stamp:st1")?.mark, null);
    assert.equal(r.get("stamp:st2")?.mark, "DM only");
    assert.equal(r.get("stamp:st3")?.mark, "Under fog");
    assert.equal(r.get("light:li1")?.mark, "DM only");
    assert.equal(r.get("light:li1")?.name, "Brazier");
    assert.equal(r.get("area:a1")?.mark, "DM only");
    assert.equal(r.get("area:a2")?.mark, "Only p1", "a player's area other players may not see");
    assert.equal(r.get("area:a2")?.name, "Fireball");
    assert.equal(r.get("drawing:d1")?.mark, null);
    assert.equal(r.get("drawing:d2")?.name, "Here be dragons");
    assert.equal(r.get("drawing:d2")?.mark, "DM only");
    const doors = rows.filter((x) => x.group === "doors");
    assert.deepEqual(
      doors.map((d) => [d.name, d.mark]),
      [
        ["Secret door", "Secret door, hidden"],
        ["Secret door", "Secret door, found"],
        ["Door", null],
        ["Window", null],
      ],
      "secret doors first, hidden before found, free ones included, plain walls left out",
    );
    assert.deepEqual(doors[0]?.segment, { a: { x: 4, y: 4 }, b: { x: 5, y: 4 } });
    assert.deepEqual(
      [...new Set(rows.map((x) => x.group))],
      ["tokens", "map", "areas", "drawings", "doors"],
    );
  });

  test("a companion reads whose it is, away from its character when none of its tokens stands here, and searching companion finds it (docs/design-v1-combat-flow.md 3.6.10)", () => {
    const state = room({ characters: { bree: character("bree", { name: "Bree" }) } });
    state.tokens.bt = token("bt", { kind: "pc", actor: { ref: "bree" }, sceneId: "s1" });
    state.tokens.ws = token("ws", { kind: "npc", name: "Wildfire Spirit", sceneId: "s1", ownerIds: ["p1"], companion: { of: "bree", turn: "shared" } });
    state.tokens.left = token("left", { kind: "npc", name: "Owl", sceneId: "s2", ownerIds: ["p1"], companion: { of: "bree", turn: "own" } });
    const here = byKey(outlineRows(state, "s1")).get("token:ws")!;
    assert.equal(here.detail, "Companion of Bree");
    assert.equal(here.mark, null);
    const away = byKey(outlineRows(state, "s2")).get("token:left")!;
    assert.equal(away.detail, "Companion of Bree");
    assert.equal(away.mark, "Away from Bree");
    assert.deepEqual(filterRows(outlineRows(state, "s1"), "companion", null).map((r) => r.id), ["ws"]);
  });

  test("a mark agrees with what a player is sent, token by token", () => {
    const state = room({ scenes: { s1: scene("s1", { fogEnabled: true }), s2: scene("s2") } });
    for (let i = 0; i < 30; i++) state.tokens[`t${i}`] = token(`t${i}`, { x: (i * 7) % 38, y: (i * 5) % 28, visibility: i % 7 === 0 ? "dm" : "all" });
    reveal(state, "s1", { x: 5, y: 5, w: 12, h: 9 });
    const sent = projectState(state, { memberId: "p2", role: "player" }, { sceneId: null }).tokens;
    for (const row of outlineRows(state, "s1").filter((x) => x.kind === "token")) {
      assert.equal(row.mark === null, sent[row.id] !== undefined, row.id);
    }
  });

  test("a scene not shown to players reads as it will once they are moved to it", () => {
    const state = room({ scenes: { s1: scene("s1"), s2: scene("s2", { fogEnabled: true }) }, tokens: { t: token("t", { sceneId: "s2", x: 30, y: 20 }) } });
    reveal(state, "s2", { x: 0, y: 0, w: 4, h: 4 });
    assert.equal(outlineRows(state, "s2")[0]?.mark, "Under fog");
    state.meta.view = { follow: false, blackout: true };
    assert.equal(outlineRows(state, "s2")[0]?.mark, "Under fog", "a blackout is not what the scene holds");
  });

  test("on a party vision scene a creature outside the party's sight says so", () => {
    const state = room({ scenes: { s1: scene("s1", { vision: { on: true, light: "dark" } }), s2: scene("s2") }, tokens: { m: token("m", { x: 30, y: 20 }) } });
    assert.equal(outlineRows(state, "s1")[0]?.mark, "Out of the party's sight");
  });

  test("a pin answers for its page: DM only, one player's, or anyone's under the fog rule", () => {
    const state = room({
      scenes: { s1: scene("s1", { fogEnabled: true }), s2: scene("s2") },
      journal: {
        all: { id: "all", rev: 0, title: "Old map", access: "all", blocks: [] },
        dm: { id: "dm", rev: 0, title: "Secrets", access: "dm", blocks: [] },
        thorn: { id: "thorn", rev: 0, title: "Letter", access: { member: "p1" }, blocks: [] },
      },
      pins: { p1: pin("p1", { pageId: "all" }), p2: pin("p2", { pageId: "dm" }), p3: pin("p3", { pageId: "thorn" }), p4: pin("p4", { visibility: "dm" }), p5: pin("p5", { x: 30.5, y: 20.5, pageId: "thorn" }) },
    });
    reveal(state, "s1", { x: 0, y: 0, w: 10, h: 10 });
    const r = byKey(outlineRows(state, "s1"));
    assert.equal(r.get("pin:p1")?.mark, null);
    assert.equal(r.get("pin:p1")?.name, "Old map", "a pin with no label shows its page's title");
    assert.equal(r.get("pin:p2")?.mark, "DM only");
    assert.equal(r.get("pin:p3")?.mark, "Only p1");
    assert.equal(r.get("pin:p4")?.mark, "DM only");
    assert.equal(r.get("pin:p5")?.mark, "Under fog", "the page's reader is under the fog too");
  });

  test("search narrows every group by name and detail, and a chip to one group", () => {
    const state = room({
      tokens: { a: token("a", { name: "Goblin" }), b: token("b", { name: "Goblin boss" }), c: token("c", { name: "Owlbear" }) },
      drawings: { d: drawing("d", { kind: "text", text: "Goblin camp" }) },
    });
    const rows = outlineRows(state, "s1");
    assert.deepEqual(filterRows(rows, "gob", null).map((r) => r.id), ["a", "b", "d"]);
    assert.deepEqual(filterRows(rows, "GOBLIN boss", null).map((r) => r.id), ["b"]);
    assert.deepEqual(filterRows(rows, "goblin", "drawings").map((r) => r.id), ["d"]);
    assert.deepEqual(filterRows(rows, "monster", null).map((r) => r.id), ["a", "b", "c"], "the detail line counts too");
    assert.deepEqual(filterRows(rows, "", "tokens").length, 3);
  });

  test("groups fold to their header, with their count", () => {
    const state = room({ tokens: { a: token("a"), b: token("b") }, drawings: { d: drawing("d") } });
    const rows = outlineRows(state, "s1");
    const open = listItems(rows, new Set());
    assert.deepEqual(open.map((i) => (i.kind === "header" ? `${i.title} (${i.count})` : i.row.id)), ["Creatures and objects (2)", "a", "b", "Drawings (1)", "d"]);
    const folded = listItems(rows, new Set(["tokens"]));
    assert.deepEqual(folded.map((i) => (i.kind === "header" ? `${i.title}${i.folded ? " folded" : ""}` : i.row.id)), ["Creatures and objects folded", "Drawings", "d"]);
  });

  test("a tap frames the item's rectangle with room around it", () => {
    const state = room({ tokens: { big: token("big", { x: 10, y: 10, size: "large" }) }, lights: { li: light("li") } });
    const r = byKey(outlineRows(state, "s1"));
    assert.deepEqual(r.get("token:big")?.rect, { x: 10, y: 10, width: 2, height: 2 });
    assert.deepEqual(frameRect({ x: 10, y: 10, width: 2, height: 2 }), { x: 7, y: 7, width: 8, height: 8 });
    // A point grows to a few cells, so a light is framed with what is around it.
    assert.deepEqual(frameRect(r.get("light:li")!.rect), { x: 2, y: 2, width: 8, height: 8 });
    assert.deepEqual(frameRect({ x: 0, y: 0, width: 20, height: 4 }), { x: -3, y: -3, width: 26, height: 10 });
  });

  test("the window renders the rows in view and a few past each edge", () => {
    // In lines, so the cases hold whatever height a line is.
    assert.deepEqual(windowRange({ listTop: 0, viewHeight: ROW_PX * 10, count: 5000, overscan: 0 }), { start: 0, end: 10 });
    assert.deepEqual(windowRange({ listTop: -ROW_PX * 100, viewHeight: ROW_PX * 10, count: 5000, overscan: 5 }), { start: 95, end: 115 });
    assert.deepEqual(windowRange({ listTop: ROW_PX * 4.5, viewHeight: ROW_PX * 10, count: 5000, overscan: 0 }), { start: 0, end: 6 }, "a list lower in the panel");
    assert.deepEqual(windowRange({ listTop: -ROW_PX * 4990, viewHeight: ROW_PX * 20, count: 5000, overscan: 8 }), { start: 4982, end: 5000 });
    assert.deepEqual(windowRange({ listTop: ROW_PX * 20, viewHeight: ROW_PX * 10, count: 5000, overscan: 0 }), { start: 0, end: 0 }, "a list below the view");
  });
});
