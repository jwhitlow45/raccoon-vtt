import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Scene } from "#shared/model.ts";
import { member, room, scene } from "#shared/testutil.ts";
import { api } from "../../lib/api.ts";
import { scenesFoldsSlot, type ScenesSection } from "../../lib/folds.ts";
import { RoomScope } from "../../state/scope.ts";
import { SCENE_GROUP_ICONS, SCENE_GROUP_LABELS, SCENE_GROUPS } from "./settingsFolds.ts";

/*
 * The scene settings page as it draws its groups
 * (docs/design/design-v1-scenes-reorg.md 3, 12): their order and names, the
 * order inside Light and weather, Scene sound only while the server offers
 * sound files, Fog and vision's "No walls" tag while folded, and no Delete
 * section. The folds' store is lib/folds.test.ts's.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScopeProvider } = await import("../../state/scope.ts");
const { SceneSettings } = await import("./SceneSettings.tsx");
const sound = await import("../sound/engine/store.ts");

const MAP = { assetId: "a", widthPx: 700, heightPx: 700, cellPx: 70, originPx: { x: 0, y: 0 } };

type Folds = Partial<Record<ScenesSection, boolean>>;
const PHONE: Folds = { light: true, sound: false, players: false, map: false, walls: false, scene: false };
const ALL_OPEN: Folds = { light: true, sound: true, players: true, map: true, walls: true, scene: true };

/** The page with the Room's folds set as `folds`, as taps would leave them, whatever this process's storage holds. */
function page(folds: Folds, over: Partial<Scene> = {}, view?: (s: RoomState) => void): string {
  const s1 = scene("s1", { name: "Crypt", ...over });
  const state: RoomState = room({ members: { dm1: member("dm1", "dm") } });
  state.scenes.s1 = s1;
  view?.(state);
  const store = createStore(() => ({ view: state, you: { memberId: "dm1", role: "dm" }, roomId: "r1", sceneId: "s1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
  const scope = new RoomScope();
  const slot = scope.get(scenesFoldsSlot);
  slot.get(0, { clock: false, scenes: true });
  for (const [g, open] of Object.entries(folds)) slot.tap(g as ScenesSection, open);
  return renderToStaticMarkup(
    createElement(RoomScopeProvider, {
      scope,
      children: createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1, newId: () => "x" } as never,
        ui: { setTool: () => {} } as never,
        assets: { url: () => "" } as never,
        children: createElement(SceneSettings, { scene: state.scenes.s1!, others: [], close: () => {} }),
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

/** The whole box of the group named `name`, from its `data-panel-group` div to the div that closes it. */
function groupBox(html: string, name: string): string {
  const start = html.lastIndexOf('<div data-panel-group=""', html.indexOf(`>${name}<`));
  const tags = /<(\/?)div\b[^>]*>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, tags.lastIndex);
  }
  return html.slice(start);
}

/** The text of every element an `aria-describedby` on the tag matching `at` names, in its order. */
function described(html: string, at: RegExp): string[] {
  const tag = html.match(at)?.[0] ?? "";
  const ids = /aria-describedby="([^"]+)"/.exec(tag)?.[1]?.split(" ") ?? [];
  return ids.map((id) => {
    const open = html.indexOf(`id="${id}"`);
    assert.ok(open >= 0, `${id} is on the page`);
    const start = html.indexOf(">", open) + 1;
    return html.slice(start, html.indexOf("</", start)).replace(/<[^>]+>/g, "");
  });
}

/** Turns the server's sound switch on for one test, as GET /api/config would. */
async function soundOn(): Promise<void> {
  sound.resetServerRoomSoundForTests();
  const real = api.getConfig;
  api.getConfig = (async () => ({ roomSound: true })) as unknown as typeof api.getConfig;
  await sound.serverRoomSound();
  api.getConfig = real;
}

afterEach(() => sound.resetServerRoomSoundForTests());

describe("the scene settings page's groups (docs/design/design-v1-scenes-reorg.md 3)", () => {
  test("Light and weather, Scene sound, Fog and vision, Map and grid, Walls and movement, then Size and view, each with its icon", () => {
    assert.deepEqual(SCENE_GROUPS, ["light", "sound", "players", "map", "walls", "scene"]);
    assert.deepEqual(
      SCENE_GROUPS.map((g) => SCENE_GROUP_LABELS[g]),
      ["Light and weather", "Scene sound", "Fog and vision", "Map and grid", "Walls and movement", "Size and view"],
    );
    assert.deepEqual(
      SCENE_GROUPS.map((g) => SCENE_GROUP_ICONS[g]),
      ["weather", "music", "shown", "image", "walls", "scenes"],
    );
  });

  test("with the server offering no sound files: the name, Light and weather open, the setup groups folded, then Export, and no Delete section", () => {
    const html = page(PHONE);
    assert.deepEqual(headings(html), ["This scene", "Light and weather open", "Fog and vision folded", "Map and grid folded", "Walls and movement folded", "Size and view folded", "Export"]);
    assert.doesNotMatch(html, />Delete scene</, "the row's ⋯ menu keeps Delete (SceneMenu.tsx)");
    assert.doesNotMatch(html, /What players see|Map image and grid|Export as image<\/h3>/);
  });

  test("with sound files offered, Scene sound comes second, folded, and says what the scene plays", async () => {
    await soundOn();
    const html = page(PHONE);
    assert.deepEqual(headings(html).slice(1, 4), ["Light and weather open", "Scene sound folded", "Fog and vision folded"]);
    const summaries = [...html.matchAll(/<span id="([^"]+)-summary"[^>]*>([^<]*)<\/span>/g)].map((m) => m[2]);
    assert.equal(summaries[0], "None of its own");
    assert.match(html, /Crypt has no sound of its own\./, "the group holds the scene's line, kept drawn while folded");
    assert.match(page(PHONE, { sound: { music: null, loops: [] } }), /-summary"[^>]*>Silent</);
  });

  test("Light and weather holds the light, then the weather's rows, then where devices decide, all before Fog and vision", () => {
    const html = page(ALL_OPEN, { weather: { kind: "rain", heavy: true, wind: "strong" } });
    const at = (words: string) => html.indexOf(words);
    const order = ["Light and weather", "Light level", 'aria-label="Weather"', "Strength", "Wind blows toward", "Weather rules on rolls", "Players see it at once", ">Fog and vision<", ">Explore<"];
    for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]!) < at(order[i]!) && at(order[i - 1]!) >= 0, `${order[i - 1]} before ${order[i]}`);
    assert.doesNotMatch(html, /aria-expanded="[^"]*"[^>]*>(?:<[^>]+>)*Weather</, "the Weather fold is gone");
    // Inside the group's own box, so the weather folds with it.
    const light = groupBox(html, "Light and weather");
    assert.match(light, /aria-label="Light level"[\s\S]*aria-label="Weather"[\s\S]*Players see it at once/);
  });

  test("folded, each group says what it holds beside its name, and Light and weather, open everywhere, says nothing", () => {
    const html = page({ ...PHONE, light: false }, { fogEnabled: true, vision: { on: true, light: "dim", perPlayer: true }, weather: { kind: "rain", heavy: true, wind: "strong" } });
    const summaries = [...html.matchAll(/<span id="([^"]+)-summary"[^>]*>([^<]*)<\/span>/g)].map((m) => m[2]);
    assert.deepEqual(summaries, ["Dim · Heavy rain · Strong wind", "Explore · Per player", "No map image · Squares", "Walls do not block moves", "40 × 30 squares"]);
    assert.equal((page(PHONE).match(/<span id="[^"]+-summary"/g) ?? []).length, 4, "open, Light and weather shows no summary");
  });

  test("a folded group keeps its settings drawn but hidden, and an open one shows them", () => {
    const bodies = (html: string) => [...html.matchAll(/<div (hidden="")? ?style="display:grid;grid-template-columns:minmax\(0, 1fr\);gap/g)].map((m) => (m[1] ? "hidden" : "shown"));
    assert.deepEqual(bodies(page(PHONE)), ["shown", "hidden", "hidden", "hidden", "hidden"]);
    assert.deepEqual(bodies(page(ALL_OPEN)), ["shown", "shown", "shown", "shown", "shown"]);
  });
});

describe("Fog and vision's No walls tag (D-261102-932)", () => {
  const explore = { fogEnabled: true, vision: { on: true, light: "dark" as const }, map: MAP };
  const fold = /<button[^>]*data-group-fold=""[^>]*aria-labelledby="([^"]+)"[^>]*>(?:(?!<\/button>)[\s\S])*?Fog and vision/;

  test("folded on Explore over a map with no walls, the row wears the tag in the warning tone, and the fold is described by its summary, then the tag", () => {
    for (const perPlayer of [false, true]) {
      const html = page(PHONE, { ...explore, vision: perPlayer ? { ...explore.vision, perPlayer: true } : explore.vision });
      assert.match(html, />No walls<\/span>/);
      assert.deepEqual(described(html, fold), [perPlayer ? "Explore · Per player" : "Explore", "No walls"]);
    }
  });

  test("open, the warning shows under Players see and the tag goes", () => {
    const html = page(ALL_OPEN, explore);
    assert.doesNotMatch(html, />No walls<\/span>/);
    assert.match(html, /This map has no walls yet, so party vision shows players all of it at once\./);
    assert.deepEqual(described(html, fold), []);
  });

  test("no tag where no warning holds: a wall on the map, Reveal by hand, or no map image", () => {
    const walled = page(PHONE, explore, (s) => {
      s.buildChunks = { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: { "3,4,w": { kind: "wall" } } } };
    });
    assert.doesNotMatch(walled, />No walls</);
    assert.doesNotMatch(page(PHONE, { ...explore, vision: { on: false, light: "dark" } }), />No walls</);
    assert.doesNotMatch(page(PHONE, { fogEnabled: true, vision: { on: true, light: "dark" } }), />No walls</);
  });
});

describe("New scene, a folding group over the settings (docs/design/design-v1-panel-groups.md 6.2)", () => {
  /** The DM's Scenes panel with the Room's New scene fold as a tap leaves it. Its starts are lib/folds.test.ts's. */
  async function panel(open: boolean, scenes = true): Promise<string> {
    const { default: ScenesPanel } = await import("../../panels/ScenesPanel.tsx");
    const state: RoomState = room({ members: { dm1: member("dm1", "dm") } });
    if (!scenes) state.scenes = {};
    const store = createStore(() => ({ view: state, you: { memberId: "dm1", role: "dm" }, roomId: "r1", sceneId: null, connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
    const scope = new RoomScope();
    const slot = scope.get(scenesFoldsSlot);
    slot.get(390, { clock: false, scenes });
    slot.tap("new", open);
    return renderToStaticMarkup(
      createElement(RoomScopeProvider, {
        scope,
        children: createElement(RoomProvider, {
          store: store as never,
          actions: { dispatch: () => 1, newId: () => "x" } as never,
          ui: { setTool: () => {} } as never,
          assets: { url: () => "" } as never,
          children: createElement(ScenesPanel, { close: () => {} } as never),
        }),
      }),
    );
  }
  const newScene = /<div data-panel-group=""[^>]*><div[^>]*><h3[^>]*><button[^>]*data-group-fold=""[^>]*aria-expanded="(true|false)"[^>]*>([\s\S]*?)<\/button><\/h3>/;

  test("a fold named New scene with no icon, its space kept so the name lines up with the groups that wear one, its form kept drawn while folded", async () => {
    const html = await panel(false);
    const m = newScene.exec(html);
    assert.ok(m, "New scene is a group's fold");
    assert.equal(m[1], "false");
    assert.match(m[2]!, /data-group-reserve=""/, "the icon's space reserved");
    assert.doesNotMatch(m[2]!, /data-group-icon=""/);
    assert.match(m[2]!, />New scene</);
    assert.match(html, /<div hidden=""[^>]*>[\s\S]*?Battle mat/, "the form stays mounted, hidden");
    assert.equal(newScene.exec(await panel(true))?.[1], "true");
  });
});
