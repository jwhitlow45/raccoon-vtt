import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import { member, room, scene } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";
import { createSceneFolds, resolveSceneFolds, SCENE_FOLDS_KEY, SCENE_GROUP_LABELS, SCENE_GROUPS, sceneFoldStarts, sceneFoldsSlot, writeSceneFold, type SceneFolds } from "./settingsFolds.ts";

/*
 * The scene settings page's groups and folds (docs/design-v1-map-discovery.md
 * 8.4): their order and names, where each starts on a phone and a wide
 * screen, what a device remembers, and the page as it draws them.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScopeProvider } = await import("../../state/scope.ts");
const { SceneSettings } = await import("./SceneSettings.tsx");

/** A device's localStorage, or one that throws as a private window's or blocked site data's does. */
function storage(initial: string | null = null, throws = false) {
  const items = new Map<string, string>();
  if (initial !== null) items.set(SCENE_FOLDS_KEY, initial);
  let writes = 0;
  return {
    items,
    writes: () => writes,
    getItem(key: string) {
      if (throws) throw new Error("blocked");
      return items.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (throws) throw new Error("blocked");
      writes++;
      items.set(key, value);
    },
  };
}

const PHONE: SceneFolds = { players: true, map: false, walls: false, scene: false };
const ALL_OPEN: SceneFolds = { players: true, map: true, walls: true, scene: true };

describe("the scene settings page's groups (8.4)", () => {
  test("What players see, Map image and grid, Walls and movement, then Size and view, still stored under scene", () => {
    assert.deepEqual(SCENE_GROUPS, ["players", "map", "walls", "scene"]);
    assert.deepEqual(
      SCENE_GROUPS.map((g) => SCENE_GROUP_LABELS[g]),
      ["What players see", "Map image and grid", "Walls and movement", "Size and view"],
    );
    assert.equal(SCENE_FOLDS_KEY, "rvtt.sceneSettingsFolds");
  });

  test("a device that folded the group when it was named Scene opens Size and view folded (docs/design-v1-design-pass.md 4.1)", () => {
    const before = storage(JSON.stringify({ scene: false }));
    assert.equal(resolveSceneFolds(before, 1440).scene, false);
    assert.equal(SCENE_GROUP_LABELS.scene, "Size and view");
  });

  test("below 900 px only What players see starts open, from 900 px every group does", () => {
    assert.deepEqual(sceneFoldStarts(0), PHONE);
    assert.deepEqual(sceneFoldStarts(390), PHONE);
    assert.deepEqual(sceneFoldStarts(899), PHONE);
    assert.deepEqual(sceneFoldStarts(900), ALL_OPEN);
    assert.deepEqual(sceneFoldStarts(1440), ALL_OPEN);
  });
});

describe("what a device remembers of the folds (8.4)", () => {
  test("with nothing stored, each group follows its start at the width", () => {
    assert.deepEqual(resolveSceneFolds(storage(), 390), PHONE);
    assert.deepEqual(resolveSceneFolds(storage(), 1440), ALL_OPEN);
  });

  test("a stored group keeps how it was left, and the rest follow their starts", () => {
    assert.deepEqual(resolveSceneFolds(storage(JSON.stringify({ scene: true, players: false })), 390), { players: false, map: false, walls: false, scene: true });
    assert.deepEqual(resolveSceneFolds(storage(JSON.stringify({ map: false })), 1440), { ...ALL_OPEN, map: false });
  });

  test("a stored value that is no boolean, or a key no group has, is passed over", () => {
    assert.deepEqual(resolveSceneFolds(storage(JSON.stringify({ map: "yes", walls: 1, grid: false })), 390), PHONE);
  });

  test("storage that cannot be read opens every group, on a phone too", () => {
    assert.deepEqual(resolveSceneFolds(storage(null, true), 390), ALL_OPEN, "storage that throws");
    assert.deepEqual(resolveSceneFolds(null, 390), ALL_OPEN, "no storage");
    assert.deepEqual(resolveSceneFolds(storage("{not json"), 390), ALL_OPEN, "a value that is no JSON");
    assert.deepEqual(resolveSceneFolds(storage("[true]"), 390), ALL_OPEN, "a list");
    assert.deepEqual(resolveSceneFolds(storage("null"), 390), ALL_OPEN, "null");
    assert.deepEqual(resolveSceneFolds(storage("true"), 390), ALL_OPEN, "a boolean");
  });

  test("a tap stores its group beside the others stored, and drops what no group is", () => {
    const s = storage(JSON.stringify({ walls: true, grid: false, map: "yes" }));
    writeSceneFold(s, "scene", false);
    assert.deepEqual(JSON.parse(s.items.get(SCENE_FOLDS_KEY)!), { walls: true, scene: false });
  });

  test("a tap over a value that is no JSON stores the group alone", () => {
    const s = storage("{not json");
    writeSceneFold(s, "map", true);
    assert.deepEqual(JSON.parse(s.items.get(SCENE_FOLDS_KEY)!), { map: true });
  });

  test("storage that throws or is missing takes the tap without a throw", () => {
    assert.doesNotThrow(() => writeSceneFold(storage(null, true), "map", true));
    assert.doesNotThrow(() => writeSceneFold(null, "map", true));
  });
});

