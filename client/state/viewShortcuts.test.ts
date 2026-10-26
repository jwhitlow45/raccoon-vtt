import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RoomScope } from "./scope.ts";
import type { RoomUi } from "./store.ts";
import type { RoomView } from "./types.ts";

/*
 * I, Q and E (docs/design-v1-isometric-view.md 6.5) as a page that offers
 * Isometric has them: the flag is set before the table loads, as the
 * end-to-end tests set it (features/view/choice.ts isoOffered). Its own
 * file, since a page reads the flag once, as it loads.
 */
(globalThis as Record<string, unknown>).__rvttIsoTest = true;
const { BEHAVIORS, DEFAULT_KEYS, NO_KEY, sheetSections, SHORTCUTS, shortcutFor, shortcutKeys, VIEW_BEHAVIORS, VIEW_SHORTCUTS } = await import("./shortcuts.ts");
const { ISO_TEST_FLAG, isoOffered, viewVoiceSlot } = await import("../features/view/choice.ts");
const { pickView, readView, viewKey, withPick } = await import("../features/view/store.ts");
const { sameKey } = await import("./keyBindings.ts");

const body = { tagName: "BODY" };
const press = (key: string, over: Record<string, unknown> = {}) => ({ key, code: `Key${key.toUpperCase()}`, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, defaultPrevented: false, target: body, ...over });

let rooms = 0;

/** A page on a room of its own, so the store's cache starts empty for it. */
function page(input: { role?: "dm" | "player"; tool?: string; suggested?: "isometric"; scene?: boolean } = {}) {
  const roomId = `room${++rooms}`;
  const notes: string[] = [];
  const state = {
    roomId,
    you: { memberId: "m1", role: input.role ?? "player" },
    sceneId: input.scene === false ? null : "s1",
    local: { selectedIds: [], selectedId: null, tool: input.tool ?? "select" },
    view: { tokens: {}, characters: {}, encounter: null, meta: { settings: {} }, scenes: { s1: { id: "s1", ...(input.suggested ? { suggestedView: input.suggested } : {}) }, s2: { id: "s2" } } },
  };
  const scope = new RoomScope();
  const env = {
    role: input.role ?? "player",
    tools: [{ id: "select" }, { id: "build" }],
    getState: () => state as unknown as RoomView,
    actions: {} as never,
    ui: { notify: (text: string) => void notes.push(text), setTool() {} } as unknown as RoomUi,
    scope,
  };
  const key = viewKey(roomId);
  return {
    env,
    state,
    key,
    notes,
    said: () => scope.get(viewVoiceSlot).getState().text,
    hit: (k: string) => {
      const s = shortcutFor(press(k), env, { dialogOpen: false, preview: false });
      s?.run(env, press(k));
      return s?.id ?? null;
    },
  };
}

