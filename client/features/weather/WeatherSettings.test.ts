import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Scene } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { member, room, scene } from "#shared/testutil.ts";
import type { SceneWeather } from "#shared/weather.ts";

/*
 * The Weather fold as the scene settings draw it (docs/design/design-v1-weather.md
 * 4.1): its folded summary, its open state, the controls each weather shows
 * and the words under them. The picks' rules are buildWeather.test.ts's.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const themeModule = await import("../../lib/theme.ts");
const { SceneWeather, WeatherSettings, weatherSummary } = await import("./WeatherSettings.tsx");

function render(weather: SceneWeather | undefined, part: typeof WeatherSettings | typeof SceneWeather = WeatherSettings): string {
  const view: RoomState = room({ members: { dm1: member("dm1", "dm") } });
  view.scenes.s1 = scene("s1", weather ? { weather } : {});
  const store = createStore(() => ({ view, you: { memberId: "dm1", role: "dm" }, roomId: "r1", connection: "open", pending: [] as { op: ClientOp }[], local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1, newId: () => "x" } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(part, { scene: view.scenes.s1 as Scene }),
    }),
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the Weather fold", () => {
  test("folded on a clear scene, with Clear beside its label", () => {
    const html = render(undefined);
    assert.match(html, /<button type="button" aria-expanded="false"[^>]*>.*?Weather<\/button>/);
    assert.match(html, /Weather<\/button><\/h[34]><span[^>]*>Clear<\/span>/);
    assert.doesNotMatch(html, /Players see it at once/);
  });

  test("open on a scene with weather, its summary hidden", () => {
    const html = render({ kind: "rain", heavy: true, wind: "strong" });
    assert.match(html, /aria-expanded="true"/);
    assert.doesNotMatch(html, /Heavy rain · Strong wind<\/span>/);
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

  test("a weather with a rule shows the switch and the rules line, and the switch is off when rules are", () => {
    const on = render({ kind: "rain", heavy: true });
    assert.match(on, /role="switch" aria-checked="true"/);
    assert.match(text(on), /Weather rules on rolls/);
    assert.match(text(on), /Perception checks here roll with Disadvantage\./);
    const off = render({ kind: "rain", heavy: true, rules: false });
    assert.match(off, /role="switch" aria-checked="false"/);
    assert.match(text(off), /Rolls here ignore it\./);
  });

  test("heavy fog's line is a warning note, the rest are help", () => {
    const { theme } = themeModule;
    const lineOf = (html: string, words: RegExp) => new RegExp(`<p[^>]*style="([^"]*)"[^>]*>(?:(?!</p>).)*${words.source}`).exec(html)?.[1] ?? "";
    const fog = render({ kind: "fog", heavy: true });
    assert.match(text(fog), /Heavily Obscured: a creature trying to see something in it has the Blinded condition\./);
    assert.ok(lineOf(fog, /Heavily Obscured/).includes(`color:${theme.color.warning}`), "heavy fog warns");
    const rain = render({ kind: "rain", heavy: true });
    assert.ok(!lineOf(rain, /Lightly Obscured/).includes(`color:${theme.color.warning}`), "heavy rain only helps");
  });

  test("a look-only weather says the rules stay as they are, and every open fold ends with where devices decide", () => {
    const html = render({ kind: "leaves" });
    assert.doesNotMatch(html, /role="switch"/);
    assert.match(text(html), /A look only\. The rules stay as they are\./);
    assert.match(text(html), /Players see it at once\. Each device can show it still or turn it off in This device\./);
  });
});

describe("SceneWeather, the controls with no fold (docs/design/design-v1-panel-groups.md 4.1)", () => {
  test("it draws the controls with no disclosure of its own, on a clear scene and a scene with weather alike", () => {
    for (const weather of [undefined, { kind: "rain", heavy: true, wind: "strong" } as const]) {
      const html = render(weather, SceneWeather);
      assert.doesNotMatch(html, /aria-expanded/);
      assert.doesNotMatch(html, /<section/);
      assert.match(html, /<select[^>]*aria-label="Weather"|aria-label="Weather"[^>]*>/, "the kind's picker");
      assert.match(text(html), /Players see it at once\. Each device can show it still or turn it off in This device\./);
    }
  });

  test("the fold in What players see holds exactly SceneWeather's controls", () => {
    const weather = { kind: "snow", wind: "moderate", toward: 270 } as const;
    // Ids differ from one render to the next, so they are left out of the comparison.
    const noIds = (html: string) => html.replace(/ (id|name|aria-labelledby|aria-describedby)="[^"]*"/g, "");
    const folded = noIds(render(weather));
    const alone = noIds(render(weather, SceneWeather));
    const at = folded.indexOf(alone);
    assert.ok(at > 0, "the open fold holds SceneWeather as drawn alone");
    assert.match(folded.slice(0, at), /^<section[^>]*><div data-section-label=""[^>]*><h3[^>]*><button[^>]*>.*?<\/button><\/h3><\/div>$/, "under the fold's label and nothing else");
    assert.equal(folded.slice(at + alone.length), "</section>", "and nothing after it");
  });
});
