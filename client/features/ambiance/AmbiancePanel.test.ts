import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState } from "#shared/model.ts";
import { room, scene } from "#shared/testutil.ts";
import { RoomScope } from "../../state/scope.ts";

/*
 * Ambiance drawn to markup (docs/design/design-v1-panel-groups.md 4, 5 and 10):
 * the DM's Time, Weather row and Sound in that order, with the compact
 * start, no line under the panel's header, the summaries while folded and
 * the Weather row's name; a player's sections with no folds, kept ones, and
 * the empty line. At a phone's layout width (no window, so layoutWidth
 * reads 0).
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScopeProvider } = await import("../../state/scope.ts");
const { default: AmbiancePanel } = await import("./AmbiancePanel.tsx");
const { ambianceKeptSlot } = await import("./kept.ts");
const { ambianceFoldsSlot } = await import("../../lib/folds.ts");

const items = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => void items.set(key, value),
  removeItem: (key: string) => void items.delete(key),
};

function seed<T>(store: { setState(s: T): void; getState(): T; getInitialState(): T }, state: T): void {
  store.setState(state);
  store.getInitialState = store.getState;
}

const CLOCK: NonNullable<RoomState["clock"]> = { id: "c1", rev: 1, t: 3 * 86_400 + 20 * 3_600, shown: true, calendar: { kind: "days" } };

type Setup = { view?: RoomState; role?: "dm" | "player"; sceneId?: string | null; scope?: RoomScope };

function draw(setup: Setup = {}): string {
  const view = setup.view ?? room();
  const store = createStore(() => ({
    view,
    you: { memberId: setup.role === "player" ? "p1" : "dm1", role: setup.role ?? "dm" },
    roomId: "r1",
    sceneId: setup.sceneId === undefined ? "s1" : setup.sceneId,
    connection: "open",
    pending: [],
    online: [],
    displays: 0,
    serverOffset: 0,
    local: { selectedIds: [], multi: false },
  }));
  return renderToStaticMarkup(
    createElement(RoomScopeProvider, {
      scope: setup.scope ?? new RoomScope(),
      children: createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1, newId: () => "x", sendEph: () => {} } as never,
        ui: { notify: () => {}, openPanel: () => {} } as never,
        assets: { url: () => "" } as never,
        children: createElement(AmbiancePanel, {} as never),
      }),
    }),
  );
}

/** Each group's name, whether it folds and is open, whether it opens elsewhere, its summary, and its top line, in order. */
function groups(markup: string) {
  return [...markup.matchAll(/<div data-panel-group="" style="([^"]*)">(.*?)<\/h3>/g)].map((m) => {
    const head = m[2]!;
    return {
      name: /data-group-name=""[^>]*>([^<]*)</.exec(head)?.[1],
      expanded: /aria-expanded="(true|false)"/.exec(head)?.[1] ?? null,
      opens: head.includes("data-group-open"),
      summary: /id="[^"]*-summary"[^>]*>([^<]*)</.exec(head)?.[1] ?? null,
      line: m[1]!.includes("border-top"),
      label: /aria-label="([^"]*)"/.exec(head)?.[1] ?? null,
    };
  });
}

const withScene = (over: Partial<RoomState> = {}) => {
  const base = room({ scenes: { s1: scene("s1", { name: "Goblin cave", weather: { kind: "rain", heavy: true, wind: "strong", toward: 0 } }) } });
  return { ...base, ...over } as RoomState;
};

