import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Scene } from "#shared/model.ts";
import { member, room, scene, token } from "#shared/testutil.ts";
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
const { mapImageLines, SceneSettings } = await import("./SceneSettings.tsx");
const sound = await import("../sound/engine/store.ts");

const MAP = { assetId: "a", widthPx: 700, heightPx: 700, cellPx: 70, originPx: { x: 0, y: 0 } };
const VIDEO_MAP = { ...MAP, video: { assetId: "v", widthPx: 700, heightPx: 700, container: "webm" as const, video: "vp09.00.40.08", fps: 30, durationMs: 4000, kbps: 900 } };

type Folds = Partial<Record<ScenesSection, boolean>>;
const PHONE: Folds = { floors: false, light: true, sound: false, players: false, map: false, walls: false, scene: false };
const ALL_OPEN: Folds = { floors: true, light: true, sound: true, players: true, map: true, walls: true, scene: true };

/** The page with the Room's folds set as `folds`, as taps would leave them, whatever this process's storage holds. */
function page(folds: Folds, over: Partial<Scene> = {}, view?: (s: RoomState) => void): string {
  const s1 = scene("s1", { name: "Crypt", ...over });
  const state: RoomState = room({ members: { dm1: member("dm1", "dm") } });
  state.scenes.s1 = s1;
  view?.(state);
  const store = createStore(() => ({ view: state, floorView: state, you: { memberId: "dm1", role: "dm" }, roomId: "r1", sceneId: "s1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
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
  test("Floors, Light and weather, Scene sound, Fog and vision, Map and grid, Walls and movement, then Size and view, each with its icon", () => {
    assert.deepEqual(SCENE_GROUPS, ["floors", "light", "sound", "players", "map", "walls", "scene"]);
    assert.deepEqual(
      SCENE_GROUPS.map((g) => SCENE_GROUP_LABELS[g]),
      ["Floors", "Light and weather", "Scene sound", "Fog and vision", "Map and grid", "Walls and movement", "Size and view"],
    );
    assert.deepEqual(
      SCENE_GROUPS.map((g) => SCENE_GROUP_ICONS[g]),
      ["floors", "weather", "music", "shown", "image", "walls", "scenes"],
    );
  });

  test("with the server offering no sound files: the name, Light and weather open, the setup groups folded, then Export, and no Delete section", () => {
    const html = page(PHONE);
    assert.deepEqual(headings(html), ["This scene", "Floors folded", "Light and weather open", "Fog and vision folded", "Map and grid folded", "Walls and movement folded", "Size and view folded", "Export"]);
    assert.doesNotMatch(html, />Delete scene</, "the row's ⋯ menu keeps Delete (SceneMenu.tsx)");
    assert.doesNotMatch(html, /What players see|Map image and grid|Export as image<\/h3>/);
  });

  test("with sound files offered, Scene sound comes after Light and weather, folded, and says what the scene plays", async () => {
    await soundOn();
    const html = page(PHONE);
    assert.deepEqual(headings(html).slice(2, 5), ["Light and weather open", "Scene sound folded", "Fog and vision folded"]);
    const summaries = [...html.matchAll(/<span id="([^"]+)-summary"[^>]*>([^<]*)<\/span>/g)].map((m) => m[2]);
    assert.equal(summaries[0], "One floor", "Floors comes first");
    assert.equal(summaries[1], "None of its own");
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
    assert.deepEqual(summaries, ["One floor", "Dim · Heavy rain · Strong wind", "Explore · Per player", "No map image · Squares", "Walls do not block moves", "40 × 30 squares"]);
    assert.equal((page(PHONE).match(/<span id="[^"]+-summary"/g) ?? []).length, 5, "open, Light and weather shows no summary");
  });

  test("Map and grid's count row is Square count", () => {
    const html = page(ALL_OPEN, { map: MAP });
    assert.equal((html.match(/>Square count</g) ?? []).length, 1);
    assert.doesNotMatch(html, /Or count the squares/);
  });

  test("each group's summary asks for its whole words, never the 4em floor that cut Map and grid's and Walls and movement's (docs/design/design-v1-polish-pass.md 3.1)", () => {
    const html = page({ ...PHONE, light: false }, { map: MAP, weather: { kind: "rain", heavy: true, wind: "strong" } });
    const looks = [...html.matchAll(/<span id="[^"]+-summary" style="([^"]*)"/g)].map((m) => m[1]!);
    assert.equal(looks.length, 6);
    for (const look of looks) {
      assert.match(look, /^flex:0 1 auto;min-width:0;margin-left:auto/, look);
      assert.doesNotMatch(look, /4em|max-width/, look);
    }
  });

  test("a folded group keeps its settings drawn but hidden, and an open one shows them", () => {
    const bodies = (html: string) => [...html.matchAll(/<div (hidden="")? ?style="display:grid;grid-template-columns:minmax\(0, 1fr\);gap/g)].map((m) => (m[1] ? "hidden" : "shown"));
    assert.deepEqual(bodies(page(PHONE)), ["hidden", "shown", "hidden", "hidden", "hidden", "hidden"]);
    assert.deepEqual(bodies(page(ALL_OPEN)), ["shown", "shown", "shown", "shown", "shown", "shown"]);
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
    const store = createStore(() => ({ view: state, floorView: state, you: { memberId: "dm1", role: "dm" }, roomId: "r1", sceneId: null, connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
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

describe("Map and grid's Map image row: Use the still only last on the picker's line, Remove map image alone on the last (docs/design/design-v1-polish-pass.md 3.3)", () => {
  type State = Parameters<typeof mapImageLines>[0];
  const at = (over: Partial<State>): State => ({ playersHere: false, armed: false, busy: false, map: true, video: true, firstFog: false, ...over });
  /** A plan as words: a filled line's parts joined by " + ", a line at its buttons' own widths marked so. */
  const plan = (s: State) => mapImageLines(s).map((l) => (typeof l === "string" ? l : `${l.buttons.join(" + ")}${l.fill ? "" : " (own width)"}`));

  test("each state's lines, every button reachable in each", () => {
    assert.deepEqual(plan(at({})), ["picker + paste + still", "remove"], "players elsewhere");
    assert.deepEqual(plan(at({ playersHere: true })), ["ask + still", "remove"], "players here, unarmed");
    assert.deepEqual(plan(at({ playersHere: true, armed: true })), ["note", "picker + paste + still", "cancel (own width)", "remove"], "players here, armed");
    assert.deepEqual(plan(at({ playersHere: true, armed: true, firstFog: true })), ["note", "fog", "picker + paste + still", "cancel (own width)", "remove"], "the first map's fog choice after the players' Note");
    assert.deepEqual(plan(at({ busy: true })), ["picker + paste + still", "remove"], "busy, players elsewhere");
    for (const armed of [false, true]) assert.deepEqual(plan(at({ playersHere: true, armed, busy: true })), ["note", "picker + paste + still", "remove"], "busy on the players' scene: their Note first, no Cancel of the ask");
  });

  test("a still image has no Use the still only, a scene with no image no Remove, and every filled line holds only parts that draw", () => {
    assert.deepEqual(plan(at({ video: false })), ["picker + paste", "remove"]);
    assert.deepEqual(plan(at({ playersHere: true, video: false })), ["ask", "remove"]);
    assert.deepEqual(plan(at({ map: false, video: false, firstFog: true })), ["picker + paste", "help"]);
    assert.deepEqual(plan(at({ map: false, video: false, playersHere: true })), ["ask"]);
    // Every state: Remove alone and last of the buttons, the still last on its line, no line empty, and no two lines starting alike (their keys).
    for (const playersHere of [false, true])
      for (const armed of [false, true])
        for (const busy of [false, true])
          for (const [map, video] of [[false, false], [true, false], [true, true]] as const)
            for (const firstFog of [false, true]) {
              const lines = mapImageLines({ playersHere, armed, busy, map, video, firstFog });
              const buttons = lines.flatMap((l) => (typeof l === "string" ? [] : [l]));
              const name = JSON.stringify({ playersHere, armed, busy, map, video, firstFog });
              assert.ok(buttons.every((l) => l.buttons.length > 0), name);
              assert.equal(new Set(buttons.map((l) => l.buttons[0])).size, buttons.length, name);
              assert.equal(buttons.flatMap((l) => l.buttons).filter((b) => b === "remove").length, map ? 1 : 0, name);
              if (map) assert.deepEqual(buttons.at(-1), { buttons: ["remove"], fill: true }, name);
              assert.equal(buttons.flatMap((l) => l.buttons).filter((b) => b === "still").length, video ? 1 : 0, name);
              for (const l of buttons) if (l.buttons.includes("still")) assert.equal(l.buttons.at(-1), "still", name);
              assert.ok(buttons.some((l) => l.buttons.includes("ask") || l.buttons.includes("picker")), name);
            }
  });

  /** The Map image row's lines of buttons as drawn: each line's words, a filled line's cells joined by " + ". */
  function drawnLines(html: string): string[] {
    const row = divAt(html, html.lastIndexOf('<div data-setting-row=""', html.indexOf(">Map image<")));
    const LINE = '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
    const CELL = '<div style="display:grid;flex:1 1 auto">';
    const out: string[] = [];
    for (let i = row.indexOf(LINE); i >= 0; i = row.indexOf(LINE, i + 1)) {
      const line = divAt(row, i);
      const words = (h: string) => h.replace(/<[^>]+>/g, "").trim();
      const cells = childDivs(line);
      out.push(cells.length > 0 && cells.every((c) => c.startsWith(CELL)) ? cells.map(words).join(" + ") : `${words(line)} (own width)`);
    }
    return out;
  }

  test("drawn with the players elsewhere: Replace map image, Paste an image and Use the still only share a filled line, then Remove map image alone", () => {
    const html = page(ALL_OPEN, { map: VIDEO_MAP }, (s) => {
      s.meta.playerSceneId = "s2";
    });
    assert.deepEqual(drawnLines(html), ["Replace map image + Paste an image + Use the still only", "Remove map image"]);
  });

  test("drawn on the players' scene, unarmed: the ask and Use the still only, then Remove map image alone, its words free to wrap inside it", () => {
    const html = page(ALL_OPEN, { map: VIDEO_MAP });
    assert.deepEqual(drawnLines(html), ["Replace map image + Use the still only", "Remove map image"]);
    assert.match(html, /<button type="button"[^>]*style="[^"]*white-space:normal;overflow-wrap:anywhere;text-align:center[^"]*"[^>]*>Remove map image<\/button>/);
    assert.deepEqual(drawnLines(page(ALL_OPEN, { map: MAP })), ["Replace map image", "Remove map image"], "a still image: no Use the still only, and no empty cell");
  });

  test("on a floor of the players' scene, the ask comes where players have the floor, and not on a floor they have not reached (design-v1-floors.md 8.3)", () => {
    const upper = { map: VIDEO_MAP, name: "Tower", floor: { of: "g", level: 1, name: "Upper floor", height: 10 } };
    const tower = (party: boolean) => (s: RoomState) => {
      s.scenes.g = scene("g", { name: "Tower", floor: { of: "g", level: 0, name: "Ground floor" } });
      s.meta.playerSceneId = "g";
      if (party) s.tokens.t1 = token("t1", { sceneId: "s1", kind: "pc", partyVision: true });
    };
    assert.deepEqual(drawnLines(page(ALL_OPEN, upper, tower(true))), ["Replace map image + Use the still only", "Remove map image"], "a party member upstairs: players see Upper floor");
    assert.deepEqual(drawnLines(page(ALL_OPEN, upper, tower(false))), ["Replace map image + Paste an image + Use the still only", "Remove map image"], "not reached: the DM prepares it in private");
  });
});

/** The div that opens at `start`, whole. */
function divAt(html: string, start: number): string {
  assert.ok(start >= 0);
  const tags = /<(\/?)div\b[^>]*>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, tags.lastIndex);
  }
  return html.slice(start);
}

/** The divs directly inside a div's markup, each whole. */
function childDivs(box: string): string[] {
  const out: string[] = [];
  const tags = /<(\/?)div\b[^>]*>/g;
  let depth = 0;
  for (let m = tags.exec(box); m; m = tags.exec(box)) {
    if (!m[1] && depth === 1) out.push(divAt(box, m.index));
    depth += m[1] ? -1 : 1;
  }
  return out;
}
