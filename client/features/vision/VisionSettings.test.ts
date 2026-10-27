import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Scene } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { member, room, scene } from "#shared/testutil.ts";

/*
 * The per-player parts of What players see as the DM's panel draws them
 * (docs/design-v1-per-player-vision.md 7.1 and 11): the Sight row under
 * the switch, named and described, who sees for themselves, and both busy
 * while their change is on its way.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { VisionSettings } = await import("./VisionSettings.tsx");

function table(vision: Scene["vision"], fogEnabled = true): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), ana: { ...member("ana"), name: "Ana" }, gus: { ...member("gus"), name: "Gus" } } });
  s.scenes.s1 = scene("s1", { fogEnabled, vision });
  s.holders.s1 = { sceneId: "s1", rev: 1, entries: [{ memberId: "ana", on: true }, { memberId: "gus", on: false }] };
  return s;
}

function render(view: RoomState, pending: { op: ClientOp }[] = []): string {
  const store = createStore(() => ({ view, you: { memberId: "dm1", role: "dm" }, roomId: "r1", connection: "open", pending, local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1, newId: () => "x" } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(VisionSettings, { scene: view.scenes.s1! }),
    }),
  );
}

/** The text of the element whose id an attribute of the element matching `at` names. */
function named(html: string, at: RegExp, attr: "aria-labelledby" | "aria-describedby"): string {
  const tag = html.match(at)?.[0] ?? "";
  const id = new RegExp(`${attr}="([^"]+)"`).exec(tag)?.[1];
  assert.ok(id, `${at} has ${attr}`);
  const open = html.indexOf(`id="${id}"`);
  const start = html.indexOf(">", open) + 1;
  return html.slice(start, html.indexOf("</", start)).replace(/<[^>]+>/g, "");
}

