import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { RoomState, Scene } from "#shared/model.ts";
import type { Playing, Sound } from "#shared/sound.ts";
import { member, room, scene } from "#shared/testutil.ts";

/*
 * Scene sound, the scene's own preset in its settings
 * (docs/design/design-v1-scenes-reorg.md 5): the line for the scene it is
 * given, named from the room's library, and the four buttons the Sound
 * panel's line offered, each as the line draws it (sound/panel/panel.test.ts).
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { SceneSoundSettings } = await import("./SceneSoundSettings.tsx");

const sound = (id: string, use: Sound["use"], name: string): Sound => ({ id, rev: 1, name, assetId: `a-${id}`, ms: 31_000, use });
const PLAYING: Playing = { rev: 1, music: null, loops: { l1: { soundId: "drips", at: 0, volume: 70 } }, effects: [], volume: { music: 100, effects: 100 } };

function render(over: Partial<Scene>, playing: Playing | null = null, viewing = "s2"): string {
  const view: RoomState = room({ members: { dm1: member("dm1", "dm") } });
  view.scenes.s1 = scene("s1", { name: "Forest road" });
  view.scenes.s2 = scene("s2", { name: "Goblin cave", ...over });
  view.sounds = { night: sound("night", "music", "Tavern night"), drips: sound("drips", "loop", "Cave drips") };
  if (playing) view.playing = playing;
  // The DM's screen shows Forest road: the group is for the scene it is given, never the one on screen.
  const store = createStore(() => ({ view, you: { memberId: "dm1", role: "dm" }, roomId: "r1", sceneId: "s1", connection: "open", pending: [], local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1, newId: () => "x" } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(SceneSoundSettings, { scene: view.scenes[viewing]! }),
    }),
  );
}

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(?:<[^>]+>)*([^<]+)</g)].map((m) => m[1]);

describe("Scene sound in the scene's settings", () => {
  test("no sound of its own: the line for the scene given, Use what's playing and Use silence, then when it plays", () => {
    const html = render({});
    assert.match(html, /Goblin cave has no sound of its own\./);
    assert.doesNotMatch(html, /Forest road/);
    assert.deepEqual(buttons(html), ["Use what&#x27;s playing", "Use silence"]);
    assert.match(html, /It plays when you move the players to this scene\./);
  });

  test("nothing playing: Use what's playing is off and says why, and with something playing it is on", () => {
    assert.match(render({}), /<button[^>]*disabled=""[^>]*>Use what&#x27;s playing/);
    assert.match(render({}), />Play something first\.</);
    const on = render({}, PLAYING);
    assert.doesNotMatch(on, /<button[^>]*disabled=""[^>]*>Use what&#x27;s playing/);
    assert.doesNotMatch(on, /Play something first/);
  });

  test("a sound of its own names its music and background sounds from the library, with Play it and Clear", () => {
    const html = render({ sound: { music: { soundId: "night", repeat: "all", fade: 2 }, loops: [{ soundId: "drips", volume: 80 }] } });
    assert.match(html, /Goblin cave&#x27;s sound: Tavern night, Cave drips\./);
    assert.deepEqual(buttons(html), ["Play it", "Use what&#x27;s playing", "Use silence", "Clear"]);
  });

  test("silence kept: the scene is silent, with Play it and Clear", () => {
    const html = render({ sound: { music: null, loops: [] } });
    assert.match(html, /Goblin cave is silent\./);
    assert.deepEqual(buttons(html), ["Play it", "Use what&#x27;s playing", "Use silence", "Clear"]);
  });

  test("its help ids are its own, so a second line on the page shares none", () => {
    const ids = [...render({}).matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(ids.every((id) => !id!.startsWith("sound-scene-")), "never the id Ambiance's Sound uses for the scene");
  });
});
