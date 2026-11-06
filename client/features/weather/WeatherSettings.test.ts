import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Scene } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { member, room, scene } from "#shared/testutil.ts";
import type { SceneWeather } from "#shared/weather.ts";

/*
 * A scene's weather rows as Light and weather draws them, with no fold of
 * their own (docs/design/design-v1-scenes-reorg.md 4.1): the controls each
 * weather shows, the rules as the rules switch's help, and the words under
 * them. The picks' rules are buildWeather.test.ts's.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const themeModule = await import("../../lib/theme.ts");
const { SceneWeather, weatherSummary } = await import("./WeatherSettings.tsx");

function render(weather: SceneWeather | undefined): string {
  const view: RoomState = room({ members: { dm1: member("dm1", "dm") } });
  view.scenes.s1 = scene("s1", weather ? { weather } : {});
  const store = createStore(() => ({ view, you: { memberId: "dm1", role: "dm" }, roomId: "r1", connection: "open", pending: [] as { op: ClientOp }[], local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1, newId: () => "x" } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(SceneWeather, { scene: view.scenes.s1 as Scene }),
    }),
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/** The text of the element whose id an attribute of the element matching `at` names. */
function named(html: string, at: RegExp, attr: "aria-labelledby" | "aria-describedby"): string {
  const tag = html.match(at)?.[0] ?? "";
  const id = new RegExp(`${attr}="([^"]+)"`).exec(tag)?.[1];
  assert.ok(id, `${at} has ${attr}`);
  const open = html.indexOf(`id="${id}"`);
  const start = html.indexOf(">", open) + 1;
  // A warning's words sit in a span of their own inside the help, so the text runs to the first span that ends.
  return html.slice(start, html.indexOf("</span>", start)).replace(/<[^>]+>/g, "");
}

describe("the scene's weather rows", () => {
  test("no fold of their own, on a clear scene and a scene with weather alike: the kind's picker first, where devices decide last", () => {
    for (const weather of [undefined, { kind: "rain", heavy: true, wind: "strong" } as const]) {
      const html = render(weather);
      assert.doesNotMatch(html, /aria-expanded/);
      assert.doesNotMatch(html, /<section/);
      assert.match(html, /^<div[^>]*><div data-setting-row=""[^>]*>(?:(?!<\/div>)[\s\S])*?Weather/, "the Weather row first");
      assert.match(html, /<select[^>]*aria-label="Weather"/, "the kind's picker");
      assert.match(text(html), /Players see it at once\. Each device can show it still or turn it off in This device\. $/, "the devices line last");
    }
  });

  test("the summary names the kind and the wind", () => {
    assert.equal(weatherSummary(undefined), "Clear");
    assert.equal(weatherSummary({ kind: "rain", heavy: true, wind: "strong" }), "Heavy rain · Strong wind");
    assert.equal(weatherSummary({ kind: "clear", wind: "strong" }), "Strong wind");
    assert.equal(weatherSummary({ kind: "sand", heavy: true, wind: "strong" }), "Sandstorm · Strong wind");
  });

  test("Clear with a wind shows Wind and the compass but no Strength", () => {
    const html = render({ kind: "clear", wind: "moderate" });
    assert.match(text(html), /Wind/);
    assert.doesNotMatch(text(html), /Strength/);
    assert.match(html, /aria-label="Wind blows toward"/);
    assert.doesNotMatch(html, /role="switch"/, "Moderate wind has no rule, so no switch");
  });

  test("calm has no compass", () => {
    const html = render({ kind: "rain" });
    assert.doesNotMatch(html, /Wind blows toward/);
    assert.match(text(html), /Strength/);
    assert.match(html, />Light</);
    assert.match(html, />Heavy</);
  });

  test("the compass names eight directions as radios, the chosen one checked, default toward the bottom right", () => {
    const html = render({ kind: "snow", wind: "moderate" });
    const names = [...html.matchAll(/<input type="radio"[^>]*aria-label="(Toward the [a-z ]+)"/g)].map((m) => m[1]);
    assert.deepEqual(names, ["Toward the top", "Toward the top right", "Toward the right", "Toward the bottom right", "Toward the bottom", "Toward the bottom left", "Toward the left", "Toward the top left"]);
    assert.match(html, /<input type="radio" aria-label="Toward the bottom right"[^>]*checked=""/);
    assert.match(html, /The map&#x27;s edges as Top-down shows them\./);
    const west = render({ kind: "snow", wind: "moderate", toward: 270 });
    assert.match(west, /<input type="radio" aria-label="Toward the left"[^>]*checked=""/);
  });

  test("fog disables Strong and says why, a sandstorm disables Calm and Moderate", () => {
    const fog = render({ kind: "fog", wind: "moderate" });
    assert.match(fog, /Strong wind disperses fog\./);
    assert.match(fog, /<input type="radio" disabled=""[^>]*value="strong"/);
    const storm = render({ kind: "sand", heavy: true, wind: "strong" });
    assert.match(storm, /A sandstorm is a strong wind\./);
    assert.match(storm, /<input type="radio" disabled=""[^>]*value="calm"/);
    assert.match(storm, /<input type="radio" disabled=""[^>]*value="moderate"/);
    assert.doesNotMatch(storm, /<input type="radio" disabled=""[^>]*value="strong"/);
    assert.match(storm, />Sandstorm</);
  });

  test("a weather with a rule shows one rules row: the switch, its help the rules, ending Rolls here ignore it. when off, with no line beside it (D-261102-863)", () => {
    const on = render({ kind: "rain", heavy: true });
    assert.match(on, /role="switch" aria-checked="true"/);
    assert.equal(named(on, /<button[^>]*role="switch"[^>]*>/, "aria-labelledby"), "Weather rules on rolls");
    assert.match(named(on, /<button[^>]*role="switch"[^>]*>/, "aria-describedby"), /Perception checks here roll with Disadvantage\./);
    assert.equal((text(on).match(/Perception checks here roll with Disadvantage\./g) ?? []).length, 1, "the rules said once, as the switch's help");
    assert.doesNotMatch(on, /Rolls in this scene follow the rules below/, "the old help, which said what the rules line says, goes");
    const off = render({ kind: "rain", heavy: true, rules: false });
    assert.match(off, /role="switch" aria-checked="false"/);
    assert.match(named(off, /<button[^>]*role="switch"[^>]*>/, "aria-describedby"), /Rolls here ignore it\.$/);
    assert.equal((text(off).match(/Rolls here ignore it\./g) ?? []).length, 1);
  });

  test("heavy fog's rules warn in the switch's help, the rest are help's muted words", () => {
    const { theme } = themeModule;
    const fog = render({ kind: "fog", heavy: true });
    assert.match(text(fog), /Heavily Obscured: a creature trying to see something in it has the Blinded condition\./);
    assert.match(fog, new RegExp(`<span style="color:${theme.color.warning.replace(/[()]/g, "\\$&")}">Heavily Obscured`), "heavy fog warns");
    const rain = render({ kind: "rain", heavy: true });
    assert.doesNotMatch(rain, new RegExp(`color:${theme.color.warning.replace(/[()]/g, "\\$&")}`), "heavy rain only helps");
  });

  test("a look-only weather has no switch and says the rules stay as they are, then where devices decide", () => {
    const html = render({ kind: "leaves" });
    assert.doesNotMatch(html, /role="switch"/);
    assert.match(text(html), /A look only\. The rules stay as they are\. Players see it at once\. Each device can show it still or turn it off in This device\./);
  });
});