describe("What players see on a per-player scene (7.1, 11)", () => {
  test("the Sight row shows with vision off, a radio group named Sight and described by Per player's help, then who sees for themselves", () => {
    const html = render(table({ on: false, light: "dark", perPlayer: true }));
    const sight = /<div data-vision-sight[\s\S]*?(<div role="radiogroup"[^>]*>)/;
    const sightGroup = new RegExp(sight.exec(html)![1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    assert.equal(named(html, sightGroup, "aria-labelledby"), "Sight");
    assert.match(named(html, sightGroup, "aria-describedby"), /^Each player sees only what their own creatures see/);
    assert.equal(named(html, /<div role="group"[^>]*aria-describedby[^>]*>/, "aria-labelledby"), "Who sees for themselves");
    assert.equal(named(html, /<div role="group"[^>]*aria-describedby[^>]*>/, "aria-describedby"), "Players not ticked, and the table display, see only what creatures that share sight with the party see.");
    assert.match(html, /Gus sees only what creatures that share sight see here\./);
    assert.doesNotMatch(html, /Ana sees only/, "Ana's entry is on");
    assert.match(html, /<input type="radio"[^>]*checked=""[^>]*value="player"/);
    assert.ok(html.indexOf("data-vision-sight") > html.indexOf("Light level"), "after the light (docs/design-v1-map-discovery.md 8.4)");
    assert.ok(html.indexOf("data-vision-sight") < html.indexOf("Fog and party vision"), "before the fold");
    assert.doesNotMatch(html, /aria-busy/);
    // Each row's question speaks through a status mounted before it has words (PV4-OP-5), so a screen reader hears them come.
    const list = html.slice(html.indexOf("Who sees for themselves"), html.indexOf("Fog and party vision"));
    assert.equal((list.match(/<p role="status"[^>]*><\/p>/g) ?? []).length, 2, "Ana's row and Gus's");
  });

  test("the switch's help on a per-player scene, and no row on a whole-party scene with vision off", () => {
    // The switch is in the fold, which Custom opens.
    assert.match(render(table({ on: true, light: "dark", perPlayer: true }, false)), /On: each player sees only what their own creatures see, by their senses and the light around them\./);
    const whole = render(table({ on: false, light: "dark" }));
    assert.doesNotMatch(whole, /data-vision-sight|Who sees for themselves/);
    assert.match(render(table({ on: true, light: "dark" })), /data-vision-sight/, "with vision on the row shows, Whole party chosen");
  });

  test("a change of the list on its way makes the row and the list busy, and leaves the switch alone", () => {
    const html = render(table({ on: true, light: "dark", perPlayer: true }), [{ op: { t: "vision.holders", sceneId: "s1", on: [] } }]);
    assert.equal((html.match(/aria-busy="true"/g) ?? []).length, 2, "the row and the list");
    assert.doesNotMatch(html, /role="switch"[^>]*aria-busy/);
  });
});

describe("What players see (docs/design-v1-map-discovery.md 8.1 and 8.4)", () => {
  const MAP = { assetId: "a", widthPx: 700, heightPx: 700, cellPx: 70, originPx: { x: 0, y: 0 } };
  const group = /<div role="radiogroup" aria-labelledby="[^"]+" aria-describedby="[^"]+"[^>]*>/;

  test("Players see heads the group, a radio group named by it and described by the chosen option's help", () => {
    const html = render(table({ on: true, light: "dark" }));
    assert.match(html, /<h3[^>]*>What players see<\/h3>/);
    assert.equal(named(html, group, "aria-labelledby"), "Players see");
    assert.match(named(html, group, "aria-describedby"), /^Players see what their characters see\./);
    assert.match(html, /<input type="radio"[^>]*checked=""[^>]*value="explore"/);
    assert.ok(html.indexOf("Players see") < html.indexOf("Light level"), "first, before the light");
    // Each option is named by its name alone.
    assert.match(html, /aria-labelledby="[^"]+"[^>]*>[^]*?>Reveal by hand</);
    assert.doesNotMatch(html, /Turn fog on/, "Explore turns fog on now");
    assert.doesNotMatch(html, /role="switch"/, "the fold of the two switches starts closed");
    assert.match(html, /<button type="button" aria-expanded="false"[^>]*>.*?Fog and party vision/);
    assert.match(html, />Use these settings on other scenes…</);
  });

  test("fog off with party vision on is Custom: nothing chosen, its line describing the group, and the fold open on both switches", () => {
    const html = render(table({ on: true, light: "dark" }, false));
    assert.doesNotMatch(html, /<input type="radio"[^>]*checked=""[^>]*value="(explore|reveal|all)"/);
    assert.equal(named(html, group, "aria-describedby"), "Custom: party vision is on and fog is off, so players see the whole map, dimmed outside what their characters see.");
    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /role="switch" aria-checked="false"[^>]*>[^]*?>Fog</);
    assert.match(html, /role="switch" aria-checked="true"[^>]*>[^]*?>Party vision</);
    assert.ok(html.indexOf(">Fog<") > html.indexOf("Fog and party vision"), "the Fog switch sits in the fold, moved from This scene");
  });

  test("Explore on a map image with nothing that blocks sight warns, and a wall on it ends the warning", () => {
    const view = table({ on: true, light: "dark" });
    view.scenes.s1 = { ...view.scenes.s1!, map: MAP };
    const warning = /This map has no walls yet, so party vision shows players all of it at once\. Add walls first, or choose Reveal by hand\./;
    assert.match(render(view), warning);
    // Collections are replaced, never changed in place, as the store does, since the walls are cached by them.
    view.buildChunks = { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: { "3,4,w": { kind: "wall" } } } };
    assert.doesNotMatch(render(view), warning);
    // A window blocks no sight, and Reveal by hand is never warned.
    view.buildChunks = { "s1:0,0": { sceneId: "s1", cx: 0, cy: 0, rev: 1, cells: {}, edges: { "3,4,w": { kind: "window" } } } };
    assert.match(render(view), warning);
    view.scenes.s1 = { ...view.scenes.s1!, vision: { on: false, light: "dark" } };
    assert.doesNotMatch(render(view), warning);
  });

  test("a Players see change on its way makes the group busy", () => {
    const html = render(table({ on: true, light: "dark" }), [{ op: { t: "scene.update", sceneId: "s1", patch: { fogEnabled: true, vision: { on: false, light: "dark" } } } }]);
    assert.match(html, /<div role="radiogroup"[^>]*aria-busy="true"/);
  });
});
