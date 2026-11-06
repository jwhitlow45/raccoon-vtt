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
 * weather shows, what rolls do as the rules switch's help, a line per rule
 * under it, and the words under them. The picks' rules are buildWeather.test.ts's.
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
const esc = (s: string | number) => String(s).replace(/[()]/g, "\\$&");

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
    assert.doesNotMatch(html, />Direction</);
    assert.match(text(html), /Strength/);
    assert.match(html, />Light</);
    assert.match(html, />Heavy</);
  });

  test("the compass names eight directions as radios, the chosen one checked, default toward the bottom right", () => {
    const html = render({ kind: "snow", wind: "moderate" });
    const names = [...html.matchAll(/<input type="radio"[^>]*aria-label="(Toward the [a-z ]+)"/g)].map((m) => m[1]);
    assert.deepEqual(names, ["Toward the top", "Toward the top right", "Toward the right", "Toward the bottom right", "Toward the bottom", "Toward the bottom left", "Toward the left", "Toward the top left"]);
    assert.match(html, /<input type="radio" aria-label="Toward the bottom right"[^>]*checked=""/);
    assert.match(text(html), / Direction Where it blows toward, by the map&#x27;s edges as Top-down shows them\. /, "the row is Direction, its help keeping the wind's toward");
    assert.doesNotMatch(html, /Blows toward/);
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

  test("a weather with a rule: the switch's help says what rolls here do in one sentence, then a line per weather part, kept with the switch off (docs/design/design-v1-polish-pass.md 3.2)", () => {
    const on = render({ kind: "rain", heavy: true, wind: "strong" });
    assert.match(on, /role="switch" aria-checked="true"/);
    assert.equal(named(on, /<button[^>]*role="switch"[^>]*>/, "aria-labelledby"), "Weather rules on rolls");
    assert.equal(
      named(on, /<button[^>]*role="switch"[^>]*>/, "aria-describedby"),
      "Perception checks and ranged weapon attacks here roll with Disadvantage. Other ranged attacks here get a reminder.",
    );
    const lines = [...on.matchAll(/<p style="([^"]*)"><span style="([^"]*)">([^<]*)<\/span> ([^<]*)<\/p>/g)].map((m) => ({ look: m[1]!, name: m[2]!, words: `${m[3]} ${m[4]}` }));
    assert.deepEqual(
      lines.map((l) => l.words),
      [
        "Heavy rain: Lightly Obscured, and Disadvantage on all Wisdom (Perception) checks. Puts out open flames.",
        "Strong wind: Disadvantage on ranged attack rolls with weapons. Puts out open flames, and a flying creature must land at the end of its turn or fall.",
      ],
    );
    const { theme } = themeModule;
    for (const l of lines) {
      assert.match(l.name, new RegExp(`font-weight:${theme.weight.strong};color:${esc(theme.color.text)}`), "the name in weight 600, in the text color");
      assert.match(l.look, new RegExp(`color:${esc(theme.color.textMuted)}`), "the line is Help");
    }
    // After the switch, outside its button, so the switch's description is the sentence alone.
    assert.ok(on.indexOf("Heavy rain:") > on.indexOf('role="switch"') && on.indexOf("Heavy rain:") > on.indexOf("</button>", on.indexOf('role="switch"')));
    assert.ok(on.indexOf("Strong wind:") < on.indexOf("Players see it at once"), "the lines before where devices decide");
    assert.equal((text(on).match(/Perception/g) ?? []).length, 2, "Perception said twice, once for rolls and once for the rule");
    const off = render({ kind: "rain", heavy: true, wind: "strong", rules: false });
    assert.match(off, /role="switch" aria-checked="false"/);
    assert.equal(named(off, /<button[^>]*role="switch"[^>]*>/, "aria-describedby"), "Rolls here ignore these rules.");
    assert.match(text(off), /Heavy rain: Lightly Obscured[\s\S]*Strong wind: Disadvantage on ranged attack rolls with weapons\./, "the lines stay");
  });

  test("heavy fog's line is a Note: its name in weight 600 in the warning tone, then its text and its advice. The switch says what it reminds", () => {
    const { theme } = themeModule;
    const fog = render({ kind: "fog", heavy: true });
    assert.equal(named(fog, /<button[^>]*role="switch"[^>]*>/, "aria-describedby"), "Perception checks and attacks here get a reminder.");
    assert.match(
      fog,
      new RegExp(
        `<p style="[^"]*color:${esc(theme.color.warning)}[^"]*"><span style="font-weight:${theme.weight.strong}">Heavy fog:</span> Heavily Obscured: a creature trying to see something in it has the Blinded condition\\. The map still shows what light and walls allow, so hide what the party could not see\\.</p>`,
      ),
    );
    const rain = render({ kind: "rain", heavy: true });
    assert.doesNotMatch(rain, new RegExp(`color:${esc(theme.color.warning)}`), "heavy rain only helps");
  });

  test("a look-only weather has no switch and says the rules stay as they are, then where devices decide", () => {
    const html = render({ kind: "leaves" });
    assert.doesNotMatch(html, /role="switch"/);
    assert.match(text(html), /A look only\. The rules stay as they are\. Players see it at once\. Each device can show it still or turn it off in This device\./);
  });
});