describe("I, Q and E once Isometric is offered (docs/design-v1-isometric-view.md 6.5)", () => {
  test("the table and the sheet hold them for everyone, with the standee's tap, on keys no other row has", () => {
    assert.equal(ISO_TEST_FLAG, "__rvttIsoTest", "the flag this file sets");
    assert.equal(isoOffered, true);
    for (const row of VIEW_SHORTCUTS) assert.ok(SHORTCUTS.includes(row), row.id);
    assert.ok(BEHAVIORS.includes(VIEW_BEHAVIORS[0]!));
    assert.deepEqual(
      VIEW_SHORTCUTS.map((s) => [s.keys, s.does, s.roles.join(" ")]),
      [
        ["I", "Switch between top-down and isometric", "dm player"],
        ["Q", "Turn the isometric view left", "dm player"],
        ["E", "Turn the isometric view right", "dm player"],
      ],
    );
    const defaults = Object.entries(DEFAULT_KEYS);
    for (const s of VIEW_SHORTCUTS) {
      const others = defaults.filter(([id, k]) => id !== s.id && sameKey(k, s.key!)).map(([id]) => id);
      assert.deepEqual(others, [], `${s.id}'s ${s.key} is its own`);
    }
    for (const role of ["dm", "player"] as const) {
      const sections = sheetSections(role, { mouse: true, android: false }, DEFAULT_KEYS);
      const keys = sections.find((s) => s.title === "Keys")!.rows.map((r) => r.input);
      for (const k of ["I", "Q", "E"]) assert.ok(keys.includes(k), `${role} ${k}`);
      const drags = sections.find((s) => s.title === "Mouse and touch")!.rows;
      assert.ok(drags.some((r) => r.input === "Tap a standee again" && r.does === "Pick the one behind it, in isometric"), role);
    }
  });

  test("I picks the other view, for the whole room, and Following an Isometric scene it picks Top-down", () => {
    const p = page();
    assert.equal(p.hit("i"), "view");
    assert.equal(readView(p.key).pick, "isometric");
    assert.equal(p.hit("i"), "view");
    assert.equal(readView(p.key).pick, "topDown");
    const following = page({ suggested: "isometric" });
    following.hit("i");
    assert.equal(readView(following.key).pick, "topDown");
    assert.deepEqual(p.notes, [], "a change the board shows needs no toast");
  });

  test("E and Q turn this scene's Isometric one step each way, never as a pick, and the scene's turn alone", () => {
    const p = page({ suggested: "isometric" });
    assert.equal(p.hit("e"), "turnRight");
    assert.deepEqual(readView(p.key), { pick: null, turns: [["s1", 1]] }, "Q while following still follows");
    p.hit("e");
    p.hit("q");
    p.hit("q");
    p.hit("q");
    assert.deepEqual(readView(p.key).turns, [["s1", 3]], "round past 0");
    p.state.sceneId = "s2";
    pickView(p.key, "isometric");
    p.hit("e");
    assert.deepEqual(readView(p.key).turns, [
      ["s1", 3],
      ["s2", 1],
    ]);
    assert.deepEqual(p.notes, []);
  });

  test("in Top-down Q and E turn nothing and say why, and while a tool shows Top-down they and I say the tool's line", () => {
    const flat = page();
    assert.equal(flat.hit("q"), "turnLeft");
    assert.equal(flat.hit("e"), "turnRight");
    assert.deepEqual(readView(flat.key), { pick: null, turns: [] });
    assert.deepEqual(flat.notes, ["Turning needs the isometric view.", "Turning needs the isometric view."]);

    const building = page({ role: "dm", tool: "build", suggested: "isometric" });
    building.hit("e");
    assert.deepEqual(readView(building.key).turns, [], "the board shows Top-down");
    assert.deepEqual(building.notes, ["The map builder works top-down. Isometric comes back when you switch tools."]);
    building.hit("i");
    assert.equal(readView(building.key).pick, "topDown", "I records the pick");
    assert.equal(building.said(), "Top-down view.", "said, since the board shows no change");
    building.hit("i");
    assert.equal(readView(building.key).pick, "isometric");
    assert.equal(building.notes.at(-1), "The map builder works top-down. Isometric comes back when you switch tools.");
    assert.equal(withPick(readView(building.key), null).pick, null);
  });

  test("a key someone gave another shortcut before Q was Turn left's stays theirs, and Turn left has no key, in the sheet too (D-261026-12)", () => {
    // A device that moved Fit to Q and the sheet's ? to E.
    const keys = shortcutKeys({ fit: "q", sheet: "e" });
    assert.equal(keys.fit, "q");
    assert.equal(keys.turnLeft, "", "Turn left has no key");
    assert.equal(keys.turnRight, "", "nor Turn right");
    assert.equal(keys.view, "i", "I is no one else's");
    const dm = page({ role: "dm", suggested: "isometric" });
    assert.equal(shortcutFor(press("q"), dm.env, { dialogOpen: false, preview: false }, keys)?.id, "fit", "Q fits the map");
    assert.equal(shortcutFor(press("e"), dm.env, { dialogOpen: false, preview: false }, keys)?.id, "sheet");
    for (const role of ["dm", "player"] as const) {
      const rows = sheetSections(role, { mouse: true, android: false }, keys).find((s) => s.title === "Keys")!.rows;
      for (const id of ["turnLeft", "turnRight"]) {
        const row = rows.find((r) => r.id === id)!;
        assert.equal(row.input, NO_KEY, `${role} ${id}`);
        assert.equal(row.keys, false, "written as words, not a key");
        assert.equal(row.rebind?.changed, true, "with its Reset");
      }
      assert.equal(rows.find((r) => r.id === "sheet")?.input, "E");
    }
    assert.equal(NO_KEY, "No key");
  });

  test("with no scene on screen the keys are free", () => {
    const p = page({ scene: false });
    for (const k of ["i", "q", "e"]) assert.equal(p.hit(k), null, k);
  });
});
