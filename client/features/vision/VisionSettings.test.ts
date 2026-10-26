import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Scene } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { member, room, scene } from "#shared/testutil.ts";

/*
 * The Vision settings' per-player parts as the DM's panel draws them
 * (docs/design-v1-per-player-vision.md 7.1 and 11): the Sight row under
 * the switch, named and described, who sees for themselves, and both busy
 * while their change is on its way.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { VisionSettings } = await import("./VisionSettings.tsx");

function table(vision: Scene["vision"]): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), ana: { ...member("ana"), name: "Ana" }, gus: { ...member("gus"), name: "Gus" } } });
  s.scenes.s1 = scene("s1", { fogEnabled: true, vision });
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

describe("the Vision settings on a per-player scene (7.1, 11)", () => {
  test("the Sight row shows with vision off, a radio group named Sight and described by Per player's help, then who sees for themselves", () => {
    const html = render(table({ on: false, light: "dark", perPlayer: true }));
    assert.equal(named(html, /<div role="radiogroup"[^>]*>/, "aria-labelledby"), "Sight");
    assert.match(named(html, /<div role="radiogroup"[^>]*>/, "aria-describedby"), /^Each player sees only what their own creatures see/);
    assert.equal(named(html, /<div role="group"[^>]*aria-describedby[^>]*>/, "aria-labelledby"), "Who sees for themselves");
    assert.equal(named(html, /<div role="group"[^>]*aria-describedby[^>]*>/, "aria-describedby"), "Players not ticked, and the table display, see only what creatures that share sight with the party see.");
    assert.match(html, /Gus sees only what creatures that share sight see here\./);
    assert.doesNotMatch(html, /Ana sees only/, "Ana's entry is on");
    assert.match(html, /<input type="radio"[^>]*checked=""[^>]*value="player"/);
    assert.ok(html.indexOf("data-vision-sight") > html.indexOf("Party vision"), "under the switch");
    assert.doesNotMatch(html, /aria-busy/);
    // Each row's question speaks through a status mounted before it has words (PV4-OP-5), so a screen reader hears them come.
    assert.equal((html.match(/<p role="status"[^>]*><\/p>/g) ?? []).length, 2, "Ana's row and Gus's");
  });

  test("the switch's help on a per-player scene, and no row on a whole-party scene with vision off", () => {
    assert.match(render(table({ on: true, light: "dark", perPlayer: true })), /On: each player sees only what their own creatures see, by their senses and the light around them\./);
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