describe("the folds for a Room page", () => {
  test("resolved once, so a width that crosses 900 px later never refolds a group", () => {
    const folds = createSceneFolds(storage());
    assert.deepEqual(folds.get(390), PHONE);
    assert.deepEqual(folds.get(1440), PHONE);
  });

  test("a tap changes its group, stores it and tells the page", () => {
    const s = storage();
    const folds = createSceneFolds(s);
    folds.get(1440);
    let heard = 0;
    const stop = folds.subscribe(() => heard++);
    folds.tap("walls", false);
    assert.deepEqual(folds.get(1440), { ...ALL_OPEN, walls: false });
    assert.deepEqual(JSON.parse(s.items.get(SCENE_FOLDS_KEY)!), { walls: false });
    assert.equal(heard, 1);
    stop();
    folds.tap("walls", true);
    assert.equal(heard, 1, "a listener that stopped hears nothing");
  });

  test("a new Room page reads what the last one stored", () => {
    const s = storage();
    createSceneFolds(s).tap("map", true);
    assert.deepEqual(createSceneFolds(s).get(390), { ...PHONE, map: true });
  });

  test("a tap before the page read its folds starts from the phone's starts", () => {
    const folds = createSceneFolds(storage());
    folds.tap("scene", true);
    assert.deepEqual(folds.get(1440), { ...PHONE, scene: true });
  });
});

describe("the page as it draws its groups (8.4)", () => {
  /** The page with the Room's folds set as `folds`, as taps would leave them, whatever this process's storage holds. */
  function page(folds: SceneFolds): string {
    const s1 = scene("s1", { name: "Crypt" });
    const view: RoomState = room({ members: { dm1: member("dm1", "dm") } });
    view.scenes.s1 = s1;
    const store = createStore(() => ({ view, you: { memberId: "dm1", role: "dm" }, roomId: "r1", sceneId: "s1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
    const scope = new RoomScope();
    const slot = scope.get(sceneFoldsSlot);
    slot.get(0);
    for (const g of SCENE_GROUPS) slot.tap(g, folds[g]);
    return renderToStaticMarkup(
      createElement(RoomScopeProvider, {
        scope,
        children: createElement(RoomProvider, {
          store: store as never,
          actions: { dispatch: () => 1, newId: () => "x" } as never,
          ui: { setTool: () => {} } as never,
          assets: { url: () => "" } as never,
          children: createElement(SceneSettings, { scene: s1, others: [], close: () => {} }),
        }),
      }),
    );
  }

  /** Each group header's name and whether it says it is open, and the plain section labels, in the page's order. */
  function headings(html: string): string[] {
    return [...html.matchAll(/<h3[^>]*>(?:<button[^>]*aria-expanded="(true|false)"[^>]*>)?([\s\S]*?)<\/h3>/g)].map((m) => {
      // A folded group's summary sits in its button beside the name (components/Panel.tsx), and is no part of it.
      const name = m[2]!.replace(/<span id="[^"]+-summary"[^>]*>[^<]*<\/span>/, "").replace(/<[^>]+>/g, "");
      return m[1] ? `${name} ${m[1] === "true" ? "open" : "folded"}` : name;
    });
  }

  test("the name under This scene, the four groups as folds, then Export as image and Delete", () => {
    const html = page(PHONE);
    assert.deepEqual(headings(html), ["This scene", "What players see open", "Map image and grid folded", "Walls and movement folded", "Size and view folded", "Export as image", "Delete"]);
    assert.ok(html.indexOf("This scene") < html.indexOf("Scene name") && html.indexOf("Scene name") < html.indexOf("What players see"), "the name comes first, under its label");
    assert.equal(/>Grid<|>Movement<|>Map builder</.test(html), false, "no section of the old page is left");
  });

  test("a folded group keeps its settings drawn but hidden, and an open one shows them, each in its group", () => {
    const html = page(PHONE);
    const at = (words: string) => html.indexOf(words);
    // Map image and grid: the map image, then the grid's look.
    assert.ok(at("Map image and grid") < at("Add a map image") && at("Add a map image") < at("Grid lines") && at("Grid lines") < at("Walls and movement"));
    // Walls and movement: the movement switch, automatic walls, then the builder's buttons.
    assert.ok(at("Walls and movement") < at("Walls and ledges block players") && at("Walls and ledges block players") < at("Automatic walls") && at("Automatic walls") < at("Open the builder") && at("Open the builder") < at("Clear the build"));
    // Size and view: size, background, then the starting view.
    assert.ok(at("Clear the build") < at("Size in squares") && at("Size in squares") < at("Background") && at("Background") < at("Starting view") && at("Starting view") < at("Export as image"));
    const bodies = [...html.matchAll(/<div (hidden="")? ?style="display:(grid|none);grid-template-columns:minmax\(0, 1fr\)/g)].map((m) => `${m[1] ? "hidden" : "shown"} ${m[2]}`);
    // A folded body keeps its grid: the hidden attribute alone hides it (globals.css).
    assert.deepEqual(bodies, ["shown grid", "hidden grid", "hidden grid", "hidden grid"]);
    assert.deepEqual(headings(page(ALL_OPEN)).slice(1, 5), ["What players see open", "Map image and grid open", "Walls and movement open", "Size and view open"]);
  });

  test("a folded group says what it holds beside its name, with its icon, and an open one says nothing (docs/design-v1-design-pass.md 4.1)", () => {
    const html = page(PHONE);
    const summaries = [...html.matchAll(/<span id="([^"]+)-summary"[^>]*>([^<]*)<\/span>/g)].map((m) => m[2]);
    assert.deepEqual(summaries, ["No map image · Squares", "Walls do not block moves", "40 × 30 squares"]);
    assert.equal((html.match(/data-group-icon=""/g) ?? []).length, 4, "each group's icon");
  });

  test("a group stays as the device left it", () => {
    const html = page({ players: false, map: true, walls: false, scene: true });
    assert.deepEqual(headings(html).slice(1, 5), ["What players see folded", "Map image and grid open", "Walls and movement folded", "Size and view open"]);
  });
});