describe("the DM's Ambiance", () => {
  test("Time, the Weather row, then Sound, with no line under the panel's header", () => {
    const g = groups(draw({ view: withScene() }));
    assert.deepEqual(g.map((x) => x.name), ["Time", "Weather", "Sound"]);
    assert.deepEqual(g.map((x) => x.line), [false, true, true]);
  });

  test("no clock: Time open on its start form, Sound open", () => {
    const html = draw({ view: withScene() });
    const g = groups(html);
    assert.equal(g[0]!.expanded, "true");
    assert.equal(g[2]!.expanded, "true");
    assert.match(html, /Start the clock/);
  });

  test("a clock running: Time folded with the chip's text, Sound open", () => {
    const g = groups(draw({ view: withScene({ clock: CLOCK }) }));
    assert.equal(g[0]!.expanded, "false");
    assert.match(g[0]!.summary ?? "", /^Day 4, 8:00 PM$/);
    assert.equal(g[2]!.expanded, "true");
  });

  test("the Weather row opens elsewhere, never folds, and names the scene's weather and where it opens", () => {
    const row = groups(draw({ view: withScene() }))[1]!;
    assert.equal(row.opens, true);
    assert.equal(row.expanded, null);
    assert.equal(row.summary, "Heavy rain · Strong wind");
    assert.equal(row.label, "Weather: Heavy rain · Strong wind, in Goblin cave&#x27;s settings");
  });

  test("with no scene in view the row says No scene and opens Scenes", () => {
    const row = groups(draw({ view: room({ scenes: {} }), sceneId: null }))[1]!;
    assert.equal(row.summary, "No scene");
    assert.equal(row.label, "Weather: no scene, in Scenes");
  });

  test("Sound folded by this device says what plays, and the groups keep their content mounted", () => {
    items.set("rvtt.ambianceFolds", JSON.stringify({ sound: false }));
    try {
      const html = draw({ view: withScene() });
      const g = groups(html);
      assert.equal(g[2]!.expanded, "false");
      assert.equal(g[2]!.summary, "Nothing is playing");
      assert.match(html, /hidden=""[^>]*>.*Effects/s, "Sound's sections stay mounted, hidden");
    } finally {
      items.clear();
    }
  });

  test("each group links its own section of the guide, as the Time and Sound panels did", () => {
    const html = draw({ view: withScene() });
    assert.match(html, /aria-label="Time in the DM guide \(opens in a new tab\)"/);
    assert.match(html, /aria-label="Sound in the DM guide \(opens in a new tab\)"/);
    assert.doesNotMatch(html, /Weather in the DM guide/);
  });

  test("a reveal opens Time for now, as the chip's request does", () => {
    const scope = new RoomScope();
    scope.get(ambianceFoldsSlot).reveal("time");
    assert.equal(groups(draw({ view: withScene({ clock: CLOCK }), scope }))[0]!.expanded, "true");
  });
});

describe("a player's Ambiance", () => {
  test("Time while the view holds the clock, a group with its icon and no fold", () => {
    const g = groups(draw({ role: "player", view: withScene({ clock: CLOCK }) }));
    assert.deepEqual(g.map((x) => [x.name, x.expanded, x.line]), [["Time", null, false]]);
  });

  test("a kept Time with the clock gone says the DM isn't sharing", () => {
    const scope = new RoomScope();
    seed(scope.get(ambianceKeptSlot), { time: true, sound: false });
    const html = draw({ role: "player", view: withScene(), scope });
    assert.deepEqual(groups(html).map((x) => x.name), ["Time"]);
    assert.match(html, /The DM isn&#x27;t sharing the date and time now\./);
  });

  test("Sound kept under Time, its own line over it", () => {
    const scope = new RoomScope();
    seed(scope.get(ambianceKeptSlot), { time: true, sound: true });
    const g = groups(draw({ role: "player", view: withScene({ clock: CLOCK }), scope }));
    assert.deepEqual(g.map((x) => [x.name, x.line]), [["Time", false], ["Sound", true]]);
  });

  test("Sound alone, with the clock not shared, is the panel's first group: no line over it", () => {
    const playing = { rev: 1, music: { run: "r", repeat: "all", fade: 5, now: { soundId: "pony", at: 0 } }, loops: {}, effects: [], volume: { music: 100, effects: 100 } };
    const g = groups(draw({ role: "player", view: withScene({ playing } as never) }));
    assert.deepEqual(g.map((x) => [x.name, x.line]), [["Sound", false]]);
  });

  test("nothing shared, playing or kept: one line, no section, no Weather", () => {
    const html = draw({ role: "player", view: withScene() });
    assert.deepEqual(groups(html), []);
    assert.match(html, /The DM isn&#x27;t sharing the date and time or playing sound now\./);
    assert.doesNotMatch(html, /Weather|Effects/);
  });
});
